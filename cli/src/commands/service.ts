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
