import { readFile } from "node:fs/promises";
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { EXIT, ZopsError, notFound, usage } from "../lib/errors.ts";
import { esFilter } from "../lib/extra-operations.ts";
import type { ProjectSummary } from "../lib/context.ts";

const PROJECT_COLUMNS = [
  { key: "name", header: "NAME" },
  { key: "id", header: "ID" },
  { key: "status", header: "STATUS" },
  { key: "mode", header: "MODE" },
  { key: "tagList", header: "TAGS" },
];

/** Reads a YAML file, or stdin when the path is `-`. */
async function readYaml(path: string): Promise<string> {
  return path === "-" ? Bun.stdin.text() : readFile(path, "utf8");
}

export const projectCommands: CommandSpec[] = [
  {
    path: ["project", "list"],
    summary: "List every project the token can see.",
    description: `Uses the documented org-wide listing when the token allows it, and falls back to the
search endpoint otherwise.

That fallback matters: a project-scoped token — the shape recommended for CI and required by
zcp — has no organization-level read permission, so the documented endpoint returns 403 while
the search endpoint correctly returns the projects the token can actually reach.`,
    flags: [
      { name: "status", type: "string", placeholder: "<status>", description: "Only projects with this status, e.g. ACTIVE." },
    ],
    examples: ["zops project list", "zops project list --json", "zops project list -q   # bare names"],
    operations: ["ListClientProjects", "SearchProject"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      let items: ProjectSummary[];
      try {
        const res = await ctx.api.call<{ items?: ProjectSummary[]; list?: ProjectSummary[] }>(
          "ListClientProjects",
          { path: { id: clientId }, query: { limit: 1000 } },
        );
        items = res.items ?? res.list ?? [];
      } catch (err) {
        if (!(err instanceof ZopsError) || err.exitCode !== EXIT.AUTH) throw err;
        ctx.out.debug("org-wide listing denied; falling back to the search endpoint");
        const res = await ctx.api.call<{ items?: ProjectSummary[] }>("SearchProject", {
          body: esFilter([{ name: "clientId", operator: "eq", value: clientId }], {
            sort: [{ name: "name", ascending: true }],
          }),
        });
        items = res.items ?? [];
      }
      const status = ctx.flag<string>("status");
      if (status) items = items.filter((p) => p.status === status.toUpperCase());
      ctx.out.data(items, { columns: PROJECT_COLUMNS, emptyMessage: "no projects" });
    },
  },
  {
    path: ["project", "get"],
    summary: "Show one project in detail.",
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    examples: ["zops project get myapp", "zops project get --json"],
    operations: ["GetProjectDetails"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      ctx.out.data(project);
    },
  },
  {
    path: ["project", "create"],
    summary: "Create an empty project.",
    description: `Creates a project with no services. To create a project and its services together, write an
import YAML and use \`zops project import\` instead — that is the normal path.`,
    flags: [
      { name: "name", type: "string", required: true, placeholder: "<name>", description: "Project name." },
      { name: "mode", type: "string", enum: ["LIGHT", "SERIOUS"], default: "LIGHT", description: "LIGHT is single-container core; SERIOUS is the HA core." },
      { name: "description", type: "string", placeholder: "<text>", description: "Free-text description." },
      { name: "tag", type: "string[]", placeholder: "<tag>", description: "Attach a tag. Repeatable." },
      { name: "env-isolation", type: "string", enum: ["none", "service"], description: "Environment variable visibility between services." },
      { name: "location", type: "string", placeholder: "<id>", description: "Preferred location id." },
    ],
    examples: ["zops project create --name myapp --mode LIGHT"],
    operations: ["CreateProject"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      const body = {
        name: ctx.flag<string>("name")!,
        mode: ctx.flag<string>("mode"),
        description: ctx.flag<string>("description") ?? null,
        tagList: ctx.flag<string[]>("tag") ?? [],
        userRoles: [],
        envIsolation: ctx.flag<string>("env-isolation") ?? null,
        location: ctx.flag<string>("location") ?? null,
      };
      if (ctx.dryRun) return { dryRun: true, operation: "CreateProject", body };
      const created = await ctx.api.call<ProjectSummary>("CreateProject", { path: { id: clientId }, body });
      ctx.out.step(`project ${created.name} created (${created.id})`);
      ctx.out.data(created);
    },
  },
  {
    path: ["project", "import"],
    summary: "Create a project and its services from an import YAML.",
    description: `Takes the import YAML format (top-level \`project:\` and \`services:\` keys) — not \`zerops.yaml\`,
which describes the build pipeline and lives in the repository.

Waits for the resulting processes unless --no-wait is given.`,
    args: [{ name: "file", description: "Path to the import YAML, or '-' for stdin.", required: true }],
    examples: ["zops project import zerops-import.yaml", "cat import.yaml | zops project import -"],
    operations: ["ImportProject"],
    async run(ctx, parsed) {
      const yaml = await readYaml(parsed.args[0]!);
      const clientId = await ctx.clientId();
      if (ctx.dryRun) return { dryRun: true, operation: "ImportProject", bytes: yaml.length };

      const res = await ctx.api.call<{
        projectId?: string;
        serviceStacks?: { id: string; name: string; processes?: { id: string }[] }[];
      }>("ImportProject", { path: { id: clientId }, body: { yaml } });

      ctx.out.step(`import accepted (project ${res.projectId ?? "?"})`);
      const processes = (res.serviceStacks ?? []).flatMap((s) => s.processes ?? []);
      const waited: unknown[] = [];
      for (const proc of processes) {
        waited.push(await settleProcess(ctx, proc, `service provisioning ${proc.id}`));
      }
      ctx.out.data({ projectId: res.projectId, services: res.serviceStacks ?? [], processes: waited });
    },
  },
  {
    path: ["project", "export"],
    summary: "Export a project as import YAML.",
    description: "Round-trips through `zops project import`, which makes it the supported way to clone an environment.",
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    examples: ["zops project export myapp > import.yaml"],
    operations: ["ExportProject"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      const res = await ctx.api.call<{ yaml?: string }>("ExportProject", { path: { id: project.id } });
      if (ctx.out.json) {
        ctx.out.data(res);
        return;
      }
      ctx.out.raw(res.yaml ?? "");
    },
  },
  {
    path: ["project", "start"],
    summary: "Start every service in the project.",
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    operations: ["StartProject"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      if (ctx.dryRun) return { dryRun: true, operation: "StartProject", projectId: project.id };
      const proc = await ctx.api.call<{ id: string }>("StartProject", { path: { id: project.id } });
      ctx.out.data(await settleProcess(ctx, proc, `starting project ${project.name}`));
    },
  },
  {
    path: ["project", "stop"],
    summary: "Stop every service in the project.",
    destructive: true,
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    operations: ["StopProject"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      await ctx.confirm(`stop all services in project ${project.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "StopProject", projectId: project.id };
      const proc = await ctx.api.call<{ id: string }>("StopProject", { path: { id: project.id } });
      ctx.out.data(await settleProcess(ctx, proc, `stopping project ${project.name}`));
    },
  },
  {
    path: ["project", "delete"],
    summary: "Delete a project and everything in it.",
    destructive: true,
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    examples: ["zops project delete throwaway --yes", "zops project delete throwaway --dry-run"],
    operations: ["DeleteProject"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      await ctx.confirm(`permanently delete project ${project.name} (${project.id}) and all its data`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteProject", projectId: project.id };
      const proc = await ctx.api.call<{ id: string }>("DeleteProject", { path: { id: project.id } });
      ctx.out.data(await settleProcess(ctx, proc, `deleting project ${project.name}`));
    },
  },
  {
    path: ["project", "update"],
    summary: "Rename a project, or change its description and tags.",
    description: `The underlying endpoint is a full replacement, so this reads the project first and merges
your changes into it — a field you do not pass keeps its current value rather than being
cleared. \`--tag\` is the exception: passing it replaces the whole tag list.

User roles are deliberately left alone; this command never touches who can access the project.`,
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    flags: [
      { name: "name", type: "string", placeholder: "<name>", description: "New project name." },
      { name: "description", type: "string", placeholder: "<text>", description: "New description. Pass an empty string to clear it." },
      { name: "tag", type: "string[]", placeholder: "<tag>", description: "Tag to set. Repeatable, and replaces the existing list." },
    ],
    examples: [
      "zops project update --name myapp-staging",
      "zops project update myapp --tag prod --tag billing",
    ],
    operations: ["GetProjectDetails", "UpdateProject"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      const touched = ["name", "description", "tag"].filter((f) => ctx.flags[f] !== undefined);
      if (touched.length === 0) {
        throw usage("nothing to change", "Pass at least one of --name, --description, --tag.");
      }

      const body = {
        name: ctx.flag<string>("name") ?? project.name,
        description: ctx.flag<string>("description") ?? (project.description ?? null),
        tagList: ctx.flag<string[]>("tag") ?? (project.tagList ?? []),
        // Re-sent unchanged: the endpoint defaults it to false, which would silently drop a
        // shared public IPv4 from a project that has one.
        publicIpV4Shared: project.publicIpV4Shared ?? false,
      };

      if (ctx.dryRun) return { dryRun: true, operation: "UpdateProject", projectId: project.id, changed: touched, body };
      const updated = await ctx.api.call<ProjectSummary>("UpdateProject", { path: { id: project.id }, body });
      ctx.out.step(`project ${updated.name} updated`);
      ctx.out.data(updated);
    },
  },
  {
    path: ["project", "mode"],
    summary: "Upgrade the project core from LIGHT to SERIOUS (highly available).",
    description: `The core runs the internal DNS, the L7 balancer and the log collector. LIGHT runs one
container of each; SERIOUS runs a redundant set and survives a node failure.

This is an upgrade only — the platform does not downgrade a SERIOUS core back to LIGHT, so the
cost increase is not reversible from here.`,
    destructive: true,
    args: [
      { name: "mode", description: "Target core mode. Only SERIOUS is a valid upgrade target.", required: true },
      { name: "project", description: "Project name or id. Defaults to --project." },
    ],
    examples: ["zops project mode SERIOUS --yes", "zops project mode SERIOUS myapp --dry-run"],
    operations: ["PutProjectModeUpgrade"],
    async run(ctx, parsed) {
      const mode = parsed.args[0]!.toUpperCase();
      if (mode !== "LIGHT" && mode !== "SERIOUS") {
        throw usage(`unknown mode ${JSON.stringify(parsed.args[0])}`, "Use LIGHT or SERIOUS.");
      }
      const project = parsed.args[1] ? await ctx.resolveProject(parsed.args[1]) : await ctx.project();
      await ctx.confirm(`upgrade the core of ${project.name} to ${mode} — this raises the running cost and cannot be undone`);
      if (ctx.dryRun) return { dryRun: true, operation: "PutProjectModeUpgrade", projectId: project.id, mode };
      const res = await ctx.api.call("PutProjectModeUpgrade", { path: { id: project.id }, body: { mode } });
      ctx.out.data(await settleProcess(ctx, res, `upgrading ${project.name} to ${mode}`));
    },
  },
  {
    path: ["project", "ipv4", "request"],
    summary: "Request a dedicated public IPv4 address for the project.",
    description: `A dedicated address is billed and is what raw TCP/UDP port routing needs when the shared
address is not enough. \`zops project get\` reports the assigned address once it is provisioned.`,
    destructive: true,
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    operations: ["RequestIpv4"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      await ctx.confirm(`request a billed dedicated IPv4 address for ${project.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "RequestIpv4", projectId: project.id };
      const res = await ctx.api.call("RequestIpv4", { path: { id: project.id } });
      ctx.out.data(await settleProcess(ctx, res, `requesting an IPv4 address for ${project.name}`));
    },
  },
  {
    path: ["project", "ipv4", "release"],
    summary: "Release the project's dedicated public IPv4 address.",
    description: `The address is gone at once and routing that depends on it stops. The paid period is kept and
reused by the next \`zops project ipv4 request\` until it ends.`,
    destructive: true,
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    operations: ["ReleaseIpv4"],
    async run(ctx, parsed) {
      const project = parsed.args[0] ? await ctx.resolveProject(parsed.args[0]) : await ctx.project();
      await ctx.confirm(`release the dedicated IPv4 address of ${project.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "ReleaseIpv4", projectId: project.id };
      const res = await ctx.api.call("ReleaseIpv4", { path: { id: project.id } });
      ctx.out.data(await settleProcess(ctx, res, `releasing the IPv4 address of ${project.name}`));
    },
  },
  {
    path: ["project", "ipv4", "shared"],
    summary: "Turn the shared public IPv4 address on or off.",
    description: "The shared address is free and carries HTTP traffic. Port routing on a shared address is limited to ports the platform assigns.",
    args: [
      { name: "state", description: "'on' or 'off'.", required: true },
      { name: "project", description: "Project name or id. Defaults to --project." },
    ],
    examples: ["zops project ipv4 shared on", "zops project ipv4 shared off myapp"],
    operations: ["PutProjectPublicIpV4Shared"],
    async run(ctx, parsed) {
      const state = parsed.args[0]!.toLowerCase();
      if (state !== "on" && state !== "off") {
        throw usage(`expected 'on' or 'off', got ${JSON.stringify(parsed.args[0])}`);
      }
      const project = parsed.args[1] ? await ctx.resolveProject(parsed.args[1]) : await ctx.project();
      const enabled = state === "on";
      if (ctx.dryRun) return { dryRun: true, operation: "PutProjectPublicIpV4Shared", projectId: project.id, enabled };
      const updated = await ctx.api.call<ProjectSummary>("PutProjectPublicIpV4Shared", {
        path: { id: project.id },
        body: { enabled },
      });
      ctx.out.step(`shared IPv4 ${enabled ? "enabled" : "disabled"} for ${project.name}`);
      ctx.out.data(updated);
    },
  },
  {
    path: ["project", "tags"],
    summary: "List every project tag used in the organization.",
    description: "The vocabulary `zops project update --tag` draws from, so a new project can be tagged consistently with the existing ones.",
    examples: ["zops project tags -q"],
    operations: ["ListProjectTags"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      const res = await ctx.api.call<{ items?: string[] }>("ListProjectTags", { path: { id: clientId } });
      ctx.out.data(res.items ?? [], { emptyMessage: "no tags in use" });
    },
  },
  {
    path: ["project", "logging"],
    summary: "Forward project logs to an external syslog endpoint.",
    description: `Ships the project's combined log stream to your own collector. The syslog configuration is
passed through verbatim, so the accepted syntax is the collector's, not Zerops'.

Pass --type '' to stop forwarding.`,
    flags: [
      { name: "type", type: "string", required: true, placeholder: "<type>", description: "Forwarder type, e.g. syslog. An empty value disables forwarding." },
      { name: "config", type: "string", placeholder: "<path>", description: "File holding the syslog configuration block." },
      { name: "certificate", type: "string", placeholder: "<path>", description: "File holding the TLS certificate for the endpoint." },
    ],
    examples: ["zops project logging --type syslog --config ./syslog.conf"],
    operations: ["ConfigureRemoteLogging"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const configPath = ctx.flag<string>("config");
      const certPath = ctx.flag<string>("certificate");
      const body = {
        type: ctx.flag<string>("type") || null,
        syslogConfig: configPath ? await readFile(configPath, "utf8") : "",
        certificate: certPath ? await readFile(certPath, "utf8") : "",
      };
      if (ctx.dryRun) return { dryRun: true, operation: "ConfigureRemoteLogging", projectId, body };
      const res = await ctx.api.call("ConfigureRemoteLogging", { path: { id: projectId }, body });
      ctx.out.data(await settleProcess(ctx, res, "configuring remote logging"));
    },
  },
  {
    path: ["project", "balancer", "get"],
    summary: "Show the project's L7 HTTP balancer configuration.",
    description: "The tunables applied to every routed domain in the project — timeouts, body size limits and the like.",
    examples: ["zops project balancer get --json"],
    operations: ["GetProjectL7httpbalancerConfig"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const res = await ctx.api.call<{ values?: { name: string; value: string | null }[] }>(
        "GetProjectL7httpbalancerConfig",
        { path: { id: projectId } },
      );
      ctx.out.data(res.values ?? [], {
        columns: [
          { key: "name", header: "NAME" },
          { key: "value", header: "VALUE" },
        ],
        quietField: "name",
        emptyMessage: "no balancer configuration",
      });
    },
  },
  {
    path: ["project", "balancer", "set"],
    summary: "Change one or more L7 balancer settings.",
    description: `Reads the current configuration and merges, so an unlisted setting is untouched. Run
\`zops project balancer get\` first for the names this project accepts — they are the balancer's,
not a fixed Zerops list.

Pass \`name=\` with an empty value to reset one back to its default.`,
    destructive: true,
    args: [{ name: "assignment", description: "One or more name=value pairs.", required: true, variadic: true }],
    examples: [
      "zops project balancer set client_max_body_size=50m --yes",
      "zops project balancer set proxy_read_timeout=120s proxy_send_timeout=120s --yes",
    ],
    operations: ["GetProjectL7httpbalancerConfig", "PutProjectL7httpbalancerConfig"],
    async run(ctx, parsed) {
      const projectId = await ctx.projectId();
      const current = await ctx.api.call<{ values?: { name: string; value: string | null }[] }>(
        "GetProjectL7httpbalancerConfig",
        { path: { id: projectId } },
      );

      const merged = new Map((current.values ?? []).map((v) => [v.name, v.value]));
      const changed: string[] = [];
      for (const entry of parsed.args) {
        const eq = entry.indexOf("=");
        if (eq === -1) throw usage(`expected name=value, got ${JSON.stringify(entry)}`);
        const name = entry.slice(0, eq);
        const value = entry.slice(eq + 1);
        merged.set(name, value === "" ? null : value);
        changed.push(name);
      }

      const body = { values: [...merged].map(([name, value]) => ({ name, value })) };
      await ctx.confirm(`change balancer settings (${changed.join(", ")}) for the whole project`);
      if (ctx.dryRun) return { dryRun: true, operation: "PutProjectL7httpbalancerConfig", changed, body };
      const res = await ctx.api.call("PutProjectL7httpbalancerConfig", { path: { id: projectId }, body });
      ctx.out.data(await settleProcess(ctx, res, `applying balancer settings (${changed.join(", ")})`));
    },
  },
  {
    path: ["project", "prometheus"],
    summary: "Point the project's Prometheus core at external scrape targets.",
    description: `Only meaningful once the project has a Prometheus core stack. Each --target is a host:port
Prometheus should scrape; --label attaches a label to all of them.

For anything beyond one target group, pass a JSON file with --config-file holding the full
\`configs\` array.`,
    flags: [
      { name: "target", type: "string[]", placeholder: "<host:port>", description: "Scrape target. Repeatable." },
      { name: "label", type: "string[]", placeholder: "<key=value>", description: "Label applied to the targets. Repeatable." },
      { name: "config-file", type: "string", placeholder: "<path>", description: "JSON file holding the full configs array, instead of --target/--label." },
      { name: "instance", type: "string", placeholder: "<id>", description: "Core stack instance id, when the project has more than one." },
    ],
    examples: [
      "zops project prometheus --target metrics.example.com:9090 --label env=prod",
      "zops project prometheus --config-file ./scrape.json",
    ],
    operations: ["ConfigurePrometheus"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const configFile = ctx.flag<string>("config-file");
      const targets = ctx.flag<string[]>("target") ?? [];

      let configs: unknown;
      if (configFile) {
        configs = JSON.parse(await readFile(configFile, "utf8"));
      } else {
        if (targets.length === 0) {
          throw usage("nothing to configure", "Pass --target <host:port> at least once, or --config-file.");
        }
        const labels: Record<string, string> = {};
        for (const entry of ctx.flag<string[]>("label") ?? []) {
          const eq = entry.indexOf("=");
          if (eq === -1) throw usage(`--label expects key=value, got ${JSON.stringify(entry)}`);
          labels[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        configs = [{ targets, labels }];
      }

      const body = { configs, instanceId: ctx.flag<string>("instance") ?? null };
      if (ctx.dryRun) return { dryRun: true, operation: "ConfigurePrometheus", projectId, body };
      const res = await ctx.api.call("ConfigurePrometheus", { path: { id: projectId }, body });
      ctx.out.data(await settleProcess(ctx, res, "configuring Prometheus scrape targets"));
    },
  },
  {
    path: ["project", "service-import"],
    summary: "Add services to an existing project from an import YAML.",
    args: [{ name: "file", description: "Path to the services YAML, or '-' for stdin.", required: true }],
    examples: ["zops project service-import add-redis.yaml -P myapp"],
    operations: ["ImportServiceStack"],
    async run(ctx, parsed) {
      const yaml = await readYaml(parsed.args[0]!);
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "ImportServiceStack", bytes: yaml.length };
      const res = await ctx.api.call<{
        serviceStacks?: { id: string; name: string; processes?: { id: string }[] }[];
      }>("ImportServiceStack", { path: { id: projectId }, body: { yaml } });
      const processes = (res.serviceStacks ?? []).flatMap((s) => s.processes ?? []);
      const waited: unknown[] = [];
      for (const proc of processes) {
        waited.push(await settleProcess(ctx, proc, `service provisioning ${proc.id}`));
      }
      ctx.out.data({ services: res.serviceStacks ?? [], processes: waited });
    },
  },
];

export const projectEnvCommands: CommandSpec[] = [
  {
    path: ["project", "env", "list"],
    summary: "List project-level environment variables.",
    description: "Project variables are visible to every service. Service-scoped variables live under `zops env`.",
    operations: ["GetProjectEnvFile"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const project = await ctx.api.call<{ envVariables?: { id: string; key: string; content: string; sensitive?: boolean }[] }>(
        "GetProjectDetails",
        { path: { id: projectId } },
      );
      const vars = project.envVariables ?? [];
      ctx.out.data(vars, {
        columns: [
          { key: "key", header: "KEY" },
          { key: "content", header: "VALUE" },
          { key: "sensitive", header: "SENSITIVE" },
        ],
        quietField: "key",
        emptyMessage: "no project variables",
      });
    },
  },
  {
    path: ["project", "env", "set"],
    summary: "Create or update a project-level environment variable.",
    args: [
      { name: "key", description: "Variable name.", required: true },
      { name: "value", description: "Value, or '-' to read from stdin.", required: true },
    ],
    flags: [{ name: "sensitive", type: "boolean", description: "Store as a secret; the value is redacted on read." }],
    examples: ["zops project env set API_MODE production", "echo -n s3cr3t | zops project env set TOKEN - --sensitive"],
    operations: ["CreateProjectEnv", "UpdateProjectEnv"],
    async run(ctx, parsed) {
      const key = parsed.args[0]!;
      const value = parsed.args[1] === "-" ? (await Bun.stdin.text()).replace(/\n$/, "") : parsed.args[1]!;
      const projectId = await ctx.projectId();
      const sensitive = ctx.bool("sensitive");

      const project = await ctx.api.call<{ envVariables?: { id: string; key: string }[] }>("GetProjectDetails", {
        path: { id: projectId },
      });
      const existing = project.envVariables?.find((v) => v.key === key);

      if (ctx.dryRun) {
        return { dryRun: true, operation: existing ? "UpdateProjectEnv" : "CreateProjectEnv", key, sensitive };
      }

      if (existing) {
        const proc = await ctx.api.call<{ id: string }>("UpdateProjectEnv", {
          path: { id: existing.id },
          body: { content: value },
        });
        ctx.out.data(await settleProcess(ctx, proc, `updating project variable ${key}`));
        return;
      }
      const proc = await ctx.api.call<{ id: string }>("CreateProjectEnv", {
        path: { id: projectId },
        body: { key, content: value, sensitive },
      });
      ctx.out.data(await settleProcess(ctx, proc, `creating project variable ${key}`));
    },
  },
  {
    path: ["project", "env", "unset"],
    summary: "Delete a project-level environment variable.",
    destructive: true,
    args: [{ name: "key", description: "Variable name.", required: true }],
    operations: ["DeleteProjectEnv"],
    async run(ctx, parsed) {
      const key = parsed.args[0]!;
      const projectId = await ctx.projectId();
      const project = await ctx.api.call<{ envVariables?: { id: string; key: string }[] }>("GetProjectDetails", {
        path: { id: projectId },
      });
      const existing = project.envVariables?.find((v) => v.key === key);
      if (!existing) throw notFound(`project has no variable '${key}'`, "Run `zops project env list`.");
      await ctx.confirm(`delete project variable ${key}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteProjectEnv", key };
      const proc = await ctx.api.call<{ id: string }>("DeleteProjectEnv", { path: { id: existing.id } });
      ctx.out.data(await settleProcess(ctx, proc, `deleting project variable ${key}`));
    },
  },
  {
    path: ["project", "env", "import"],
    summary: "Replace the project's variables from a .env file.",
    description: `A wholesale replacement, not a merge: keys absent from the file are removed. Export first
with \`zops project env export\` if you mean to add to what is there.

Services keep the old values until they are restarted — a variable write alone does not
recreate running containers.`,
    destructive: true,
    args: [{ name: "file", description: "Path to a .env file, or '-' for stdin.", required: true }],
    examples: ["zops project env import .env.production --yes", "cat .env | zops project env import - --yes"],
    operations: ["UpdateProjectEnvFile"],
    async run(ctx, parsed) {
      const path = parsed.args[0]!;
      const envFile = path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8");
      const projectId = await ctx.projectId();
      await ctx.confirm(`replace every project variable from ${path}`);
      if (ctx.dryRun) return { dryRun: true, operation: "UpdateProjectEnvFile", bytes: envFile.length };
      const res = await ctx.api.call("UpdateProjectEnvFile", { path: { id: projectId }, body: { envFile } });
      ctx.out.data(await settleProcess(ctx, res, "replacing project variables"));
    },
  },
  {
    path: ["project", "env", "export"],
    summary: "Print the project env file as shell exports.",
    flags: [{ name: "user-only", type: "boolean", description: "Only user-defined variables, excluding generated ones." }],
    examples: ["eval \"$(zops project env export)\""],
    operations: ["GetProjectEnvFile"],
    async run(ctx) {
      const projectId = await ctx.projectId();
      const res = await ctx.api.call<{ envFile?: string } | string>("GetProjectEnvFile", {
        path: { id: projectId },
        query: { userOnly: ctx.bool("user-only") ? "1" : undefined },
      });
      const text = typeof res === "string" ? res : (res.envFile ?? "");
      if (ctx.out.json) {
        ctx.out.data({ envFile: text });
        return;
      }
      ctx.out.raw(text);
    },
  },
];
