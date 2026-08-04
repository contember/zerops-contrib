import type { CommandSpec } from "../lib/spec.ts";
import { LogClient, formatLogLine, FACILITY, SEVERITY, type LogEntry } from "../lib/logs.ts";
import { usage } from "../lib/errors.ts";

export const logCommands: CommandSpec[] = [
  {
    path: ["logs"],
    summary: "Read or follow service logs.",
    description: `Reads the project log stream, filtered to one service. Output goes to stdout so it can be
piped; with --json each line is a complete JSON object, one per line (JSONL), which is the
easiest form to filter with jq.

Build logs live in the same stream, tagged to the app version that produced them. Pass --build
to read the most recent build, or --build --app-version <id> for a specific one — this is how
you diagnose a push that exited 8.

The platform filters logs within a scan window over the project's combined stream rather than
per service, so --limit (how many lines you want) and --scan (how far back the server looks)
are separate. The scan widens automatically for build logs and for --since; raise it by hand if
a quiet service in a noisy project comes back empty.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "follow", short: "f", type: "boolean", description: "Stream new entries until interrupted." },
      { name: "limit", type: "number", default: 100, description: "How many matching entries to print." },
      { name: "scan", type: "number", placeholder: "<n>", description: "How many recent project-wide entries the server searches. Defaults to 500, or 5000 when filtering build logs." },
      { name: "build", type: "boolean", description: "Read build logs instead of runtime logs." },
      { name: "app-version", type: "string", placeholder: "<id>", description: "With --build, the app version to read. Defaults to the newest." },
      { name: "container", type: "string", placeholder: "<id>", description: "Restrict to one container." },
      { name: "since", type: "string", placeholder: "<duration>", description: "Only entries newer than this, e.g. 15m or 2h." },
      { name: "severity", type: "string", enum: Object.keys(SEVERITY), description: "Minimum severity to include." },
      { name: "type", type: "string", enum: ["APPLICATION", "WEBSERVER"], default: "APPLICATION", description: "APPLICATION is your process; WEBSERVER is the access log." },
      { name: "short", type: "boolean", description: "Print only the message, without timestamp and tag." },
    ],
    examples: [
      "zops logs api",
      "zops logs api --follow",
      "zops logs api --build",
      "zops logs api --since 15m --severity WARNING",
      "zops logs api --json | jq -r 'select(.severity <= 3) | .message'",
    ],
    operations: ["GetProjectLog", "listServiceStackAppVersions"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const projectId = await ctx.projectId();
      const limit = ctx.flag<number>("limit") ?? 100;
      if (limit < 1) throw usage("--limit must be at least 1");

      let serviceStackId = service.id;
      let tags: string[] | undefined;

      if (ctx.bool("build")) {
        let appVersionId = ctx.flag<string>("app-version");
        let buildServiceId: string | undefined;

        const res = await ctx.api.call<{
          items?: { id: string; sequence: number; build?: { serviceStackId?: string | null } | null }[];
          list?: { id: string; sequence: number; build?: { serviceStackId?: string | null } | null }[];
        }>("listServiceStackAppVersions", { path: { id: service.id }, query: { limit: 50 } });
        const versions = res.items ?? res.list ?? [];

        const target = appVersionId ? versions.find((v) => v.id === appVersionId) : versions.find((v) => v.build);
        if (!target) {
          throw usage(
            appVersionId
              ? `app version ${appVersionId} not found on ${service.name}`
              : `no build found for ${service.name}`,
            "Run `zops version list` to see the deploy history.",
          );
        }
        appVersionId = target.id;
        buildServiceId = target.build?.serviceStackId ?? undefined;
        if (!buildServiceId) {
          throw usage(
            `app version #${target.sequence} has no build container (it was deployed, not built)`,
            "Only versions created by `zops push` have build logs.",
          );
        }
        serviceStackId = buildServiceId;
        tags = [`zbuilder@${appVersionId}`];
        ctx.out.info(`build logs for app version ${appVersionId}`);
      }

      const since = ctx.flag<string>("since");
      const cutoff = since ? Date.now() - (await import("../lib/spec.ts")).parseDuration(since) : null;

      // Build logs sit behind however much runtime chatter the project produced since, so they
      // need a far wider window than a plain tail does.
      const defaultScan = tags ? 5000 : since ? 2000 : Math.max(limit * 5, 500);

      const client = await LogClient.forProject(ctx, projectId);
      const query = {
        serviceStackId,
        tags,
        limit,
        scan: ctx.flag<number>("scan") ?? defaultScan,
        containerId: ctx.flag<string>("container"),
        facility: FACILITY[(ctx.flag<string>("type") ?? "APPLICATION") as keyof typeof FACILITY],
        minimumSeverity: ctx.flag<string>("severity") ? SEVERITY[ctx.flag<string>("severity")!] : undefined,
      };

      const emit = (entry: LogEntry) => {
        if (cutoff !== null && new Date(entry.timestamp).getTime() < cutoff) return;
        if (ctx.out.json) {
          // JSONL: one object per line, so a follower can be consumed incrementally.
          process.stdout.write(`${JSON.stringify(entry)}\n`);
        } else {
          process.stdout.write(`${formatLogLine(entry, { short: ctx.bool("short") })}\n`);
        }
      };

      const history = await client.fetch(query);
      for (const entry of history) emit(entry);

      if (!ctx.bool("follow")) return;

      const abort = new AbortController();
      const stop = () => abort.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const from = history.length > 0 ? history[history.length - 1]!.id : undefined;
      try {
        // History is already printed, so the stream only needs a small backlog window.
        for await (const entry of client.follow({ ...query, scan: 100, from }, abort.signal)) emit(entry);
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  },
];
