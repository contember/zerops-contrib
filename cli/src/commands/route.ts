/**
 * Public routing: domains over the L7 balancer, and raw TCP/UDP ports.
 *
 * Routing changes are staged and then synced to the balancer. The sync is done automatically
 * here, because a staged-but-unsynced route looks configured and serves nothing.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { notFound, usage } from "../lib/errors.ts";

interface HttpRouting {
  id: string;
  domains: { domainName: string; dnsCheckStatus?: string; sslStatus?: string }[];
  locations: { path: string; port: number; serviceStackId: string }[];
  sslEnabled: boolean;
  cdnEnabled?: boolean;
  status?: string;
}

/** Routes are addressed by domain far more often than by id, so both are accepted everywhere. */
async function findHttpRouting(
  ctx: import("../lib/context.ts").Context,
  ref: string,
): Promise<HttpRouting> {
  const projectId = await ctx.projectId();
  const res = await ctx.api.call<{ items?: HttpRouting[]; list?: HttpRouting[] }>(
    "ListProjectPublicHttpRoutings",
    { path: { id: projectId } },
  );
  const items = res.items ?? res.list ?? [];
  const target = items.find((r) => r.id === ref || r.domains?.some((d) => d.domainName === ref));
  if (!target) throw notFound(`no HTTP route for '${ref}'`, "Run `zops route http list`.");
  return target;
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
    examples: ["zops route http list", "zops route http list --json"],
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
      "zops route http create api.example.com api --port 3000",
      "zops route http create example.com web --port 80 --no-ssl",
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
    path: ["route", "http", "get"],
    summary: "Show one HTTP route in full, including per-domain DNS and certificate state.",
    description: `The place to look when a domain does not serve. \`dnsCheckStatus\` tells you whether the domain
actually points at the balancer, and \`sslStatus\` whether a certificate has been issued — a
route can be perfectly configured and still fail on either.`,
    args: [{ name: "domain-or-id", description: "Domain name or routing id.", required: true }],
    examples: ["zops route http get api.example.com", "zops route http get api.example.com --json"],
    operations: ["ListProjectPublicHttpRoutings", "GetPublicHttpRouting"],
    async run(ctx, parsed) {
      const target = await findHttpRouting(ctx, parsed.args[0]!);
      ctx.out.data(await ctx.api.call("GetPublicHttpRouting", { path: { id: target.id } }));
    },
  },
  {
    path: ["route", "http", "update"],
    summary: "Change an existing HTTP route's domains, target or TLS.",
    description: `Reads the route and merges, so anything you do not pass is preserved — including the
per-location settings the API supports but this command does not expose (basic auth, rate
limiting, redirects, IP access policies). Those survive an update untouched; set them through
\`zops api UpdatePublicHttpRouting\` if you need them.

--port and --path rewrite the *first* location. A route with several locations is better edited
through the raw operation, where you can address each one.`,
    destructive: true,
    args: [
      { name: "domain-or-id", description: "Domain name or routing id.", required: true },
      { name: "service", description: "New target service. Defaults to leaving it unchanged." },
    ],
    flags: [
      { name: "domain", type: "string[]", placeholder: "<domain>", description: "Domain for this route. Repeatable, and replaces the existing list." },
      { name: "port", type: "number", placeholder: "<port>", description: "New internal port for the first location." },
      { name: "path", type: "string", placeholder: "<path>", description: "New path prefix for the first location." },
      { name: "ssl", type: "boolean", description: "Serve a certificate. Use --no-ssl to disable." },
      { name: "cdn", type: "boolean", description: "Serve through the CDN. Use --no-cdn to disable." },
    ],
    examples: [
      "zops route http update api.example.com --port 8080 --yes",
      "zops route http update api.example.com api-v2 --yes",
      "zops route http update old.example.com --domain new.example.com --yes",
    ],
    operations: ["ListProjectPublicHttpRoutings", "UpdatePublicHttpRouting", "SyncPublicHttpRouting"],
    async run(ctx, parsed) {
      const target = await findHttpRouting(ctx, parsed.args[0]!);
      const projectId = await ctx.projectId();

      const touched = ["domain", "port", "path", "ssl", "cdn"].filter((f) => ctx.flags[f] !== undefined);
      const service = parsed.args[1] ? await ctx.service(parsed.args[1]) : undefined;
      if (touched.length === 0 && !service) {
        throw usage(
          "nothing to change",
          "Pass a service argument, or one of --domain, --port, --path, --ssl, --cdn.",
        );
      }

      const locations = (target.locations ?? []).map((location, index) =>
        index === 0
          ? {
              ...location,
              path: ctx.flag<string>("path") ?? location.path,
              port: ctx.flag<number>("port") ?? location.port,
              serviceStackId: service?.id ?? location.serviceStackId,
            }
          : location,
      );

      const body = {
        domains: ctx.flag<string[]>("domain") ?? (target.domains ?? []).map((d) => d.domainName),
        sslEnabled: ctx.flags.ssl !== undefined ? ctx.bool("ssl") : target.sslEnabled,
        cdnEnabled: ctx.flags.cdn !== undefined ? ctx.bool("cdn") : (target.cdnEnabled ?? false),
        locations,
      };

      await ctx.confirm(`update the route for ${body.domains.join(", ")}`);
      if (ctx.dryRun) return { dryRun: true, operation: "UpdatePublicHttpRouting", routingId: target.id, body };

      await ctx.api.call("UpdatePublicHttpRouting", { path: { id: target.id }, body });
      ctx.out.step(`route ${target.id} updated`);
      const proc = await ctx.api.call("SyncPublicHttpRouting", { path: { id: projectId } });
      const synced = await settleProcess(ctx, proc, "syncing the balancer");
      ctx.out.data({ ...synced, routingId: target.id, domains: body.domains });
    },
  },
  {
    path: ["route", "http", "dns-check"],
    summary: "Re-run the DNS check for a route's domains.",
    description: `Certificate issuance waits on the domain resolving to the balancer. After fixing an A or CNAME
record the platform re-checks on its own schedule; this asks it to look now instead of waiting.

Read the result with \`zops route http get\` — the check is asynchronous and this only queues it.`,
    args: [
      { name: "domain-or-id", description: "Domain name or routing id.", required: true },
      { name: "domain", description: "Check only this one domain of the route.", required: false },
    ],
    examples: ["zops route http dns-check api.example.com"],
    operations: ["ListProjectPublicHttpRoutings", "TriggerPublicHttpRoutingDomainsDnsCheck"],
    async run(ctx, parsed) {
      const target = await findHttpRouting(ctx, parsed.args[0]!);
      const domains = parsed.args[1] ? [parsed.args[1]] : (target.domains ?? []).map((d) => d.domainName);
      if (ctx.dryRun) {
        return { dryRun: true, operation: "TriggerPublicHttpRoutingDomainsDnsCheck", routingId: target.id, domains };
      }
      await ctx.api.call("TriggerPublicHttpRoutingDomainsDnsCheck", {
        path: { id: target.id },
        body: { domains },
      });
      ctx.out.step(`DNS check queued for ${domains.join(", ")}`);
      return { queued: true, routingId: target.id, domains };
    },
  },
  {
    path: ["route", "http", "restore"],
    summary: "Undo a staged deletion of an HTTP route.",
    description: "Works only while the deletion is staged; once the balancer has synced, the route is gone and has to be recreated.",
    args: [{ name: "routing-id", description: "Routing id of the deleted route.", required: true }],
    operations: ["RestorePublicHttpRouting", "SyncPublicHttpRouting"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "RestorePublicHttpRouting", routingId: id };
      const restored = await ctx.api.call<HttpRouting>("RestorePublicHttpRouting", { path: { id } });
      const proc = await ctx.api.call("SyncPublicHttpRouting", { path: { id: projectId } });
      const synced = await settleProcess(ctx, proc, "syncing the balancer");
      ctx.out.data({ ...synced, routingId: id, domains: (restored.domains ?? []).map((d) => d.domainName) });
    },
  },
  {
    path: ["route", "http", "revert"],
    summary: "Discard every staged HTTP routing change in the project.",
    description: `Routing edits are staged until synced. This throws away everything staged and leaves the
balancer serving what it already serves — the escape hatch when a half-finished set of changes
should not go live.`,
    destructive: true,
    examples: ["zops route http revert --yes"],
    operations: ["RevertPublicHttpRoutingChanges"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      await ctx.confirm("discard every staged HTTP routing change in this project");
      if (ctx.dryRun) return { dryRun: true, operation: "RevertPublicHttpRoutingChanges", projectId };
      await ctx.api.call("RevertPublicHttpRoutingChanges", { path: { id: projectId } });
      ctx.out.step("staged HTTP routing changes discarded");
      return { reverted: true };
    },
  },
  {
    path: ["route", "http", "delete"],
    summary: "Delete an HTTP route.",
    destructive: true,
    args: [{ name: "domain-or-id", description: "Domain name or routing id.", required: true }],
    operations: ["ListProjectPublicHttpRoutings", "DeletePublicHttpRouting", "SyncPublicHttpRouting"],
    async run(ctx, parsed) {
      const projectId = await ctx.projectId();
      const target = await findHttpRouting(ctx, parsed.args[0]!);

      await ctx.confirm(`delete the route for ${target.domains?.map((d) => d.domainName).join(", ")}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeletePublicHttpRouting", routingId: target.id };

      await ctx.api.call("DeletePublicHttpRouting", { path: { id: target.id } });
      const proc = await ctx.api.call("SyncPublicHttpRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing the balancer"));
    },
  },
  {
    path: ["route", "http", "sync"],
    summary: "Push staged HTTP routing changes to the balancer.",
    description: "Only needed after editing routes through the GUI or the raw API; `zops route http create/delete` sync for you.",
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
    description: "Requires the project to have a public IPv4 or IPv6 address. Use `zops project get` to check.",
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
    examples: ["zops route port create db --public-port 5432 --internal-port 5432 --firewall-policy WHITELIST --allow-my-ip"],
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
    path: ["route", "port", "get"],
    summary: "Show one port route in detail, including its firewall rule.",
    args: [{ name: "routing-id", description: "Port routing id (see `zops route port list`).", required: true }],
    operations: ["GetPublicPortRouting"],
    async run(ctx, parsed) {
      ctx.out.data(await ctx.api.call("GetPublicPortRouting", { path: { id: parsed.args[0]! } }));
    },
  },
  {
    path: ["route", "port", "update"],
    summary: "Change a port route's ports or firewall rule.",
    description: `Reads the route and merges, so an unpassed field keeps its value. --firewall-ip-range is the
exception: passing it replaces the whole list, which is what you want when tightening a
whitelist rather than appending to it.`,
    destructive: true,
    args: [{ name: "routing-id", description: "Port routing id.", required: true }],
    flags: [
      { name: "public-port", type: "number", description: "New public port." },
      { name: "internal-port", type: "number", description: "New port on the service." },
      { name: "protocol", type: "string", enum: ["tcp", "udp"], description: "Transport protocol." },
      { name: "ip-type", type: "string", enum: ["IP_V4", "IP_V6"], description: "Which public address to bind." },
      { name: "firewall-policy", type: "string", enum: ["BLACKLIST", "WHITELIST"], description: "How firewall-ip-range entries are interpreted." },
      { name: "firewall-ip-range", type: "string[]", placeholder: "<cidr>", description: "IP range for the firewall rule. Repeatable, and replaces the existing list." },
      { name: "allow-my-ip", type: "boolean", description: "Add the caller's current public IP to the rule." },
    ],
    examples: [
      "zops route port update 3mKq... --firewall-policy WHITELIST --allow-my-ip --yes",
      "zops route port update 3mKq... --internal-port 5433 --yes",
    ],
    operations: ["GetPublicPortRouting", "UpdatePublicPortRouting", "SyncPublicPortRouting"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const projectId = await ctx.projectId();
      const current = await ctx.api.call<PortRouting & { firewallAllowMyIp?: boolean }>(
        "GetPublicPortRouting",
        { path: { id } },
      );

      const touched = [
        "public-port", "internal-port", "protocol", "ip-type",
        "firewall-policy", "firewall-ip-range", "allow-my-ip",
      ].filter((f) => ctx.flags[f] !== undefined);
      if (touched.length === 0) {
        throw usage("nothing to change", "Pass at least one of --public-port, --internal-port, --protocol, --ip-type, --firewall-policy, --firewall-ip-range, --allow-my-ip.");
      }

      const body = {
        publicPort: ctx.flag<number>("public-port") ?? current.publicPort,
        internalPort: ctx.flag<number>("internal-port") ?? current.internalPort,
        internalProtocol: ctx.flag<string>("protocol") ?? current.internalProtocol,
        publicIpType: ctx.flag<string>("ip-type") ?? current.publicIpType,
        firewallPolicy: ctx.flag<string>("firewall-policy") ?? current.firewallPolicy ?? "BLACKLIST",
        firewallIpRanges: ctx.flag<string[]>("firewall-ip-range") ?? current.firewallIpRanges ?? [],
        firewallAllowMyIp:
          ctx.flags["allow-my-ip"] !== undefined ? ctx.bool("allow-my-ip") : (current.firewallAllowMyIp ?? false),
      };

      await ctx.confirm(`update port route ${id} (${body.publicPort} → :${body.internalPort})`);
      if (ctx.dryRun) return { dryRun: true, operation: "UpdatePublicPortRouting", routingId: id, changed: touched, body };

      await ctx.api.call("UpdatePublicPortRouting", { path: { id }, body });
      const proc = await ctx.api.call("SyncPublicPortRouting", { path: { id: projectId } });
      const synced = await settleProcess(ctx, proc, "syncing port routing");
      ctx.out.data({ ...synced, routingId: id, ...body });
    },
  },
  {
    path: ["route", "port", "restore"],
    summary: "Undo a staged deletion of a port route.",
    description: "Works only while the deletion is staged; after the sync the route is gone for good.",
    args: [{ name: "routing-id", description: "Port routing id.", required: true }],
    operations: ["RestorePublicPortRouting", "SyncPublicPortRouting"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "RestorePublicPortRouting", routingId: id };
      await ctx.api.call("RestorePublicPortRouting", { path: { id } });
      const proc = await ctx.api.call("SyncPublicPortRouting", { path: { id: projectId } });
      ctx.out.data({ ...(await settleProcess(ctx, proc, "syncing port routing")), routingId: id });
    },
  },
  {
    path: ["route", "port", "revert"],
    summary: "Discard every staged port routing change in the project.",
    destructive: true,
    examples: ["zops route port revert --yes"],
    operations: ["RevertPublicPortRoutingChanges"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      await ctx.confirm("discard every staged port routing change in this project");
      if (ctx.dryRun) return { dryRun: true, operation: "RevertPublicPortRoutingChanges", projectId };
      await ctx.api.call("RevertPublicPortRoutingChanges", { path: { id: projectId } });
      ctx.out.step("staged port routing changes discarded");
      return { reverted: true };
    },
  },
  {
    path: ["route", "port", "sync"],
    summary: "Push staged port routing changes to the balancer.",
    description: "Only needed after editing port routes through the GUI or the raw API; the `zops route port` commands sync for you.",
    operations: ["SyncPublicPortRouting"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "SyncPublicPortRouting" };
      const proc = await ctx.api.call("SyncPublicPortRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing port routing"));
    },
  },
  {
    path: ["route", "port", "delete"],
    summary: "Remove a raw port route.",
    destructive: true,
    args: [{ name: "routing-id", description: "Port routing id (see `zops route port list`).", required: true }],
    operations: ["DeletePublicPortRouting", "SyncPublicPortRouting"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const projectId = await ctx.projectId();
      await ctx.confirm(`delete port route ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeletePublicPortRouting", routingId: id };
      await ctx.api.call("DeletePublicPortRouting", { path: { id } });
      const proc = await ctx.api.call("SyncPublicPortRouting", { path: { id: projectId } });
      ctx.out.data(await settleProcess(ctx, proc, "syncing port routing"));
    },
  },
];
