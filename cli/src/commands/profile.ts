import type { CommandSpec } from "../lib/spec.ts";
import { readUserConfig, updateUserConfig, userConfigPath } from "../lib/config.ts";
import { notFound, usage } from "../lib/errors.ts";

export const profileCommands: CommandSpec[] = [
  {
    path: ["profile", "list"],
    summary: "List the named profiles in the user config, one per organization.",
    description: `Profiles live in ${userConfigPath} under "profiles". Each holds a token or a tokenCommand,
plus optional project, service and region defaults. Tokens are never printed; a tokenCommand is,
since it names where the secret lives rather than the secret.

ACTIVE marks the profile this invocation would use (--profile > ZEROPS_PROFILE > \`zops profile use\`).`,
    examples: ["zops profile list", "zops profile list --json"],
    operations: [],
    async run(ctx) {
      const profiles = readUserConfig().profiles ?? {};
      const rows = Object.entries(profiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, p]) => ({
          name,
          active: name === ctx.config.profile,
          credential: p.token ? "token" : p.tokenCommand ? "tokenCommand" : null,
          project: p.project ?? null,
          service: p.service ?? null,
          region: p.region ?? null,
          tokenCommand: p.tokenCommand ?? null,
        }));
      ctx.out.data(rows, {
        emptyMessage: "No profiles. Create one with `zops auth login --profile <name> --token-command '<cmd>'`.",
      });
      return undefined;
    },
  },
  {
    path: ["profile", "use"],
    summary: "Select the profile that commands use when neither --profile nor ZEROPS_PROFILE is given.",
    description: `Writes the selection to ${userConfigPath}. --none clears it, falling back to the top-level
token in the config file.`,
    args: [{ name: "name", description: "Profile to select. Omit when passing --none." }],
    flags: [{ name: "none", type: "boolean", description: "Clear the selection instead of setting one." }],
    examples: ["zops profile use acme", "zops profile use --none"],
    operations: [],
    async run(ctx, parsed) {
      const name = parsed.args[0];
      const clear = ctx.bool("none");
      if (clear && name) throw usage("pass either <name> or --none, not both");
      if (!clear && !name) throw usage("profile use requires <name> or --none", "Run `zops profile list`.");
      if (name) {
        const names = Object.keys(readUserConfig().profiles ?? {});
        if (!names.includes(name)) {
          throw notFound(
            `no profile named '${name}'`,
            names.length ? `Available profiles: ${names.join(", ")}.` : "No profiles are configured yet.",
          );
        }
      }
      if (ctx.dryRun) return { profile: name ?? null, saved: false };
      const path = updateUserConfig((config) => {
        config.profile = name;
      });
      ctx.out.step(name ? `profile ${name} selected` : "profile selection cleared");
      return { profile: name ?? null, saved: true, path };
    },
  },
];
