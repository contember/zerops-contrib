/**
 * Command router and help renderer.
 *
 * `--help` is the tool's own documentation and the first thing an agent reads, so it is
 * generated from the same specs that drive parsing — it cannot drift from what the code accepts.
 */
import { COMMANDS } from "./commands/index.ts";
import { Context } from "./lib/context.ts";
import { EXIT, ZopsError, usage } from "./lib/errors.ts";
import { GLOBAL_FLAGS, parseArgs, type CommandSpec, type FlagSpec } from "./lib/spec.ts";
import { Output } from "./lib/output.ts";
import { SPEC_VERSION } from "./lib/operations.ts";

export const VERSION = "0.2.0";

const GLOBAL_VALUE_FLAGS = new Set(GLOBAL_FLAGS.filter((f) => f.type !== "boolean").map((f) => f.name));
const GLOBAL_VALUE_SHORTS = new Set(
  GLOBAL_FLAGS.filter((f) => f.type !== "boolean" && f.short).map((f) => f.short!),
);

/**
 * Positions of the tokens that can be command words.
 *
 * A global flag may precede the command (`zops --token X auth status`), and its value is a bare
 * word that must not be mistaken for one — hence skipping the argument after a value-taking
 * global flag. Command-specific flags are not known until the command is matched, but in
 * practice they follow it, and anything unrecognised is rejected later by the parser.
 */
function commandWordIndices(argv: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;

    if (token.startsWith("--")) {
      const name = token.slice(2).split("=")[0]!;
      if (!token.includes("=") && GLOBAL_VALUE_FLAGS.has(name)) i++;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (GLOBAL_VALUE_SHORTS.has(token.slice(1))) i++;
      continue;
    }
    indices.push(i);
  }
  return indices;
}

/** Longest-prefix match, so `service restart api` picks `service restart` and leaves `api`. */
function matchCommand(argv: string[]): { command?: CommandSpec; consumed: number } {
  const indices = commandWordIndices(argv);
  const words = indices.map((i) => argv[i]!);
  let best: CommandSpec | undefined;
  let bestLength = 0;
  for (const command of COMMANDS) {
    if (command.path.length > words.length) continue;
    if (command.path.every((seg, i) => words[i] === seg) && command.path.length > bestLength) {
      best = command;
      bestLength = command.path.length;
    }
  }
  return { command: best, consumed: bestLength };
}

/** Drops the matched command words from argv, leaving flags and positionals in place. */
function stripCommandWords(argv: string[], count: number): string[] {
  const drop = new Set(commandWordIndices(argv).slice(0, count));
  return argv.filter((_, i) => !drop.has(i));
}

function flagUsage(flag: FlagSpec): string {
  const lead = flag.short ? `-${flag.short}, --${flag.name}` : `    --${flag.name}`;
  const value = flag.type === "boolean" ? "" : ` ${flag.placeholder ?? `<${flag.type}>`}`;
  return `${lead}${value}`;
}

function renderFlags(flags: FlagSpec[], indent = "  "): string {
  const usages = flags.map(flagUsage);
  const width = Math.max(...usages.map((u) => u.length));
  return flags
    .map((flag, i) => {
      const extras: string[] = [];
      if (flag.enum) extras.push(`one of: ${flag.enum.join(", ")}`);
      if (flag.default !== undefined && flag.default !== false) extras.push(`default: ${flag.default}`);
      if (flag.env) extras.push(`env: ${flag.env}`);
      const suffix = extras.length ? ` (${extras.join("; ")})` : "";
      return `${indent}${usages[i]!.padEnd(width + 2)}${flag.description}${suffix}`;
    })
    .join("\n");
}

function commandUsageLine(command: CommandSpec): string {
  const args = (command.args ?? [])
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`) + (a.variadic ? "..." : ""))
    .join(" ");
  return `zops ${command.path.join(" ")}${args ? ` ${args}` : ""} [flags]`;
}

export function renderCommandHelp(command: CommandSpec): string {
  const lines: string[] = [];
  lines.push(command.summary, "", `Usage: ${commandUsageLine(command)}`);

  if (command.description) lines.push("", command.description.trim());

  if (command.args?.length) {
    lines.push("", "Arguments:");
    const width = Math.max(...command.args.map((a) => a.name.length));
    for (const arg of command.args) {
      lines.push(`  ${arg.name.padEnd(width + 2)}${arg.description}${arg.required ? "" : " (optional)"}`);
    }
  }

  if (command.flags?.length) {
    lines.push("", "Flags:", renderFlags(command.flags));
  }

  lines.push("", "Global flags:", renderFlags(GLOBAL_FLAGS));

  if (command.destructive) {
    lines.push(
      "",
      "This command changes or removes remote state. Use --dry-run to preview and --yes to",
      "skip confirmation (required when stdin is not a TTY).",
    );
  }

  if (command.examples?.length) {
    lines.push("", "Examples:");
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  if (command.operations?.length) {
    lines.push("", `API operations: ${command.operations.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderRootHelp(): string {
  const groups = new Map<string, CommandSpec[]>();
  for (const command of COMMANDS) {
    const group = command.path[0]!;
    groups.set(group, [...(groups.get(group) ?? []), command]);
  }

  const lines: string[] = [
    "zops — agent-first CLI for the Zerops API",
    "",
    "Usage: zops <command> [subcommand] [flags]",
    "",
    "Output contract: stdout carries data only; progress, warnings and errors go to stderr.",
    "Every command accepts --json (structured) and --quiet (bare values, one per line).",
    "",
    "Commands:",
  ];

  const width = Math.max(...COMMANDS.map((c) => c.path.join(" ").length));
  for (const [group, commands] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("");
    for (const command of commands.sort((a, b) => a.path.join(" ").localeCompare(b.path.join(" ")))) {
      lines.push(`  ${command.path.join(" ").padEnd(width + 2)}${command.summary}`);
    }
    void group;
  }

  lines.push(
    "",
    "Global flags:",
    renderFlags(GLOBAL_FLAGS),
    "",
    "Exit codes:",
    "  0 success              4 not found            7 wait timed out",
    "  1 error                5 conflict             8 remote operation failed",
    "  2 usage error          6 transient (retry)",
    "  3 auth error",
    "",
    "Discovery:",
    "  zops commands --json     full machine-readable command catalog",
    "  zops api --list          every raw API operation",
    "  zops <command> --help    flags, arguments and examples for one command",
    "",
  );
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const wantsVersion = argv.includes("--version");
  if (wantsVersion) {
    process.stdout.write(`zops ${VERSION} (api spec ${SPEC_VERSION})\n`);
    return EXIT.OK;
  }

  const { command, consumed } = matchCommand(argv);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");

  if (!command) {
    const firstIndex = commandWordIndices(argv)[0];
    const firstWord = firstIndex === undefined ? undefined : argv[firstIndex];
    if (!firstWord || wantsHelp) {
      process.stdout.write(renderRootHelp());
      return firstWord || wantsHelp ? EXIT.OK : EXIT.USAGE;
    }
    // A bare group name ("zops service") lists that group rather than erroring out.
    const group = COMMANDS.filter((c) => c.path[0] === firstWord);
    const out = new Output({});
    if (group.length > 0) {
      const width = Math.max(...group.map((c) => c.path.join(" ").length));
      process.stdout.write(
        `${group
          .map((c) => `  ${c.path.join(" ").padEnd(width + 2)}${c.summary}`)
          .join("\n")}\n`,
      );
      return EXIT.OK;
    }
    const near = COMMANDS.map((c) => c.path.join(" ")).filter((p) => p.includes(firstWord));
    out.fail(
      usage(
        `unknown command '${firstWord}'`,
        near.length ? `Did you mean: ${near.slice(0, 5).join(", ")}?` : "Run `zops --help` for the command list.",
      ),
    );
    return EXIT.USAGE;
  }

  if (wantsHelp) {
    process.stdout.write(renderCommandHelp(command));
    return EXIT.OK;
  }

  const specs = [...GLOBAL_FLAGS, ...(command.flags ?? [])];
  let ctx: Context | undefined;
  try {
    const parsed = parseArgs(stripCommandWords(argv, consumed), specs);

    const required = (command.args ?? []).filter((a) => a.required);
    if (parsed.args.length < required.length) {
      throw usage(
        `${command.path.join(" ")} requires ${required.map((a) => `<${a.name}>`).join(" ")}`,
        `Usage: ${commandUsageLine(command)}`,
      );
    }

    ctx = new Context(parsed);
    const result = await command.run(ctx, parsed);
    if (result !== undefined) ctx.out.data(result);
    return EXIT.OK;
  } catch (err) {
    const out = ctx?.out ?? new Output({ json: argv.includes("--json") });
    if (err instanceof ZopsError) {
      out.fail(err);
      return err.exitCode;
    }
    const wrapped = new ZopsError({
      code: "internalError",
      message: err instanceof Error ? err.message : String(err),
      exitCode: EXIT.ERROR,
      details: err instanceof Error && err.stack ? { stack: err.stack } : undefined,
    });
    out.fail(wrapped);
    return EXIT.ERROR;
  }
}
