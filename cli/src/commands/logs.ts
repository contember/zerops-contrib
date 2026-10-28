import { parseDuration, type CommandSpec } from "../lib/spec.ts";
import {
  LogClient,
  formatLogLine,
  logLineFromEntry,
  logLineFromRow,
  FACILITY,
  SEVERITY,
  type LogLine,
} from "../lib/logs.ts";
import { usage } from "../lib/errors.ts";

export const logCommands: CommandSpec[] = [
  {
    path: ["logs"],
    summary: "Read or follow service logs.",
    description: `Reads the project's logs, filtered to one service. Output goes to stdout so it can be
piped; with --json each line is a complete JSON object, one per line (JSONL), which is the
easiest form to filter with jq.

History is read through the project's VictoriaLogs, so every filter, the time range included,
runs on the server over the whole retained history. --query takes LogsQL filters and pipes
(https://docs.victoriametrics.com/victorialogs/logsql/); the service, --type and the other
flags still apply on top of it. A row a pipe produced (e.g. \`| stats count()\`) is printed as
its JSON object.

--follow prints the history, then streams new entries through the older log API, which
filters only by service, container, --type and --severity.

Build logs live in the same stream, tagged to the app version that produced them. Pass --build
to read the most recent build, or --build --app-version <id> for a specific one — this is how
you diagnose a push that exited 8.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "follow", short: "f", type: "boolean", description: "Stream new entries until interrupted." },
      { name: "limit", type: "number", default: 100, description: "How many matching entries to print, newest ones." },
      { name: "build", type: "boolean", description: "Read build logs instead of runtime logs." },
      { name: "app-version", type: "string", placeholder: "<id>", description: "With --build, the app version to read. Defaults to the newest." },
      { name: "container", type: "string", placeholder: "<id>", description: "Restrict to one container." },
      { name: "since", type: "string", placeholder: "<duration>", description: "Only entries newer than this, e.g. 15m or 2h." },
      { name: "until", type: "string", placeholder: "<duration>", description: "Only entries older than this, e.g. 1h. Not with --follow." },
      { name: "grep", type: "string", placeholder: "<text>", description: "Only entries whose message contains this text. Not with --follow." },
      { name: "query", type: "string", placeholder: "<logsql>", description: "LogsQL filters and pipes. Not with --follow." },
      { name: "severity", type: "string", enum: Object.keys(SEVERITY), description: "Minimum severity to include." },
      { name: "type", type: "string", enum: ["APPLICATION", "WEBSERVER"], default: "APPLICATION", description: "APPLICATION is your process; WEBSERVER is the access log." },
      { name: "short", type: "boolean", description: "Print only the message, without timestamp and tag." },
    ],
    examples: [
      "zops logs api",
      "zops logs api --follow",
      "zops logs api --build",
      "zops logs api --since 15m --severity WARNING",
      "zops logs api --since 2d --until 1d --grep 'connection refused'",
      "zops logs api --since 1d --query '* | stats by (severity) count() lines'",
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
      const until = ctx.flag<string>("until");
      const start = since ? new Date(Date.now() - parseDuration(since)) : undefined;
      const facility = FACILITY[(ctx.flag<string>("type") ?? "APPLICATION") as keyof typeof FACILITY];
      const severity = ctx.flag<string>("severity");
      const minimumSeverity = severity ? SEVERITY[severity] : undefined;
      const containerId = ctx.flag<string>("container");

      const print = (line: LogLine) => {
        if (ctx.out.json) {
          // JSONL: one object per line, so a follower can be consumed incrementally.
          process.stdout.write(`${JSON.stringify(line)}\n`);
        } else {
          process.stdout.write(`${formatLogLine(line, { short: ctx.bool("short") })}\n`);
        }
      };

      const follow = ctx.bool("follow");
      if (follow) {
        for (const name of ["until", "grep", "query"]) {
          if (ctx.flag<string>(name) !== undefined) {
            throw usage(
              `--${name} cannot be combined with --follow`,
              "The live stream filters only by service, container, --type and --severity.",
            );
          }
        }
      }

      const client = await LogClient.forProject(ctx, projectId);
      const rows = await client.search({
        serviceStackId,
        tags,
        containerId,
        facility,
        minimumSeverity,
        start,
        end: until ? new Date(Date.now() - parseDuration(until)) : undefined,
        grep: ctx.flag<string>("grep"),
        query: ctx.flag<string>("query"),
        limit,
      });
      const history: LogLine[] = [];
      for (const row of rows) {
        const line = logLineFromRow(row);
        if (line) {
          history.push(line);
          print(line);
        } else {
          process.stdout.write(`${JSON.stringify(row)}\n`);
        }
      }

      if (!follow) return;

      const abort = new AbortController();
      const stop = () => abort.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const query = { serviceStackId, tags, containerId, facility, minimumSeverity };
      try {
        for await (const entry of client.follow(query, abort.signal, history)) {
          // With no history to anchor on, the stream's replay still has to respect --since.
          if (start && new Date(entry.timestamp) < start) continue;
          print(logLineFromEntry(entry));
        }
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  },
];
