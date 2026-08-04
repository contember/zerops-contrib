import type { CommandSpec } from "../lib/spec.ts";
import { saveUserConfig, userConfigPath } from "../lib/config.ts";
import { authError } from "../lib/errors.ts";

interface UserInfo {
  id: string;
  email: string;
  fullName: string;
  status: string;
  clientUserList?: {
    clientId: string;
    status: string;
    roleCode: string;
    canCreateProjects?: boolean;
    client?: { accountName?: string };
  }[];
}

/** Cheapest authenticated call that an application token is allowed to make. */
async function whoami(ctx: import("../lib/context.ts").Context): Promise<UserInfo> {
  ctx.requireToken();
  return ctx.api.call<UserInfo>("GetUserInfo");
}

export const authCommands: CommandSpec[] = [
  {
    path: ["auth", "login"],
    summary: "Store a personal access token for future commands.",
    description: `Writes the token to ${userConfigPath} with 0600 permissions and verifies it against the API.

Tokens are created in the Zerops GUI under Settings → Access Token Management. In CI, prefer
setting ZEROPS_TOKEN in the environment over calling this command — it needs no writable home
directory and leaves no credential on disk.`,
    args: [{ name: "token", description: "Personal access token. Use '-' to read it from stdin.", required: true }],
    examples: [
      "zops auth login zes1abc...",
      "cat token.txt | zops auth login -",
      "ZEROPS_TOKEN=zes1abc... zops service list   # no stored credential",
    ],
    operations: ["GetUserInfo"],
    async run(ctx, parsed) {
      const raw = parsed.args[0]!;
      const token = raw === "-" ? (await Bun.stdin.text()).trim() : raw;
      if (!token) throw authError("empty token");

      // Verify before persisting, so a typo fails here instead of on the next command.
      const probe = new (await import("../lib/http.ts")).ApiClient(ctx.config.apiUrl, token, ctx.out);
      const info = await probe.call<UserInfo>("GetUserInfo");

      if (ctx.dryRun) {
        ctx.out.info(`token is valid for ${info.email}; not saved (--dry-run)`);
        return { valid: true, saved: false, userId: info.id };
      }

      const path = saveUserConfig({ token, region: ctx.config.region });
      ctx.out.step(`token saved to ${path}`);
      return { valid: true, saved: true, path, userId: info.id, email: info.email };
    },
  },
  {
    path: ["auth", "logout"],
    summary: "Remove the stored access token.",
    operations: [],
    async run(ctx) {
      if (ctx.dryRun) return { removed: false, path: userConfigPath };
      saveUserConfig({ token: undefined });
      ctx.out.step(`token removed from ${userConfigPath}`);
      return { removed: true, path: userConfigPath };
    },
  },
  {
    path: ["auth", "status"],
    summary: "Show who the current token belongs to and where the configuration came from.",
    description: `Reports the resolved identity plus every configuration source that contributed, which is
the fastest way to diagnose "wrong project" and "unexpected permissions" problems.

Exits 3 when no token is configured or the token is rejected.`,
    examples: ["zops auth status", "zops auth status --json"],
    operations: ["GetUserInfo"],
    async run(ctx) {
      const info = await whoami(ctx);
      const membership = info.clientUserList?.find((c) => c.status === "ACTIVE") ?? info.clientUserList?.[0];
      const result = {
        userId: info.id,
        email: info.email,
        name: info.fullName,
        status: info.status,
        organizationId: membership?.clientId ?? null,
        organization: membership?.client?.accountName ?? null,
        role: membership?.roleCode ?? null,
        canCreateProjects: membership?.canCreateProjects ?? false,
        region: ctx.config.region,
        apiUrl: ctx.config.apiUrl,
        project: ctx.config.project ?? null,
        service: ctx.config.service ?? null,
        configSources: ctx.config.sources,
      };
      return result;
    },
  },
  {
    path: ["region", "list"],
    summary: "List the API regions this account can reach.",
    operations: ["GetRegions"],
    async run(ctx) {
      const res = await ctx.api.call<{ items?: { name: string; isDefault: boolean; address: string }[] }>(
        "GetRegions",
      );
      return res.items ?? [];
    },
  },
];
