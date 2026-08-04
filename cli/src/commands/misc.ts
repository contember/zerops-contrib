/**
 * Commands that exist specifically because an agent needs them.
 *
 * `catalog` answers "what is a valid service type string" without guessing. `validate` checks a
 * zerops.yaml before a five-minute build fails on a typo. `status` is a single call that
 * describes the whole project, so an agent can orient itself in one turn instead of six.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandSpec } from "../lib/spec.ts";
import { usage } from "../lib/errors.ts";
import type { ServiceSummary } from "../lib/context.ts";

interface StackTypeVersion {
  name: string;
  status?: string;
  serviceStackTypeVersionName?: string;
}

interface StackType {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  docsUrl?: string;
  serviceStackTypeVersionList?: StackTypeVersion[];
}

export const miscCommands: CommandSpec[] = [
  {
    path: ["catalog"],
    summary: "List available service types and their version strings.",
    description: `The authoritative source for the \`type:\` values an import YAML accepts, and for the \`base:\`
values zerops.yaml accepts. Reading it beats guessing whether the string is postgresql@18,
postgresql:16 or postgres@18.`,
    flags: [
      { name: "search", type: "string", placeholder: "<substring>", description: "Only types whose name or id contains this." },
      { name: "category", type: "string", placeholder: "<category>", description: "Filter by category, e.g. USER or DB." },
    ],
    examples: [
      "zz catalog",
      "zz catalog --search postgres",
      "zz catalog --json | jq -r '.[].versions[]'",
    ],
    operations: ["GetSettings"],
    async run(ctx) {
      const settings = await ctx.api.call<{ serviceStackList?: StackType[] }>("GetSettings");
      let types = settings.serviceStackList ?? [];

      const search = ctx.flag<string>("search")?.toLowerCase();
      if (search) {
        types = types.filter((t) => `${t.id} ${t.name}`.toLowerCase().includes(search));
      }
      const category = ctx.flag<string>("category")?.toUpperCase();
      if (category) types = types.filter((t) => t.category === category);

      const rows = types.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        versions: (t.serviceStackTypeVersionList ?? [])
          .filter((v) => v.status === undefined || v.status === "ACTIVE")
          .map((v) => v.name),
      }));

      ctx.out.data(rows, {
        columns: [
          { key: "id", header: "ID" },
          { key: "name", header: "NAME" },
          { key: "category", header: "CATEGORY" },
          { key: "versions", header: "VERSIONS" },
        ],
        quietField: "id",
        emptyMessage: "no service types matched",
      });
    },
  },
  {
    path: ["validate"],
    summary: "Validate a zerops.yaml against the live API before pushing.",
    description: `Runs the same check the platform runs at the start of a deploy, so a typo costs a second
instead of a failed pipeline. Exits 0 when the file is accepted.

Needs a target service, because validation depends on the service's type and version.`,
    args: [{ name: "file", description: "Path to zerops.yaml. Defaults to ./zerops.yaml." }],
    flags: [
      { name: "setup", type: "string", placeholder: "<name>", description: "Which setup: block to validate. Defaults to the service hostname." },
      { name: "operation", type: "string", enum: ["DEPLOY", "BUILD_AND_DEPLOY"], default: "BUILD_AND_DEPLOY", description: "Which pipeline the file will drive." },
    ],
    examples: ["zz validate -S api", "zz validate ./apps/web/zerops.yaml -S web --setup web"],
    operations: ["ValidateZeropsYaml"],
    async run(ctx, parsed) {
      const path = parsed.args[0]
        ? resolve(parsed.args[0])
        : ["zerops.yaml", "zerops.yml"].map((n) => join(process.cwd(), n)).find((p) => existsSync(p));
      if (!path || !existsSync(path)) {
        throw usage("no zerops.yaml found", "Pass the path explicitly: `zz validate path/to/zerops.yaml`.");
      }

      const yamlText = await readFile(path, "utf8");
      const service = await ctx.service();
      const setup = ctx.flag<string>("setup") ?? service.name;

      await ctx.api.call("ValidateZeropsYaml", {
        body: {
          serviceStackName: service.name,
          serviceStackTypeId: service.serviceStackTypeId,
          serviceStackTypeVersionName: service.serviceStackTypeInfo?.serviceStackTypeVersionName,
          zeropsYaml: yamlText,
          zeropsYamlSetup: setup,
          operation: ctx.flag<string>("operation") ?? "BUILD_AND_DEPLOY",
        },
      });

      ctx.out.step(`${path} is valid for ${service.name} (setup: ${setup})`);
      ctx.out.data({ valid: true, file: path, service: service.name, setup });
    },
  },
  {
    path: ["status"],
    summary: "One-shot snapshot of the project: services, health, versions, routes.",
    description: `Everything an agent needs to orient itself, in a single command. Useful as the first call in
a session and as the check after a deploy.`,
    examples: ["zz status", "zz status --json"],
    operations: ["GetProjectDetails", "ListProjectServiceStacks", "ListProjectPublicHttpRoutings", "ListProjectProcesses"],
    async run(ctx) {
      const project = await ctx.project();
      const [services, routes, processes] = await Promise.all([
        ctx.listServices(),
        ctx.api
          .call<{ items?: { domains?: { domainName: string }[]; locations?: { serviceStackId: string }[] }[]; list?: unknown[] }>(
            "ListProjectPublicHttpRoutings",
            { path: { id: project.id } },
          )
          .catch(() => ({ items: [] })),
        ctx.api
          .call<{ items?: { id: string; status: string; actionName: string }[] }>("ListProjectProcesses", {
            path: { id: project.id },
            query: { limit: 5 },
          })
          .catch(() => ({ items: [] })),
      ]);

      const routeItems = (routes.items ?? []) as { domains?: { domainName: string }[]; locations?: { serviceStackId: string }[] }[];
      const domainsFor = (serviceId: string) =>
        routeItems
          .filter((r) => r.locations?.some((l) => l.serviceStackId === serviceId))
          .flatMap((r) => r.domains?.map((d) => d.domainName) ?? []);

      const rows = services.map((s: ServiceSummary) => ({
        name: s.name,
        status: s.status,
        type: s.serviceStackTypeInfo?.serviceStackTypeVersionName ?? s.serviceStackTypeVersionId ?? "-",
        subdomain: (s.subdomainAccessUrl as string | undefined) ?? null,
        domains: domainsFor(s.id),
        id: s.id,
      }));

      const running = (processes.items ?? []).filter((p) => p.status === "RUNNING" || p.status === "PENDING");

      if (ctx.out.json) {
        ctx.out.data({
          project: { id: project.id, name: project.name, status: project.status, mode: project.mode },
          services: rows,
          runningProcesses: running,
          recentProcesses: processes.items ?? [],
        });
        return;
      }

      ctx.out.info(`project ${project.name} (${project.status}, ${project.mode})`);
      ctx.out.data(rows, {
        columns: [
          { key: "name", header: "SERVICE" },
          { key: "status", header: "STATUS" },
          { key: "type", header: "TYPE" },
          { key: "domains", header: "DOMAINS" },
          { key: "subdomain", header: "SUBDOMAIN" },
        ],
        emptyMessage: "no services",
      });
      if (running.length > 0) {
        ctx.out.warn(`${running.length} operation(s) still running: ${running.map((p) => p.actionName).join(", ")}`);
      }
    },
  },
  {
    path: ["schema"],
    summary: "Print the JSON Schema for zerops.yaml or the import YAML.",
    description: `The machine-readable contract behind both file formats, served by the platform itself and
therefore always current. Two uses:

  - point an editor at it (\`yaml.schemas\` in VS Code) to get completion and inline errors
  - hand it to an agent that is about to write one of these files, instead of letting it guess

\`zz validate\` remains the stronger check for zerops.yaml, because it also resolves the target
service's type and version. The schema catches shape errors without a service.`,
    args: [
      {
        name: "kind",
        description: "Which schema: 'zerops' for zerops.yaml, 'import' for the project import YAML.",
        required: true,
      },
    ],
    examples: [
      "zz schema zerops > zerops-schema.json",
      "zz schema import | jq '.properties.services'",
    ],
    operations: ["GetZeropsYamlJsonSchema", "GetImportProjectYamlJsonSchema"],
    async run(ctx, parsed) {
      const kind = parsed.args[0]!.toLowerCase();
      const operation = { zerops: "GetZeropsYamlJsonSchema", import: "GetImportProjectYamlJsonSchema" }[kind];
      if (!operation) {
        throw usage(`unknown schema ${JSON.stringify(kind)}`, "Use 'zerops' or 'import'.");
      }
      const schema = await ctx.api.call<unknown>(operation);
      // Always a document rather than a table: this is JSON meant to be piped, not read.
      ctx.out.raw(typeof schema === "string" ? schema : JSON.stringify(schema, null, 2));
    },
  },
];
