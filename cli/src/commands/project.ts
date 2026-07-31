import { readFile } from "node:fs/promises";
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { EXIT, ZzError, notFound } from "../lib/errors.ts";
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
    examples: ["zz project list", "zz project list --json", "zz project list -q   # bare names"],
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
        if (!(err instanceof ZzError) || err.exitCode !== EXIT.AUTH) throw err;
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
    examples: ["zz project get myapp", "zz project get --json"],
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
import YAML and use \`zz project import\` instead — that is the normal path.`,
    flags: [
      { name: "name", type: "string", required: true, placeholder: "<name>", description: "Project name." },
      { name: "mode", type: "string", enum: ["LIGHT", "SERIOUS"], default: "LIGHT", description: "LIGHT is single-container core; SERIOUS is the HA core." },
      { name: "description", type: "string", placeholder: "<text>", description: "Free-text description." },
      { name: "tag", type: "string[]", placeholder: "<tag>", description: "Attach a tag. Repeatable." },
      { name: "env-isolation", type: "string", enum: ["none", "service"], description: "Environment variable visibility between services." },
      { name: "location", type: "string", placeholder: "<id>", description: "Preferred location id." },
    ],
    examples: ["zz project create --name myapp --mode LIGHT"],
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
    examples: ["zz project import zerops-import.yaml", "cat import.yaml | zz project import -"],
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
    description: "Round-trips through `zz project import`, which makes it the supported way to clone an environment.",
    args: [{ name: "project", description: "Project name or id. Defaults to --project." }],
    examples: ["zz project export myapp > import.yaml"],
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
    examples: ["zz project delete throwaway --yes", "zz project delete throwaway --dry-run"],
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
    path: ["project", "service-import"],
    summary: "Add services to an existing project from an import YAML.",
    args: [{ name: "file", description: "Path to the services YAML, or '-' for stdin.", required: true }],
    examples: ["zz project service-import add-redis.yaml -P myapp"],
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
    description: "Project variables are visible to every service. Service-scoped variables live under `zz env`.",
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
    examples: ["zz project env set API_MODE production", "echo -n s3cr3t | zz project env set TOKEN - --sensitive"],
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
      if (!existing) throw notFound(`project has no variable '${key}'`, "Run `zz project env list`.");
      await ctx.confirm(`delete project variable ${key}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteProjectEnv", key };
      const proc = await ctx.api.call<{ id: string }>("DeleteProjectEnv", { path: { id: existing.id } });
      ctx.out.data(await settleProcess(ctx, proc, `deleting project variable ${key}`));
    },
  },
  {
    path: ["project", "env", "export"],
    summary: "Print the project env file as shell exports.",
    flags: [{ name: "user-only", type: "boolean", description: "Only user-defined variables, excluding generated ones." }],
    examples: ["eval \"$(zz project env export)\""],
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
