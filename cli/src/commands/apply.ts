/**
 * Declarative convergence for an import YAML.
 *
 * The platform's import is create-only: re-importing a file does not update the
 * services it describes, and `override: true` *replaces* a runtime service and
 * forces a redeploy. A versioned infrastructure file is therefore a bootstrap
 * script rather than a declaration of state, and it starts drifting the first
 * time somebody changes scaling in the GUI.
 *
 * `zops apply` closes the cheap half of that gap: it reads the declaration, reads
 * what is actually there, and reconciles the fields the API can safely change
 * in place. Everything it cannot converge — a changed service type, an HA
 * variant, a service nobody declared — is *reported*, never silently ignored
 * and never destroyed. Nothing here deletes anything.
 *
 * Secrets are create-only on purpose. Re-applying a file whose `envSecrets`
 * generate random values must not rotate the session secret or the database
 * password out from under a running app, so an existing key is left alone.
 */
import { readFile } from "node:fs/promises";
import type { CommandSpec } from "../lib/spec.ts";
import type { Context, ServiceSummary } from "../lib/context.ts";
import { settleProcess } from "../lib/process.ts";
import { EXIT, ZopsError, usage } from "../lib/errors.ts";
import {
  autoscalingBody,
  checkLimits,
  describeChanges,
  hasContainerRange,
  verifyAutoscaling,
  type AutoscalingChanges,
  type AutoscalingRequest,
  type ServiceAutoscaling,
} from "../lib/autoscaling.ts";

interface DeclaredService {
  hostname?: string;
  type?: string;
  enableSubdomainAccess?: boolean;
  minContainers?: number;
  maxContainers?: number;
  objectStorageSize?: number;
  envSecrets?: Record<string, string>;
  verticalAutoscaling?: {
    cpuMode?: string;
    minCpu?: number;
    maxCpu?: number;
    minRam?: number;
    maxRam?: number;
    minDisk?: number;
    maxDisk?: number;
    startCpuCoreCount?: number;
  };
  [key: string]: unknown;
}

interface Declaration {
  project?: { name?: string; [key: string]: unknown };
  services?: DeclaredService[];
}

interface UserData {
  id: string;
  key: string;
  serviceStackId: string;
}

/** One reconciliation step: something to do, or something only to report. */
interface Action {
  service: string;
  kind: string;
  detail: string;
  /** The request body, where there is one: shown by `--dry-run --json` so the plan can be checked. */
  body?: unknown;
  /** Absent means this is drift the platform cannot converge in place. */
  apply?: (ctx: Context) => Promise<unknown>;
}

// --- YAML emission ---------------------------------------------------------

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\t": "\\t",
  "\r": "\\r",
};

/**
 * Emits a value back to YAML for a partial import.
 *
 * Preprocessor expressions survive because they are ordinary text at this stage
 * — the platform expands them on receipt, before its own parse. Multi-line
 * values become block scalars, which is what the key-generating functions need.
 */
export function emitYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const body = value
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `${pad}  ${line}`)
        .join("\n");
      return `|\n${body}`;
    }
    return `"${value.replace(/[\\"\t\r]/g, (c) => DOUBLE_QUOTE_ESCAPES[c]!)}"`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => `\n${pad}- ${emitYaml(item, indent + 1).replace(/^\s+/, "")}`)
      .join("");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries
    .map(([key, item]) => {
      const rendered = emitYaml(item, indent + 1);
      const inline = typeof item === "object" && item !== null && !Array.isArray(item)
        ? `\n${"  ".repeat(indent + 1)}${rendered.replace(/^\s+/, "")}`
        : ` ${rendered}`;
      return `${pad}${key}:${Array.isArray(item) ? rendered : inline}`;
    })
    .join("\n");
}

export function servicesDocument(services: DeclaredService[], preprocessor: boolean): string {
  const header = preprocessor ? "#yamlPreprocessor=on\n" : "";
  // Rendered two levels deep so every line already sits at the four spaces a
  // list item's body needs; only the first line's marker is swapped in.
  const items = services.map((service) => `  -${emitYaml(service, 2).slice(3)}`);
  return `${header}services:\n${items.join("\n")}\n`;
}

// --- reconciliation --------------------------------------------------------

const actualType = (service: ServiceSummary): string =>
  service.serviceStackTypeInfo?.serviceStackTypeVersionName ?? "";

/**
 * `null` when the platform will not answer yet. A service that has never been
 * deployed rejects this endpoint with `serviceStackNotFound` even though the
 * service plainly exists — its variables are simply not readable before the
 * first deploy, and an apply must not fail over a check it cannot make.
 */
async function listUserData(ctx: Context, serviceId: string): Promise<UserData[] | null> {
  try {
    const res = await ctx.api.call<{ items?: UserData[]; list?: UserData[] }>(
      "ListServiceStackUserData",
      { path: { id: serviceId }, query: { limit: 1000 } },
    );
    return res.items ?? res.list ?? [];
  } catch (err) {
    if (err instanceof ZopsError && err.code === "serviceStackNotFound") return null;
    throw err;
  }
}

/**
 * The platform expands a bare runtime type to a concrete image, so a service
 * declared as `bun@1.3.9` comes back as `ubuntu/bun@1.3.9`. Only a declaration
 * that names an OS itself is held to that part.
 */
function typeMatches(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  return !declared.includes("/") && actual.endsWith(`/${declared}`);
}

/**
 * The declared scaling as changes to the service's current configuration. The
 * endpoint replaces the whole custom block, so the body is built complete by
 * `lib/autoscaling.ts`, the same way `zops scale set` builds it.
 */
export function declaredScaling(declared: DeclaredService): AutoscalingChanges {
  const vertical = declared.verticalAutoscaling ?? {};
  const changes: AutoscalingChanges = {
    minCpu: vertical.minCpu,
    maxCpu: vertical.maxCpu,
    minRamGB: vertical.minRam,
    maxRamGB: vertical.maxRam,
    minDiskGB: vertical.minDisk,
    maxDiskGB: vertical.maxDisk,
    cpuMode: vertical.cpuMode,
    startCpuCoreCount: vertical.startCpuCoreCount,
    minContainers: declared.minContainers,
    maxContainers: declared.maxContainers,
  };
  for (const key of Object.keys(changes) as (keyof AutoscalingChanges)[]) {
    if (changes[key] === undefined) delete changes[key];
  }
  return changes;
}

/** The body to send and what it changes; no body when the declaration already holds. */
export function scalingPlan(
  declared: DeclaredService,
  actual: ServiceAutoscaling,
): { body: AutoscalingRequest; changes: string[] } | null {
  const wanted = declaredScaling(declared);
  // A managed service's count is fixed by its :single / :ha type and it reports no range, so a
  // declared count is neither compared nor sent: otherwise every run would plan it again.
  if (!hasContainerRange(actual)) {
    delete wanted.minContainers;
    delete wanted.maxContainers;
  }
  if (Object.keys(wanted).length === 0) return null;
  const body = autoscalingBody(actual, wanted);
  const changes = describeChanges(body, actual);
  if (changes.length === 0) return null;
  checkLimits(body);
  return { body, changes };
}

async function reconcileService(
  ctx: Context,
  declared: DeclaredService,
  actual: ServiceSummary,
): Promise<Action[]> {
  const actions: Action[] = [];
  const hostname = declared.hostname!;

  const declaredType = declared.type;
  const currentType = actualType(actual);
  if (declaredType !== undefined && currentType !== "" && !typeMatches(declaredType, currentType)) {
    actions.push({
      service: hostname,
      kind: "drift:type",
      detail: `declared ${declaredType}, running ${currentType} — the type is fixed at creation; migrate the data and replace the service`,
    });
  }

  if (
    declared.enableSubdomainAccess !== undefined
    && declared.enableSubdomainAccess !== Boolean(actual.subdomainAccess)
  ) {
    const enable = declared.enableSubdomainAccess;
    actions.push({
      service: hostname,
      kind: enable ? "subdomain:enable" : "subdomain:disable",
      detail: `subdomain access ${Boolean(actual.subdomainAccess)} → ${enable}`,
      apply: async (c) => {
        const proc = await c.api.call<{ id: string }>(
          enable ? "EnableSubdomainAccess" : "DisableSubdomainAccess",
          { path: { id: actual.id } },
        );
        return settleProcess(c, proc, `${enable ? "enabling" : "disabling"} subdomain on ${hostname}`);
      },
    });
  }

  let scaling: ReturnType<typeof scalingPlan> = null;
  try {
    scaling = scalingPlan(declared, actual as ServiceAutoscaling);
  } catch (err) {
    if (!(err instanceof ZopsError)) throw err;
    actions.push({ service: hostname, kind: "drift:scale", detail: `declared scaling is not valid: ${err.message}` });
  }
  if (scaling) {
    const { body, changes } = scaling;
    actions.push({
      service: hostname,
      kind: "scale",
      detail: changes.join(", "),
      body,
      apply: async (c) => {
        const proc = await c.api.call<{ id: string }>("ConfigureAutoscaling", {
          path: { id: actual.id },
          body,
        });
        const settled = await settleProcess(c, proc, `rescaling ${hostname}`);
        if (c.wait) await verifyAutoscaling(c, actual.id, hostname, body);
        return settled;
      },
    });
  }

  if (declared.objectStorageSize !== undefined) {
    const size = await currentObjectStorageSize(ctx, actual.id);
    if (size !== null && size !== declared.objectStorageSize) {
      actions.push({
        service: hostname,
        kind: "object-storage-size",
        detail: `${size} GB → ${declared.objectStorageSize} GB`,
        apply: async (c) => c.api.call("UpdateObjectStorageSize", {
          path: { id: actual.id },
          body: { quotaGBytes: declared.objectStorageSize },
        }),
      });
    }
  }

  const secrets = declared.envSecrets ?? {};
  const declaredKeys = Object.keys(secrets);
  const currentUserData = declaredKeys.length > 0 ? await listUserData(ctx, actual.id) : [];
  if (currentUserData === null) {
    actions.push({
      service: hostname,
      kind: "secrets:unreadable",
      detail: "variables are not readable until the first deploy — declared secrets left as imported",
    });
  } else if (declaredKeys.length > 0) {
    const existing = new Set(currentUserData.map((v) => v.key));
    for (const key of declaredKeys) {
      if (existing.has(key)) continue;
      actions.push({
        service: hostname,
        kind: "secret:create",
        // The value is not printed: it is either a generated secret or a literal
        // one, and neither belongs in a plan an agent will paste somewhere.
        detail: `${key} is declared but missing`,
        apply: async (c) => c.api.call("CreateUserData", {
          path: { id: actual.id },
          body: { key, content: secrets[key]!, isSensitive: true },
        }),
      });
    }
  }

  return actions;
}

const actionRow = (action: Action): { service: string; kind: string; detail: string } => ({
  service: action.service,
  kind: action.kind,
  detail: action.detail,
});

/** `null` when the service has no object storage to size. */
async function currentObjectStorageSize(ctx: Context, serviceId: string): Promise<number | null> {
  try {
    const res = await ctx.api.call<{ quotaGBytes?: number }>("GetObjectStorageSize", {
      path: { id: serviceId },
    });
    return res.quotaGBytes ?? null;
  } catch (err) {
    if (err instanceof ZopsError && err.exitCode === EXIT.NOT_FOUND) return null;
    throw err;
  }
}

export const applyCommands: CommandSpec[] = [
  {
    path: ["apply"],
    summary: "Converge a project onto a declared import YAML, creating and updating in place.",
    description: `Reads an import YAML, reads the project as it actually is, and reconciles the two.

  create     services in the file that do not exist yet — one import call, so the
             platform still expands \`<@generateRandomString(…)>\` and friends
  converge   min/max containers, vertical autoscaling, subdomain access,
             object storage size
  create     declared \`envSecrets\` keys that are missing
  report     everything else: a changed \`type\`, services nobody declared

Nothing is ever deleted, and an existing secret is never overwritten — re-applying a file
with generated secrets does not rotate them out from under a running app. Use
\`zops env set\` to change one deliberately.

Run it with --dry-run first: the plan is the same in both modes, only the execution differs.`,
    flags: [
      {
        name: "file",
        short: "f",
        type: "string",
        required: true,
        placeholder: "<path>",
        description: "Import YAML to converge onto, or '-' for stdin.",
      },
      {
        name: "create-project",
        type: "boolean",
        default: true,
        description: "Create the project when it does not exist. --no-create-project fails instead.",
      },
    ],
    examples: [
      "zops apply -f zerops-import.yaml --dry-run",
      "zops apply -f zerops-import.yaml -P mkl-test",
      "zops apply -f zerops-import.yaml --json",
    ],
    operations: [
      "ImportProject",
      "ImportServiceStack",
      "ListProjectServiceStacks",
      "ConfigureAutoscaling",
      "EnableSubdomainAccess",
      "DisableSubdomainAccess",
      "GetObjectStorageSize",
      "UpdateObjectStorageSize",
      "ListServiceStackUserData",
      "CreateUserData",
    ],
    async run(ctx) {
      const file = ctx.flag<string>("file")!;
      const text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
      const preprocessor = text.startsWith("#yamlPreprocessor=on");

      let declaration: Declaration;
      try {
        declaration = (Bun.YAML.parse(text) ?? {}) as Declaration;
      } catch (err) {
        throw usage(
          `${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const declared = declaration.services ?? [];
      for (const service of declared) {
        if (!service.hostname) throw usage(`${file}: every service needs a hostname`);
        if (!service.type) throw usage(`${file}: service ${service.hostname} has no type`);
      }

      // Resolving by explicit target first keeps the file's `project.name` from
      // silently pointing an apply at a different project than the caller meant.
      const target = ctx.config.project ?? declaration.project?.name;
      if (!target) {
        throw usage(
          "no project to apply to",
          "Pass --project <name|id>, set ZEROPS_PROJECT, or give the file a project.name.",
        );
      }

      let project;
      try {
        project = await ctx.resolveProject(target);
      } catch (err) {
        if (!(err instanceof ZopsError) || err.exitCode !== EXIT.NOT_FOUND) throw err;
        if (!declaration.project) {
          throw usage(
            `no project named '${target}' and ${file} has no project: block to create one`,
          );
        }
        if (ctx.flags["create-project"] === false) {
          throw usage(`no project named '${target}' and --no-create-project was given`);
        }
        if (ctx.dryRun) {
          ctx.out.data({ dryRun: true, plan: [{ service: "-", kind: "project:create", detail: target }] });
          return;
        }
        const clientId = await ctx.clientId();
        const res = await ctx.api.call<{
          projectId?: string;
          serviceStacks?: { id: string; name: string; processes?: { id: string }[] }[];
        }>("ImportProject", { path: { id: clientId }, body: { yaml: text } });
        ctx.out.step(`project ${target} created (${res.projectId ?? "?"})`);
        for (const proc of (res.serviceStacks ?? []).flatMap((s) => s.processes ?? [])) {
          await settleProcess(ctx, proc, `service provisioning ${proc.id}`);
        }
        ctx.out.data({ project: res.projectId, created: (res.serviceStacks ?? []).map((s) => s.name) });
        return;
      }

      const actual = await ctx.api.call<{ items?: ServiceSummary[]; list?: ServiceSummary[] }>(
        "ListProjectServiceStacks",
        { path: { id: project.id }, query: { limit: 1000 } },
      );
      const existing = new Map(
        (actual.items ?? actual.list ?? []).map((s) => [s.name, s] as const),
      );

      const missing = declared.filter((s) => !existing.has(s.hostname!));
      const actions: Action[] = [];

      if (missing.length > 0) {
        const document = servicesDocument(missing, preprocessor);
        actions.push({
          service: missing.map((s) => s.hostname!).join(", "),
          kind: "create",
          detail: missing.map((s) => `${s.hostname} (${s.type})`).join(", "),
          apply: async (c) => {
            const res = await c.api.call<{
              serviceStacks?: { id: string; name: string; processes?: { id: string }[] }[];
            }>("ImportServiceStack", { path: { id: project.id }, body: { yaml: document } });
            for (const proc of (res.serviceStacks ?? []).flatMap((s) => s.processes ?? [])) {
              await settleProcess(c, proc, `service provisioning ${proc.id}`);
            }
            return { created: (res.serviceStacks ?? []).map((s) => s.name) };
          },
        });
      }

      for (const service of declared) {
        const found = existing.get(service.hostname!);
        if (found) actions.push(...await reconcileService(ctx, service, found));
      }

      // Never deleted, only surfaced: an undeclared service is as likely to be
      // something deliberate as it is to be leftovers.
      for (const [name, service] of existing) {
        if (service.isSystem === true) continue;
        if (declared.some((s) => s.hostname === name)) continue;
        actions.push({
          service: name,
          kind: "drift:undeclared",
          detail: `running ${actualType(service)} but not present in ${file}`,
        });
      }

      const convergeable = actions.filter((a) => a.apply !== undefined);
      const drift = actions.filter((a) => a.apply === undefined);

      if (ctx.dryRun) {
        ctx.out.data(
          actions.map(({ service, kind, detail, body }) => ({
            service,
            kind,
            detail,
            ...(body === undefined ? {} : { body }),
            applied: false,
          })),
          {
            columns: [
              { key: "service", header: "SERVICE" },
              { key: "kind", header: "ACTION" },
              { key: "detail", header: "DETAIL" },
            ],
            emptyMessage: "already converged",
          },
        );
        return;
      }

      // One blocked field must not abandon the rest: some changes are only
      // possible in a particular order (a subdomain needs a deployed HTTP port),
      // so a failure is recorded and the remaining actions still run.
      const results: {
        service: string;
        kind: string;
        detail: string;
        status: "applied" | "failed" | "drift";
        error?: string;
      }[] = [];
      let failures = 0;
      for (const action of convergeable) {
        ctx.out.info(`${action.service}: ${action.kind} — ${action.detail}`);
        try {
          await action.apply?.(ctx);
          results.push({ ...actionRow(action), status: "applied" });
        } catch (err) {
          failures += 1;
          const message = err instanceof Error ? err.message : String(err);
          ctx.out.warn(`${action.service}: ${action.kind} failed — ${message}`);
          results.push({ ...actionRow(action), status: "failed", error: message });
        }
      }
      for (const item of drift) {
        ctx.out.warn(`${item.service}: ${item.detail}`);
        results.push({ ...actionRow(item), status: "drift" });
      }

      ctx.out.data(results, {
        columns: [
          { key: "service", header: "SERVICE" },
          { key: "kind", header: "ACTION" },
          { key: "detail", header: "DETAIL" },
          { key: "status", header: "STATUS" },
        ],
        emptyMessage: "already converged",
      });

      if (failures > 0) {
        throw new ZopsError({
          code: "applyIncomplete",
          message: `${failures} of ${convergeable.length} changes could not be applied`,
          exitCode: EXIT.REMOTE_FAILED,
          hint: "Re-run after the blocking condition clears — a subdomain, for instance, needs a deployed HTTP port.",
        });
      }
    },
  },
];
