/**
 * App versions: deploy history and rollback.
 *
 * Rollback is not a distinct endpoint — it is `deployAppVersion` pointed at an older, archived
 * version. Naming the command `rollback` keeps that discoverable.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { notFound, usage } from "../lib/errors.ts";

interface AppVersionRow {
  id: string;
  sequence: number;
  name?: string | null;
  status: string;
  created: string;
  build?: { pipelineFinish?: string | null } | null;
}

const VERSION_COLUMNS = [
  { key: "sequence", header: "#" },
  { key: "id", header: "ID" },
  { key: "status", header: "STATUS" },
  { key: "name", header: "NAME" },
  { key: "created", header: "CREATED" },
];

async function listVersions(
  ctx: import("../lib/context.ts").Context,
  serviceId: string,
  limit: number,
): Promise<AppVersionRow[]> {
  const res = await ctx.api.call<{ items?: AppVersionRow[]; list?: AppVersionRow[] }>(
    "listServiceStackAppVersions",
    { path: { id: serviceId }, query: { limit } },
  );
  return res.items ?? res.list ?? [];
}

export const versionCommands: CommandSpec[] = [
  {
    path: ["version", "list"],
    summary: "List a service's app versions (its deploy history).",
    description: "The ACTIVE version is what is currently serving; BACKUP versions are the rollback targets.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "limit", type: "number", default: 20, description: "How many versions to return." },
      { name: "status", type: "string", placeholder: "<status>", description: "Filter by status, e.g. ACTIVE or BUILD_FAILED." },
    ],
    examples: ["zops version list api", "zops version list api --status BUILD_FAILED --json"],
    operations: ["listServiceStackAppVersions"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      let items = await listVersions(ctx, service.id, ctx.flag<number>("limit") ?? 20);
      const status = ctx.flag<string>("status");
      if (status) items = items.filter((v) => v.status === status.toUpperCase());
      ctx.out.data(items, { columns: VERSION_COLUMNS, quietField: "id", emptyMessage: "no app versions" });
    },
  },
  {
    path: ["version", "get"],
    summary: "Show one app version, including build and deploy state.",
    args: [{ name: "app-version-id", description: "App version id.", required: true }],
    operations: ["getAppVersion"],
    async run(ctx, parsed) {
      ctx.out.data(await ctx.api.call("getAppVersion", { path: { id: parsed.args[0]! } }));
    },
  },
  {
    path: ["version", "rollback"],
    summary: "Redeploy a previous app version.",
    description: `Activates an archived version by running the deploy phase against it. Nothing is rebuilt, so
this is fast and reproducible — the artifact is the one that was built at the time.

With no id, the most recent non-active version is used, which is the usual "undo the last
deploy" case.`,
    destructive: true,
    args: [
      { name: "service", description: "Service hostname or id. Defaults to --service." },
      { name: "app-version-id", description: "Version to activate. Defaults to the previous one." },
    ],
    flags: [{ name: "sequence", type: "number", placeholder: "<n>", description: "Select the target by sequence number instead of id." }],
    examples: [
      "zops version rollback api",
      "zops version rollback api --sequence 41 --yes",
      "zops version rollback api 3mKq8vNwQ1yTbXZs2LpAcd --yes",
    ],
    operations: ["listServiceStackAppVersions", "deployAppVersion"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const versions = await listVersions(ctx, service.id, 100);
      const sequence = ctx.flag<number>("sequence");

      let target: AppVersionRow | undefined;
      if (parsed.args[1]) {
        target = versions.find((v) => v.id === parsed.args[1]);
        if (!target) throw notFound(`app version ${parsed.args[1]} not found on ${service.name}`);
      } else if (sequence !== undefined) {
        target = versions.find((v) => v.sequence === sequence);
        if (!target) throw notFound(`no app version with sequence ${sequence} on ${service.name}`);
      } else {
        // Deploy history is newest-first; the first non-active entry is the previous deploy.
        target = versions.find((v) => v.status !== "ACTIVE" && v.status === "BACKUP");
        if (!target) {
          throw usage(
            `no previous version to roll back to on ${service.name}`,
            "Run `zops version list` to see the history.",
          );
        }
      }

      if (target.status === "ACTIVE") {
        throw usage(`app version #${target.sequence} is already active`);
      }

      await ctx.confirm(`roll ${service.name} back to app version #${target.sequence} (${target.id})`);
      if (ctx.dryRun) {
        return { dryRun: true, operation: "deployAppVersion", service: service.name, appVersionId: target.id, sequence: target.sequence };
      }

      const proc = await ctx.api.call<{ id: string }>("deployAppVersion", { path: { id: target.id }, body: {} });
      const result = await settleProcess(ctx, proc, `rolling ${service.name} back to #${target.sequence}`);
      ctx.out.data({ ...result, appVersionId: target.id, sequence: target.sequence });
    },
  },
  {
    path: ["version", "rename"],
    summary: "Give an app version a readable name.",
    description: `Deploy history is otherwise identified by sequence number and id. Naming the versions that
matter — a release tag, a known-good build — makes \`zops version rollback\` a decision rather
than a guess.`,
    args: [
      { name: "app-version-id", description: "App version id.", required: true },
      { name: "name", description: "Label to attach.", required: true },
    ],
    examples: ["zops version rename 3mKq8vNwQ1yTbXZs2LpAcd 'v1.4.0 — known good'"],
    operations: ["updateAppVersion"],
    async run(ctx, parsed) {
      const [id, name] = [parsed.args[0]!, parsed.args[1]!];
      if (ctx.dryRun) return { dryRun: true, operation: "updateAppVersion", appVersionId: id, name };
      await ctx.api.call("updateAppVersion", { path: { id }, body: { name } });
      ctx.out.step(`app version ${id} named "${name}"`);
      return { appVersionId: id, name };
    },
  },
  {
    path: ["version", "download-url"],
    summary: "Get a download URL for the code archive of an app version.",
    description: `Returns a time-limited link to exactly what was deployed. The way to answer "what is actually
running" when the repository has moved on, and to diff a working deploy against a broken one.

The URL is a credential — anyone with it can download the application code until it expires.`,
    args: [{ name: "app-version-id", description: "App version id.", required: true }],
    examples: [
      "zops version download-url 3mKq8vNwQ1yTbXZs2LpAcd -q",
      "curl -sL \"$(zops version download-url 3mKq... -q)\" -o deployed.tar.gz",
    ],
    operations: ["getAppVersionAppCode"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const res = await ctx.api.call<{ url?: string }>("getAppVersionAppCode", { path: { id } });
      ctx.out.warn("this URL grants access to the deployed application code until it expires");
      ctx.out.data({ appVersionId: id, url: res.url ?? null }, { quietField: "url" });
    },
  },
  {
    path: ["version", "cancel-build"],
    summary: "Cancel a running build.",
    destructive: true,
    args: [{ name: "app-version-id", description: "App version whose build should stop.", required: true }],
    operations: ["cancelAppVersionBuild"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      await ctx.confirm(`cancel the build of app version ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "cancelAppVersionBuild", appVersionId: id };
      const proc = await ctx.api.call<{ id: string }>("cancelAppVersionBuild", { path: { id } });
      ctx.out.data(await settleProcess(ctx, proc, `cancelling build ${id}`));
    },
  },
  {
    path: ["version", "delete"],
    summary: "Delete an archived app version.",
    destructive: true,
    args: [{ name: "app-version-id", description: "App version id.", required: true }],
    operations: ["deleteAppVersion"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      await ctx.confirm(`delete app version ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "deleteAppVersion", appVersionId: id };
      const proc = await ctx.api.call<{ id: string }>("deleteAppVersion", { path: { id } });
      ctx.out.data(await settleProcess(ctx, proc, `deleting app version ${id}`));
    },
  },
];
