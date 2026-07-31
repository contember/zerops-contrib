/**
 * Public routing: domains over the L7 balancer, and raw TCP/UDP ports.
 *
 * Routing changes are staged and then synced to the balancer. The sync is done automatically
 * here, because a staged-but-unsynced route looks configured and serves nothing.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { notFound } from "../lib/errors.ts";

interface HttpRouting {
  id: string;
  domains: { domainName: string; dnsCheckStatus?: string; sslStatus?: string }[];
  locations: { path: string; port: number; serviceStackId: string }[];
  sslEnabled: boolean;
  cdnEnabled?: boolean;
  status?: string;
}

interface PortRouting {
  id: string;
  publicPort: number;
  internalPort: number;
  internalProtocol: string;
  publicIpType: string;
  firewallPolicy?: string;
  firewallIpRanges?: string[];
  status?: string;
}

export const routeCommands: CommandSpec[] = [
  {
    path: ["route", "http", "list"],
    summary: "List HTTP routes (domains) in the project.",
    examples: ["zz route http list", "zz route http list --json"],
    operations: ["ListProjectPublicHttpRoutings"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const res = await ctx.api.call<{ items?: HttpRouting[]; list?: HttpRouting[] }>(
        "ListProjectPublicHttpRoutings",
        { path: { id: projectId } },
      );
      const items = res.items ?? res.list ?? [];
      ctx.out.data(items, {
        columns: [
          { key: "domains", header: "DOMAINS", get: (r: HttpRouting) => r.domains?.map((d) => d.domainName).join(",") ?? "-" },
          { key: "id", header: "ID" },
          { key: "sslEnabled", header: "SSL" },
          { key: "locations", header: "LOCATIONS", get: (r: HttpRouting) => r.locations?.map((l) => `${l.path}→:${l.port}`).join(" ") ?? "-" },
          { key: "status", header: "STATUS" },
        ],
        quietField: "id",
        emptyMessage: "no HTTP routes",
      });
    },
  },
  {
    path: ["route", "http", "create"],
    summary: "Point a domain at a service.",
    description: `Creates a route on the project's L7 balancer and syncs it, so the domain is live once the
command returns (DNS permitting). Certificates are issued automatically when --ssl is set.`,
    args: [
      { name: "domain", description: "Domain name, e.g. api.example.com.", required: true },
      { name: "service", description: "Service to route to. Defaults to --service." },
    ],
    flags: [
      { name: "port", type: "number", required: true, placeholder: "<port>", description: "Internal port on the service to forward to." },
      { name: "path", type: "string", default: "/", description: "Path prefix this route matches." },
      { name: "ssl", type: "boolean", default: true, description: "Issue and serve a certificate. Use --no-ssl to disable." },
      { name: "cdn", type: "boolean", description: "Serve through the CDN." },
    ],
    examples: [
      "zz route http create api.example.com api --port 3000",
      "zz route http create example.com web --port 80 --no-ssl",
    ],
    operations: ["CreatePublicHttpRouting", "SyncPublicHttpRouting"],
    async run(ctx, parsed) {
      const domain = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      const projectId = await ctx.projectId();
      const body = {
        domains: [domain],
        sslEnabled: ctx.flags.ssl !== false,
        cdnEnabled: ctx.bool("cdn"),
        locations: [
          {
            path: ctx.flag<string>("path") ?? "/",
            port: ctx.flag<number>("port")!,
            serviceStackId: service.id,
          },
        ],
      };
      if (ctx.dryRun) return { dryRun: true, operation: "CreatePublicHttpRouting", body };

      const created = await ctx.api.call<HttpRouting>("CreatePublicHttpRouting", {
        path: { id: projectId },
        body,
      });
      ctx.out.step(`route created for ${domain}`);

      // Staging alone does not serve traffic; the balancer needs the sync.
      const proc = await ctx.api.call<{ id: string }>("SyncPublicHttpRouting", { path: { id: projectId } });
      const synced = await settleProcess(ctx, proc, "syncing the balancer");
      ctx.out.data({ ...synced, routingId: created.id, domain, service: service.name });
    },
  },
  {
    path: ["route", "http", "delete"],
    summary: "Delete an HTTP route.",
    destructive: true,
    args: [{ name: "domain-or-id", description: "Domain name or routing id.", required: true }],
    operations: ["ListProjectPublicHttpRoutings", "DeletePublicHttpRouting", "SyncPublicHttpRouting"],
    async run(ctx, parsed) {
      const ref = parsed.args[0]!;
      const projectId = await ctx.projectId();
      const res = await ctx.api.call<{ items?: HttpRouting[]; list?: HttpRouting[] }>(
        "ListProjectPublicHttpRoutings",
        { path: { id: projectId } },
      );
      const items = res.items ?? res.list ?? [];
      const target = items.find((r) => r.id === ref || r.domains?.some((d) => d.domainName === ref));
      if (!target) throw notFound(`no HTTP route for '${ref}'`, "Run `zz route http list`.");

      await ctx.confirm(`delete the route for ${target.domains?.map((d) => d.domainName).join(", ")}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeletePublicHttpRouting", routingId: target.id };

      await ctx.api.call("DeletePublicHttpRouting", { path: { id: target.id } });
      const proc = await ctx.api.call<{ id: string }>("SyncPublicHttpRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing the balancer"));
    },
  },
  {
    path: ["route", "http", "sync"],
    summary: "Push staged HTTP routing changes to the balancer.",
    description: "Only needed after editing routes through the GUI or the raw API; `zz route http create/delete` sync for you.",
    operations: ["SyncPublicHttpRouting"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "SyncPublicHttpRouting" };
      const proc = await ctx.api.call<{ id: string }>("SyncPublicHttpRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing HTTP routing"));
    },
  },
  {
    path: ["route", "port", "list"],
    summary: "List raw TCP/UDP port routes for a service.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    operations: ["ListServiceStackPublicPortRoutings"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await ctx.api.call<{ items?: PortRouting[]; list?: PortRouting[] }>(
        "ListServiceStackPublicPortRoutings",
        { path: { id: service.id } },
      );
      const items = res.items ?? res.list ?? [];
      ctx.out.data(items, {
        columns: [
          { key: "publicPort", header: "PUBLIC" },
          { key: "internalPort", header: "INTERNAL" },
          { key: "internalProtocol", header: "PROTO" },
          { key: "publicIpType", header: "IP" },
          { key: "id", header: "ID" },
          { key: "status", header: "STATUS" },
        ],
        quietField: "id",
        emptyMessage: "no port routes",
      });
    },
  },
  {
    path: ["route", "port", "create"],
    summary: "Expose a raw TCP/UDP port.",
    description: "Requires the project to have a public IPv4 or IPv6 address. Use `zz project get` to check.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "public-port", type: "number", required: true, description: "Port to expose publicly." },
      { name: "internal-port", type: "number", required: true, description: "Port on the service to forward to." },
      { name: "protocol", type: "string", enum: ["tcp", "udp"], default: "tcp", description: "Transport protocol." },
      { name: "ip-type", type: "string", enum: ["IP_V4", "IP_V6"], default: "IP_V4", description: "Which public address to bind." },
      { name: "firewall-policy", type: "string", enum: ["BLACKLIST", "WHITELIST"], default: "BLACKLIST", description: "How firewall-ip-range entries are interpreted." },
      { name: "firewall-ip-range", type: "string[]", placeholder: "<cidr>", description: "IP range for the firewall rule. Repeatable." },
      { name: "allow-my-ip", type: "boolean", description: "Add the caller's current public IP to the rule." },
    ],
    examples: ["zz route port create db --public-port 5432 --internal-port 5432 --firewall-policy WHITELIST --allow-my-ip"],
    operations: ["CreatePublicPortRouting", "SyncPublicPortRouting"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const projectId = await ctx.projectId();
      const body = {
        publicPort: ctx.flag<number>("public-port")!,
        internalPort: ctx.flag<number>("internal-port")!,
        internalProtocol: ctx.flag<string>("protocol") ?? "tcp",
        publicIpType: ctx.flag<string>("ip-type") ?? "IP_V4",
        firewallPolicy: ctx.flag<string>("firewall-policy") ?? "BLACKLIST",
        firewallIpRanges: ctx.flag<string[]>("firewall-ip-range") ?? [],
        firewallAllowMyIp: ctx.bool("allow-my-ip"),
      };
      if (ctx.dryRun) return { dryRun: true, operation: "CreatePublicPortRouting", service: service.name, body };

      const created = await ctx.api.call<PortRouting>("CreatePublicPortRouting", {
        path: { id: service.id },
        body,
      });
      const proc = await ctx.api.call<{ id: string }>("SyncPublicPortRouting", { path: { id: projectId } });
      const synced = await settleProcess(ctx, proc, "syncing port routing");
      ctx.out.data({ ...synced, routingId: created.id, ...body });
    },
  },
  {
    path: ["route", "port", "delete"],
    summary: "Remove a raw port route.",
    destructive: true,
    args: [{ name: "routing-id", description: "Port routing id (see `zz route port list`).", required: true }],
    operations: ["DeletePublicPortRouting", "SyncPublicPortRouting"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const projectId = await ctx.projectId();
      await ctx.confirm(`delete port route ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeletePublicPortRouting", routingId: id };
      await ctx.api.call("DeletePublicPortRouting", { path: { id } });
      const proc = await ctx.api.call<{ id: string }>("SyncPublicPortRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing port routing"));
    },
  },
];
