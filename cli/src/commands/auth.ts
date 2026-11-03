import type { CommandSpec } from "../lib/spec.ts";
import {
  readUserConfig,
  runTokenCommand,
  saveUserConfig,
  updateUserConfig,
  userConfigPath,
} from "../lib/config.ts";
import { authError, notFound, usage } from "../lib/errors.ts";

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
    summary: "Store an access token, or a command that prints one, for future commands.",
    description: `Verifies the token against the API, then writes it to ${userConfigPath} with 0600
permissions. When a profile is in effect (--profile, ZEROPS_PROFILE or \`zops profile use\`) the
token goes into that profile, creating it if needed; otherwise into the top-level setting. The
first profile created becomes the selected one when nothing else is configured. --project,
--service and --region typed on this command line are stored alongside as defaults.

--token-command stores a shell command that prints the token instead of the token itself, so
the secret stays in the keychain or password manager. zops runs it whenever a command needs the
token. A Zerops token belongs to exactly one organization: use one profile per organization.

Tokens are created in the Zerops GUI under Settings → Access Token Management. In CI, prefer
setting ZEROPS_TOKEN in the environment over calling this command — it needs no writable home
directory and leaves no credential on disk.`,
    args: [
      {
        name: "token",
        description: "Personal access token. Use '-' to read it from stdin. Omit when passing --token-command.",
      },
    ],
    flags: [
      {
        name: "token-command",
        type: "string",
        placeholder: "<cmd>",
        description: "Store this shell command, which must print the token on stdout, instead of the token.",
      },
    ],
    examples: [
      "zops auth login zes1abc...",
      "cat token.txt | zops auth login -",
      "zops auth login --profile acme --token-command 'security find-generic-password -s zerops-acme -w'",
      "zops auth login --profile acme --project shop --token-command 'op read op://vault/zerops-acme/token'",
      "ZEROPS_TOKEN=zes1abc... zops service list   # no stored credential",
    ],
    operations: ["GetUserInfo"],
    async run(ctx, parsed) {
      const command = ctx.flag<string>("token-command");
      const raw = parsed.args[0];
      if (command && raw) throw usage("pass either <token> or --token-command, not both");
      if (!command && !raw) {
        throw usage("auth login requires <token> or --token-command", "Run `zops auth login --help`.");
      }
      const profile = ctx.config.profile;
      const token = command
        ? runTokenCommand(command, profile)
        : raw === "-"
          ? (await Bun.stdin.text()).trim()
          : raw!;
      if (!token) throw authError("empty token");

      // Verify before persisting, so a typo fails here instead of on the next command.
      const probe = new (await import("../lib/http.ts")).ApiClient(ctx.config.apiUrl, token, ctx.out);
      const info = await probe.call<UserInfo>("GetUserInfo");

      if (ctx.dryRun) {
        ctx.out.info(`token is valid for ${info.email}; not saved (--dry-run)`);
        return { valid: true, saved: false, profile: profile ?? null, userId: info.id };
      }

      const credential = command ? { token: undefined, tokenCommand: command } : { token, tokenCommand: undefined };
      // Only values typed on this command line are stored; an ambient ZEROPS_PROJECT or a repo's
      // .zops.json belongs to the shell or the repo, not to the saved setup.
      const typed = (name: "region" | "project" | "service") =>
        parsed.fromEnv?.has(name) ? undefined : (parsed.flags[name] as string | undefined);
      let selected = false;
      const path = profile
        ? updateUserConfig((config) => {
            const existing = Object.hasOwn(config.profiles ?? {}, profile) ? config.profiles![profile]! : {};
            config.profiles = {
              ...config.profiles,
              [profile]: {
                ...existing,
                ...credential,
                region: typed("region") ?? existing.region,
                project: typed("project") ?? existing.project,
                service: typed("service") ?? existing.service,
              },
            };
            if (!config.profile && !config.token && !config.tokenCommand) {
              config.profile = profile;
              selected = true;
            }
          })
        : saveUserConfig({ ...credential, ...(typed("region") ? { region: typed("region") } : {}) });
      ctx.out.step(
        `${command ? "token command" : "token"} saved to ${path}${profile ? ` (profile ${profile})` : ""}` +
          (selected ? `; profile ${profile} is now selected` : ""),
      );
      return {
        valid: true,
        saved: true,
        path,
        profile: profile ?? null,
        selected,
        credential: command ? "tokenCommand" : "token",
        userId: info.id,
        email: info.email,
      };
    },
  },
  {
    path: ["auth", "logout"],
    summary: "Remove the stored access token (or token command) of the profile in effect.",
    description: `Removes the token or tokenCommand from ${userConfigPath}: from the profile in effect
(--profile, ZEROPS_PROFILE or \`zops profile use\`), else the top-level setting. A profile keeps its
project, service and region defaults; \`zops profile remove\` deletes it entirely.`,
    examples: ["zops auth logout", "zops auth logout --profile acme"],
    operations: [],
    async run(ctx) {
      const profile = ctx.config.profile;
      if (profile && !Object.hasOwn(readUserConfig().profiles ?? {}, profile)) {
        throw notFound(`no profile named '${profile}'`, "Run `zops profile list`.");
      }
      if (ctx.dryRun) return { removed: false, profile: profile ?? null, path: userConfigPath };
      updateUserConfig((config) => {
        const target = profile ? config.profiles![profile]! : config;
        target.token = undefined;
        target.tokenCommand = undefined;
      });
      ctx.out.step(`token removed from ${userConfigPath}${profile ? ` (profile ${profile})` : ""}`);
      return { removed: true, profile: profile ?? null, path: userConfigPath };
    },
  },
  {
    path: ["auth", "status"],
    summary: "Show who the current token belongs to and where the configuration came from.",
    description: `Reports the resolved identity, the profile in effect, where the token came from, and every
configuration source that contributed, which is the fastest way to diagnose "wrong project",
"wrong organization" and "unexpected permissions" problems. The token itself is never printed.

Exits 3 when no token is configured or the token is rejected.`,
    examples: ["zops auth status", "zops auth status --profile acme", "zops auth status --json"],
    operations: ["GetUserInfo"],
    async run(ctx) {
      const info = await whoami(ctx);
      const membership = info.clientUserList?.find((c) => c.status === "ACTIVE") ?? info.clientUserList?.[0];
      const result = {
        profile: ctx.config.profile ?? null,
        profileSource: ctx.config.profileSource ?? null,
        tokenSource: ctx.config.tokenSource ?? null,
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
