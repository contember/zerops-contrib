/**
 * Access tokens.
 *
 * Two kinds, and picking the wrong one is a common mistake:
 *
 *   personal      acts as you, sees everything you see. Convenient locally, wrong for CI —
 *                 it outlives your employment and cannot be scoped down.
 *   integration   a machine identity owned by the organization, with an explicit role per
 *                 project. This is the shape CI and agents should use.
 *
 * Both are shown in full exactly once, at creation. The API stores a hash, so a lost token is
 * regenerated, never recovered.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { usage } from "../lib/errors.ts";

const ROLES = ["OWNER", "ADMIN", "BASIC_USER", "READ_ONLY", "NO_ACCESS"];

interface UserToken {
  id: string;
  name: string;
  created: string;
}

interface IntegrationToken {
  id: string;
  name: string;
  roleCode: string;
  created: string;
  canCreateProjects?: boolean;
  projects?: { projectId: string; roleCode: string }[];
}

/** `--project name=ROLE` pairs, resolved to ids so the caller never handles them. */
async function projectRoles(
  ctx: import("../lib/context.ts").Context,
): Promise<{ projectId: string; roleCode: string }[]> {
  const raw = ctx.flag<string[]>("project-role") ?? [];
  const out: { projectId: string; roleCode: string }[] = [];
  for (const entry of raw) {
    const eq = entry.lastIndexOf("=");
    if (eq === -1) throw usage(`--project-role expects <project>=<ROLE>, got ${JSON.stringify(entry)}`);
    const ref = entry.slice(0, eq);
    const roleCode = entry.slice(eq + 1).toUpperCase();
    if (!ROLES.includes(roleCode)) {
      throw usage(`unknown role ${JSON.stringify(roleCode)}`, `Valid roles: ${ROLES.join(", ")}.`);
    }
    const project = await ctx.resolveProject(ref);
    out.push({ projectId: project.id, roleCode });
  }
  return out;
}

export const tokenCommands: CommandSpec[] = [
  {
    path: ["token", "list"],
    summary: "List personal access tokens.",
    description: "Names and creation dates only — the token values themselves are not retrievable.",
    examples: ["zops token list", "zops token list --json"],
    operations: ["ListUserTokens"],
    async run(ctx) {
      const res = await ctx.api.call<{ list?: UserToken[]; items?: UserToken[] }>("ListUserTokens");
      ctx.out.data(res.list ?? res.items ?? [], {
        columns: [
          { key: "name", header: "NAME" },
          { key: "id", header: "ID" },
          { key: "created", header: "CREATED" },
        ],
        emptyMessage: "no personal access tokens",
      });
    },
  },
  {
    path: ["token", "get"],
    summary: "Show one personal access token's metadata.",
    args: [{ name: "token-id", description: "Token id (see `zops token list`).", required: true }],
    operations: ["GetUserToken"],
    async run(ctx, parsed) {
      ctx.out.data(await ctx.api.call("GetUserToken", { path: { id: parsed.args[0]! } }));
    },
  },
  {
    path: ["token", "create"],
    summary: "Create a personal access token and print it once.",
    description: `The value is returned only by this call and never again. With --quiet the token is the only
thing on stdout, which is the form to pipe into a secret store.

Prefer \`zops token integration create\` for anything unattended: a personal token carries your
full access and cannot be scoped to one project.`,
    args: [{ name: "name", description: "Label for the token, shown in the GUI.", required: true }],
    examples: [
      "zops token create ci-pipeline",
      "zops token create laptop -q | pass insert -e zerops/token",
    ],
    operations: ["CreateUserToken"],
    async run(ctx, parsed) {
      const name = parsed.args[0]!;
      if (ctx.dryRun) return { dryRun: true, operation: "CreateUserToken", name };
      const created = await ctx.api.call<UserToken & { token: string }>("CreateUserToken", {
        body: { name },
      });
      ctx.out.warn("this is the only time the token is shown");
      ctx.out.data(created, { quietField: "token" });
    },
  },
  {
    path: ["token", "rename"],
    summary: "Rename a personal access token.",
    args: [
      { name: "token-id", description: "Token id.", required: true },
      { name: "name", description: "New label.", required: true },
    ],
    operations: ["RenameUserToken"],
    async run(ctx, parsed) {
      const [id, name] = [parsed.args[0]!, parsed.args[1]!];
      if (ctx.dryRun) return { dryRun: true, operation: "RenameUserToken", id, name };
      ctx.out.data(await ctx.api.call("RenameUserToken", { path: { id }, body: { name } }));
    },
  },
  {
    path: ["token", "delete"],
    summary: "Revoke a personal access token.",
    destructive: true,
    args: [{ name: "token-id", description: "Token id.", required: true }],
    examples: ["zops token delete 3mKq8vNwQ1yTbXZs2LpAcd --yes"],
    operations: ["DeleteUserTokenById"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      await ctx.confirm(`revoke personal access token ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteUserTokenById", id };
      await ctx.api.call("DeleteUserTokenById", { path: { id } });
      ctx.out.step(`token ${id} revoked`);
      return { revoked: true, id };
    },
  },
  {
    path: ["token", "integration", "list"],
    summary: "List the organization's integration tokens.",
    examples: ["zops token integration list --json"],
    operations: ["listIntegrationTokens"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      const res = await ctx.api.call<{ list?: IntegrationToken[]; items?: IntegrationToken[] }>(
        "listIntegrationTokens",
        { path: { id: clientId } },
      );
      ctx.out.data(res.list ?? res.items ?? [], {
        columns: [
          { key: "name", header: "NAME" },
          { key: "id", header: "ID" },
          { key: "roleCode", header: "ROLE" },
          {
            key: "projects",
            header: "PROJECTS",
            get: (row: IntegrationToken) => (row.projects ?? []).map((p) => `${p.projectId}:${p.roleCode}`),
          },
          { key: "created", header: "CREATED" },
        ],
        emptyMessage: "no integration tokens",
      });
    },
  },
  {
    path: ["token", "integration", "create"],
    summary: "Create a project-scoped machine token and print it once.",
    description: `The recommended credential for CI and agents. Leaving the organization role at NO_ACCESS and
granting one project explicitly produces a token that can do nothing outside that project:

  zops token integration create ci --project-role myapp=BASIC_USER

Roles are tiered — OWNER > ADMIN > BASIC_USER > READ_ONLY > NO_ACCESS — and a project-level role
overrides the organization-level one. READ_ONLY is enough to read logs and configuration;
BASIC_USER is the lowest role that can deploy.

Note that such a token cannot list projects organization-wide; \`zops project list\` falls back to
the search endpoint to work around that.`,
    args: [{ name: "name", description: "Label for the token.", required: true }],
    flags: [
      { name: "role", type: "string", enum: ROLES, default: "NO_ACCESS", description: "Organization-wide role. Leave at NO_ACCESS and grant per project." },
      { name: "project-role", type: "string[]", placeholder: "<project>=<ROLE>", description: "Grant a role on one project. Repeatable; project may be a name or an id." },
      { name: "can-create-projects", type: "boolean", description: "Allow the token to create new projects, owning what it creates." },
    ],
    examples: [
      "zops token integration create ci --project-role myapp=BASIC_USER",
      "zops token integration create readonly-audit --project-role myapp=READ_ONLY -q",
    ],
    operations: ["createIntegrationToken"],
    async run(ctx, parsed) {
      const clientId = await ctx.clientId();
      const body = {
        name: parsed.args[0]!,
        roleCode: ctx.flag<string>("role") ?? "NO_ACCESS",
        canCreateProjects: ctx.bool("can-create-projects"),
        projects: await projectRoles(ctx),
      };
      if (ctx.dryRun) return { dryRun: true, operation: "createIntegrationToken", body };
      const created = await ctx.api.call<IntegrationToken & { token: string }>("createIntegrationToken", {
        path: { id: clientId },
        body,
      });
      ctx.out.warn("this is the only time the token is shown");
      ctx.out.data(created, { quietField: "token" });
    },
  },
  {
    path: ["token", "integration", "update"],
    summary: "Change an integration token's name or roles.",
    description: "Roles are replaced wholesale: project grants you do not pass are removed.",
    destructive: true,
    args: [{ name: "token-id", description: "Integration token id.", required: true }],
    flags: [
      { name: "name", type: "string", placeholder: "<name>", description: "New label. Required by the API, so it is re-sent unchanged when omitted." },
      { name: "role", type: "string", enum: ROLES, description: "Organization-wide role." },
      { name: "project-role", type: "string[]", placeholder: "<project>=<ROLE>", description: "Project grants, replacing the existing set. Repeatable." },
      { name: "can-create-projects", type: "boolean", description: "Allow the token to create new projects." },
    ],
    examples: ["zops token integration update 3mKq... --project-role myapp=READ_ONLY --yes"],
    operations: ["listIntegrationTokens", "updateIntegrationToken"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const clientId = await ctx.clientId();
      const res = await ctx.api.call<{ list?: IntegrationToken[]; items?: IntegrationToken[] }>(
        "listIntegrationTokens",
        { path: { id: clientId } },
      );
      const existing = (res.list ?? res.items ?? []).find((t) => t.id === id);

      const grants = ctx.flag<string[]>("project-role");
      const body = {
        name: ctx.flag<string>("name") ?? existing?.name ?? id,
        roleCode: ctx.flag<string>("role") ?? existing?.roleCode ?? "NO_ACCESS",
        canCreateProjects:
          ctx.flags["can-create-projects"] !== undefined
            ? ctx.bool("can-create-projects")
            : (existing?.canCreateProjects ?? false),
        projects: grants ? await projectRoles(ctx) : (existing?.projects ?? []),
      };

      await ctx.confirm(`update integration token ${body.name} (${id})`);
      if (ctx.dryRun) return { dryRun: true, operation: "updateIntegrationToken", id, body };
      ctx.out.data(await ctx.api.call("updateIntegrationToken", { path: { id: clientId, tokenId: id }, body }));
    },
  },
  {
    path: ["token", "integration", "regenerate"],
    summary: "Issue a new value for an integration token, invalidating the old one.",
    description: "The token keeps its id, name and roles; only the secret changes. Anything still using the old value breaks immediately.",
    destructive: true,
    args: [{ name: "token-id", description: "Integration token id.", required: true }],
    operations: ["regenerateIntegrationToken"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const clientId = await ctx.clientId();
      await ctx.confirm(`regenerate integration token ${id}, breaking every current user of it`);
      if (ctx.dryRun) return { dryRun: true, operation: "regenerateIntegrationToken", id };
      const rotated = await ctx.api.call<IntegrationToken & { token: string }>("regenerateIntegrationToken", {
        path: { id: clientId, tokenId: id },
      });
      ctx.out.warn("this is the only time the new token is shown");
      ctx.out.data(rotated, { quietField: "token" });
    },
  },
  {
    path: ["token", "integration", "delete"],
    summary: "Revoke an integration token.",
    destructive: true,
    args: [{ name: "token-id", description: "Integration token id.", required: true }],
    operations: ["deleteIntegrationToken"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      const clientId = await ctx.clientId();
      await ctx.confirm(`revoke integration token ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "deleteIntegrationToken", id };
      await ctx.api.call("deleteIntegrationToken", { path: { id: clientId, tokenId: id } });
      ctx.out.step(`integration token ${id} revoked`);
      return { revoked: true, id };
    },
  },
];
