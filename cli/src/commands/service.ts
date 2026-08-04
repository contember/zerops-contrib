import { readFile } from "node:fs/promises";
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import type { ServiceSummary } from "../lib/context.ts";

const SERVICE_COLUMNS = [
  { key: "name", header: "NAME" },
  { key: "id", header: "ID" },
  { key: "status", header: "STATUS" },
  {
    key: "type",
    header: "TYPE",
    get: (row: ServiceSummary) =>
      row.serviceStackTypeInfo?.serviceStackTypeVersionName ?? row.serviceStackTypeVersionId ?? "-",
  },
  {
    key: "containers",
    header: "CONTAINERS",
    get: (row: ServiceSummary) => {
      const h = (row.currentAutoscaling as { horizontalAutoscaling?: { minContainerCount?: number; maxContainerCount?: number } } | undefined)
        ?.horizontalAutoscaling;
      if (!h?.minContainerCount && !h?.maxContainerCount) return "-";
      return h.minContainerCount === h.maxContainerCount ? String(h.minContainerCount) : `${h.minContainerCount}-${h.maxContainerCount}`;
    },
  },
];

/** Every lifecycle verb has the same shape: resolve the service, fire, optionally wait. */
function lifecycle(
  verb: string,
  operation: string,
  options: { destructive?: boolean; summary: string; description?: string } ,
): CommandSpec {
  return {
    path: ["service", verb],
    summary: options.summary,
    description: options.description,
    destructive: options.destructive,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: [`zz service ${verb} api`, `zz service ${verb} api --no-wait`],
    operations: [operation],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      if (options.destructive) await ctx.confirm(`${verb} service ${service.name}`);
      if (ctx.dryRun) return { dryRun: true, operation, serviceId: service.id, service: service.name };
      const proc = await ctx.api.call<{ id: string }>(operation, { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, proc, `${verb}ing ${service.name}`));
    },
  };
}

export const serviceCommands: CommandSpec[] = [
  {
    path: ["service", "list"],
    summary: "List services in the project.",
    flags: [
      { name: "status", type: "string", placeholder: "<status>", description: "Only services with this status, e.g. ACTIVE." },
      { name: "type", type: "string", placeholder: "<substring>", description: "Only services whose type contains this substring, e.g. postgres." },
    ],
    examples: ["zz service list", "zz service list --status ACTIVE --json", "zz service list -q"],
    operations: ["ListProjectServiceStacks"],
    async run(ctx) {
      let items = await ctx.listServices();
      const status = ctx.flag<string>("status");
      const type = ctx.flag<string>("type");
      if (status) items = items.filter((s) => s.status === status.toUpperCase());
      if (type) {
        const needle = type.toLowerCase();
        items = items.filter((s) =>
          `${s.serviceStackTypeInfo?.serviceStackTypeVersionName ?? ""} ${s.serviceStackTypeVersionId ?? ""}`
            .toLowerCase()
            .includes(needle),
        );
      }
      ctx.out.data(items, { columns: SERVICE_COLUMNS, emptyMessage: "no services" });
    },
  },
  {
    path: ["service", "get"],
    summary: "Show one service in detail.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["GetServiceStack"],
    async run(ctx, parsed) {
      ctx.out.data(await ctx.service(parsed.args[0]));
    },
  },
  {
    path: ["service", "create"],
    summary: "Create a single service without writing an import YAML.",
    description: `The one-service shortcut past \`zz project service-import\`. For anything with cross-service
references, generated secrets or several services at once, write the YAML instead — the
\`<@generateRandomString(…)>\` expansion and \`\${service_VAR}\` references only exist there.

--type takes a full version string from \`zz catalog\`, e.g. postgresql:ha@18 or nodejs@22.
Runtime services start empty; give them code with \`zz push\`, \`--from-git\`, or
--start-without-code for a container you will fill over SSH.`,
    args: [{ name: "name", description: "Service hostname. Lowercase letters and digits only.", required: true }],
    flags: [
      { name: "type", type: "string", required: true, placeholder: "<type@version>", description: "Service type and version, exactly as `zz catalog` prints it." },
      { name: "from-git", type: "string", placeholder: "<url>", description: "Build immediately from this Git URL." },
      { name: "start-without-code", type: "boolean", description: "Bring a runtime service up with no application code." },
      { name: "subdomain", type: "boolean", description: "Enable the generated .zerops.app subdomain." },
      { name: "min-containers", type: "number", placeholder: "<n>", description: "Minimum container count." },
      { name: "max-containers", type: "number", placeholder: "<n>", description: "Maximum container count." },
      { name: "env-file", type: "string", placeholder: "<path>", description: "Seed the service's variables from a .env file." },
      { name: "zerops-yaml", type: "string", placeholder: "<path>", description: "Build configuration to use instead of the repository's zerops.yaml." },
      { name: "setup", type: "string", placeholder: "<name>", description: "zerops.yaml setup: block to use. Defaults to the service name." },
    ],
    examples: [
      "zz service create db --type postgresql:ha@18",
      "zz service create api --type nodejs@22 --from-git https://github.com/acme/api@main --subdomain",
      "zz service create worker --type ubuntu@24.04 --start-without-code",
    ],
    operations: ["CreateServiceStack"],
    async run(ctx, parsed) {
      const name = parsed.args[0]!;
      const projectId = await ctx.projectId();
      const envFile = ctx.flag<string>("env-file");
      const zeropsYaml = ctx.flag<string>("zerops-yaml");

      const min = ctx.flag<number>("min-containers");
      const max = ctx.flag<number>("max-containers");

      const body: Record<string, unknown> = {
        name,
        serviceStackVersionName: ctx.flag<string>("type")!,
      };
      if (ctx.flag<string>("from-git")) body.buildFromGit = ctx.flag<string>("from-git");
      if (ctx.bool("start-without-code")) body.startWithoutCode = true;
      if (ctx.flags.subdomain !== undefined) body.enableSubdomainAccess = ctx.bool("subdomain");
      if (ctx.flag<string>("setup")) body.zeropsSetup = ctx.flag<string>("setup");
      if (zeropsYaml) body.zeropsYaml = await readFile(zeropsYaml, "utf8");
      if (envFile) body.userDataEnvFile = await readFile(envFile, "utf8");
      if (min !== undefined || max !== undefined) {
        body.customAutoscaling = {
          horizontalAutoscaling: { minContainerCount: min ?? null, maxContainerCount: max ?? null },
        };
      }

      if (ctx.dryRun) return { dryRun: true, operation: "CreateServiceStack", projectId, body };
      const created = await ctx.api.call<{ id: string; name: string; process?: { id: string } | null }>(
        "CreateServiceStack",
        { path: { id: projectId }, body },
      );
      ctx.out.step(`service ${created.name} created (${created.id})`);
      const settled = await settleProcess(ctx, created, `provisioning ${created.name}`);
      ctx.out.data({ ...settled, serviceId: created.id, service: created.name });
    },
  },
  lifecycle("start", "StartServiceStack", { summary: "Start a stopped service." }),
  lifecycle("stop", "StopServiceStack", { summary: "Stop a running service.", destructive: true }),
  lifecycle("restart", "RestartServiceStack", {
    summary: "Restart a service.",
    description: `A restart recreates the containers, so environment variable changes take effect. This is a
first-class API operation — it does not require a stop/start pair.`,
  }),
  lifecycle("reload", "ReloadServiceStack", {
    summary: "Reload a service without recreating its containers.",
    description: `Signals the running process to reload its configuration. Note that a reload does NOT re-read
environment variables — use \`zz service restart\` for that.`,
  }),
  {
    path: ["service", "delete"],
    summary: "Delete a service and its data.",
    destructive: true,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["DeleteServiceStack"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      await ctx.confirm(`permanently delete service ${service.name} (${service.id}) and its data`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteServiceStack", serviceId: service.id };
      const proc = await ctx.api.call<{ id: string }>("DeleteServiceStack", { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, proc, `deleting ${service.name}`));
    },
  },
  {
    path: ["service", "enable-subdomain"],
    summary: "Enable the generated .zerops.app subdomain.",
    description: "Intended for development and testing. Production traffic should use a domain via `zz route http`.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["EnableSubdomainAccess"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      if (ctx.dryRun) return { dryRun: true, operation: "EnableSubdomainAccess", serviceId: service.id };
      const proc = await ctx.api.call<{ id: string }>("EnableSubdomainAccess", { path: { id: service.id } });
      const result = await settleProcess(ctx, proc, `enabling subdomain for ${service.name}`);
      const fresh = await ctx.api.call<{ subdomainAccessUrl?: string }>("GetServiceStack", { path: { id: service.id } });
      ctx.out.data({ ...result, url: fresh.subdomainAccessUrl ?? null });
    },
  },
  {
    path: ["service", "disable-subdomain"],
    summary: "Disable the generated .zerops.app subdomain.",
    destructive: true,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["DisableSubdomainAccess"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      await ctx.confirm(`disable the public subdomain for ${service.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DisableSubdomainAccess", serviceId: service.id };
      const proc = await ctx.api.call<{ id: string }>("DisableSubdomainAccess", { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, proc, `disabling subdomain for ${service.name}`));
    },
  },
  {
    path: ["service", "export"],
    summary: "Export a service as import YAML.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz service export api > api.yaml"],
    operations: ["ExportServiceStack"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await ctx.api.call<{ yaml?: string }>("ExportServiceStack", { path: { id: service.id } });
      if (ctx.out.json) {
        ctx.out.data(res);
        return;
      }
      ctx.out.raw(res.yaml ?? "");
    },
  },
  {
    path: ["service", "containers"],
    summary: "List the running containers of a service.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz service containers api --json"],
    operations: ["ListServiceStackContainers"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await ctx.api.call<{ items?: Record<string, unknown>[]; list?: Record<string, unknown>[] }>(
        "ListServiceStackContainers",
        { path: { id: service.id } },
      );
      const items = res.items ?? res.list ?? [];
      ctx.out.data(items, {
        columns: [
          { key: "id", header: "ID" },
          { key: "status", header: "STATUS" },
          { key: "hostname", header: "HOSTNAME" },
          { key: "privateIpAddress", header: "IP" },
        ],
        quietField: "id",
        emptyMessage: "no containers",
      });
    },
  },
  {
    path: ["service", "shared-storage", "connect"],
    summary: "Mount a shared-storage service into a service.",
    description: `Shared storage is a separate service type that several runtime services can mount at once,
which is how you keep uploads off a container's ephemeral disk. The mount appears once the
service restarts as part of this operation.`,
    args: [
      { name: "storage", description: "Shared-storage service hostname or id.", required: true },
      { name: "service", description: "Service that should mount it. Defaults to --service." },
    ],
    examples: ["zz service shared-storage connect uploads api"],
    operations: ["ConnectSharedStorage"],
    async run(ctx, parsed) {
      const storage = await ctx.service(parsed.args[0]!);
      const service = await ctx.service(parsed.args[1]);
      const body = { sharedStorageId: storage.id };
      if (ctx.dryRun) return { dryRun: true, operation: "ConnectSharedStorage", service: service.name, body };
      const res = await ctx.api.call("ConnectSharedStorage", { path: { id: service.id }, body });
      ctx.out.data(await settleProcess(ctx, res, `mounting ${storage.name} into ${service.name}`));
    },
  },
  {
    path: ["service", "shared-storage", "disconnect"],
    summary: "Unmount a shared-storage service from a service.",
    description: "The storage service and its contents survive; only this service's mount goes away.",
    destructive: true,
    args: [
      { name: "storage", description: "Shared-storage service hostname or id.", required: true },
      { name: "service", description: "Service that currently mounts it. Defaults to --service." },
    ],
    operations: ["DisconnectSharedStorage"],
    async run(ctx, parsed) {
      const storage = await ctx.service(parsed.args[0]!);
      const service = await ctx.service(parsed.args[1]);
      await ctx.confirm(`unmount ${storage.name} from ${service.name}`);
      const body = { sharedStorageId: storage.id };
      if (ctx.dryRun) return { dryRun: true, operation: "DisconnectSharedStorage", service: service.name, body };
      const res = await ctx.api.call("DisconnectSharedStorage", { path: { id: service.id }, body });
      ctx.out.data(await settleProcess(ctx, res, `unmounting ${storage.name} from ${service.name}`));
    },
  },
  {
    path: ["service", "debug"],
    summary: "Pause a build or runtime-prepare phase so the container can be inspected over SSH.",
    description: `Holds the pipeline at the chosen point and leaves the container alive, which is the only way
to see the filesystem a failing build actually had.

  BEFORE   pause before the phase runs
  ON_FAIL  pause only if the phase fails — the usual choice
  AFTER    pause once the phase succeeds
  NONE     no pause

Both phases are sent on every call: a flag you omit is set to NONE. The API offers no way to
read the current setting back, so pass both when you want both.

A paused container is billed while it waits. Reset with \`zz service debug --build NONE\`.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "build", type: "string", enum: ["NONE", "BEFORE", "ON_FAIL", "AFTER"], default: "NONE", description: "When to pause the build phase." },
      { name: "runtime-prepare", type: "string", enum: ["NONE", "BEFORE", "ON_FAIL", "AFTER"], default: "NONE", description: "When to pause the runtime-prepare phase." },
    ],
    examples: [
      "zz service debug api --build ON_FAIL",
      "zz service debug api --build NONE --runtime-prepare NONE   # reset",
    ],
    operations: ["ConfigureDebug"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const body = {
        debugBuild: ctx.flag<string>("build") ?? "NONE",
        debugRuntimePrepare: ctx.flag<string>("runtime-prepare") ?? "NONE",
      };
      if (ctx.dryRun) return { dryRun: true, operation: "ConfigureDebug", service: service.name, body };
      const res = await ctx.api.call<Record<string, unknown>>("ConfigureDebug", {
        path: { id: service.id },
        body,
      });
      ctx.out.step(`debug set on ${service.name}: build=${body.debugBuild}, runtimePrepare=${body.debugRuntimePrepare}`);
      ctx.out.data({ service: service.name, ...res });
    },
  },
  {
    path: ["service", "nginx-config"],
    summary: "Print the nginx configuration of a static service.",
    description: "Only static (nginx) services have one. Useful for checking what the platform generated before overriding it in zerops.yaml.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz service nginx-config web"],
    operations: ["GetNginxConfFile"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await ctx.api.call<{ defaultSite?: string }>("GetNginxConfFile", { path: { id: service.id } });
      if (ctx.out.json) {
        ctx.out.data(res);
        return;
      }
      ctx.out.raw(res.defaultSite ?? "");
    },
  },
  {
    path: ["service", "file-browser"],
    summary: "Mint a temporary token for browsing a service's files over HTTP.",
    description: `Returns the short-lived URLs the GUI's file browser uses, so a container's filesystem can be
listed and read without a VPN or an SSH session.

The token expires; re-run to get a fresh one. Treat the output as a credential — anyone holding
it can read the service's files until it expires.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz service file-browser api --json"],
    operations: ["CreateFileBrowsingAccess"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      if (ctx.dryRun) return { dryRun: true, operation: "CreateFileBrowsingAccess", service: service.name };
      const res = await ctx.api.call<Record<string, unknown>>("CreateFileBrowsingAccess", {
        path: { id: service.id },
      });
      ctx.out.warn("the returned token grants read access to this service's files until it expires");
      ctx.out.data({ service: service.name, ...res });
    },
  },
  {
    path: ["service", "components"],
    summary: "List the platform-level components backing a service.",
    description: `A service is assembled from internal components — the database engine, its access point, the
sidecars. This is what the platform tracks for each, including their status and target
container count. \`zz service containers\` is the more useful view for day-to-day work.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [{ name: "limit", type: "number", default: 100, description: "How many components to return." }],
    operations: ["ListServiceStackServices"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await ctx.api.call<{ list?: Record<string, unknown>[]; items?: Record<string, unknown>[] }>(
        "ListServiceStackServices",
        { path: { id: service.id }, query: { limit: ctx.flag<number>("limit") ?? 100 } },
      );
      ctx.out.data(res.list ?? res.items ?? [], {
        columns: [
          { key: "name", header: "NAME" },
          { key: "category", header: "CATEGORY" },
          { key: "status", header: "STATUS" },
          { key: "targetContainerCount", header: "CONTAINERS" },
          { key: "id", header: "ID" },
        ],
        quietField: "id",
        emptyMessage: "no components",
      });
    },
  },
  {
    path: ["service", "next-version"],
    summary: "Choose whether the next deploy prepares a custom runtime.",
    description: `Applies to the *next* app version only. A custom runtime runs the \`run.prepare\` commands from
zerops.yaml to bake a runtime image, instead of reusing the base one — worth forcing on when a
system package was added and the cached runtime no longer matches.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [{ name: "custom-runtime", type: "boolean", default: true, description: "Prepare a custom runtime. Use --no-custom-runtime to reuse the base image." }],
    examples: ["zz service next-version api --custom-runtime"],
    operations: ["SetNextAppVersion"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const body = { useCustomRuntime: ctx.flags["custom-runtime"] !== false };
      if (ctx.dryRun) return { dryRun: true, operation: "SetNextAppVersion", service: service.name, body };
      await ctx.api.call("SetNextAppVersion", { path: { id: service.id }, body });
      ctx.out.step(`next deploy of ${service.name} will ${body.useCustomRuntime ? "prepare" : "skip"} a custom runtime`);
      return { service: service.name, ...body };
    },
  },
  {
    path: ["service", "build-cache", "delete"],
    summary: "Drop the build cache for a service.",
    description: "Use when a cached dependency layer has gone stale and a rebuild keeps picking it up.",
    destructive: true,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["DeleteBuildCache"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      await ctx.confirm(`delete the build cache for ${service.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteBuildCache", serviceId: service.id };
      const proc = await ctx.api.call<{ id: string }>("DeleteBuildCache", { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, proc, `dropping build cache for ${service.name}`));
    },
  },
];
