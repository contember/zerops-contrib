/**
 * Command/flag description types plus the argument parser.
 *
 * Commands declare their interface as data rather than parsing argv themselves. That single
 * declaration drives three things that otherwise drift apart: parsing and validation, the
 * `--help` text, and the machine-readable catalog behind `zops commands --json`.
 */
import { usage } from "./errors.ts";

export type FlagType = "string" | "boolean" | "number" | "string[]";

export interface FlagSpec {
  name: string;
  short?: string;
  type: FlagType;
  description: string;
  default?: string | boolean | number;
  required?: boolean;
  enum?: readonly string[];
  placeholder?: string;
  /** Environment variable consulted when the flag is absent. */
  env?: string;
}

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface ParsedArgs {
  args: string[];
  flags: Record<string, string | boolean | number | string[] | undefined>;
  /** Everything after a bare `--`, passed through untouched. */
  rest: string[];
}

export interface CommandSpec {
  /** Command path, e.g. `["service", "restart"]`. */
  path: string[];
  summary: string;
  description?: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  examples?: string[];
  /** Mutates or removes remote state; gets `--dry-run` and requires `--yes` to skip confirmation. */
  destructive?: boolean;
  /** Underlying API operations, surfaced in the catalog so agents can map command -> endpoint. */
  operations?: string[];
  run: (ctx: import("./context.ts").Context, parsed: ParsedArgs) => Promise<unknown>;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  {
    name: "json",
    type: "boolean",
    description: "Emit machine-readable JSON on stdout instead of a human table.",
  },
  {
    name: "quiet",
    short: "q",
    type: "boolean",
    description: "Print bare values only, one per line, with no headers or progress.",
  },
  {
    name: "token",
    type: "string",
    env: "ZEROPS_TOKEN",
    placeholder: "<token>",
    description: "Zerops personal access token. Defaults to $ZEROPS_TOKEN, then the config file.",
  },
  {
    name: "project",
    short: "P",
    type: "string",
    env: "ZEROPS_PROJECT",
    placeholder: "<name|id>",
    description: "Project name or id. Defaults to $ZEROPS_PROJECT / $ZEROPS_PROJECT_ID, then the config file.",
  },
  {
    name: "service",
    short: "S",
    type: "string",
    env: "ZEROPS_SERVICE",
    placeholder: "<hostname|id>",
    description: "Service hostname or id. Defaults to $ZEROPS_SERVICE / $ZEROPS_SERVICE_ID, then the config file.",
  },
  {
    name: "region",
    type: "string",
    env: "ZEROPS_REGION",
    default: "prg1",
    placeholder: "<region>",
    description: "API region. Run `zops region list` for the available set.",
  },
  {
    name: "wait",
    type: "boolean",
    default: true,
    description: "Block until the triggered operation finishes. Use --no-wait to return the process id immediately.",
  },
  {
    name: "timeout",
    type: "string",
    default: "10m",
    placeholder: "<duration>",
    description: "Deadline for --wait, e.g. 90s / 10m / 1h. Exceeding it exits 7; the operation keeps running.",
  },
  {
    name: "yes",
    short: "y",
    type: "boolean",
    description: "Skip the confirmation prompt on destructive commands. Implied when stdin is not a TTY.",
  },
  {
    name: "dry-run",
    type: "boolean",
    description: "Describe what would happen without sending any mutating request.",
  },
  {
    name: "verbose",
    short: "v",
    type: "boolean",
    description: "Log every HTTP request and response status to stderr.",
  },
  {
    name: "help",
    short: "h",
    type: "boolean",
    description: "Show help for this command.",
  },
];

function coerce(spec: FlagSpec, raw: string): string | number {
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw usage(`--${spec.name} expects a number, got ${JSON.stringify(raw)}`);
    return n;
  }
  if (spec.enum && !spec.enum.includes(raw)) {
    throw usage(
      `--${spec.name} expects one of: ${spec.enum.join(", ")} — got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Parses argv against the command's declared flags merged with the global set.
 *
 * Unknown flags are a hard error rather than being collected as positionals — a silently
 * ignored typo is far more expensive for an agent than an explicit rejection.
 */
export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byLong = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));

  const args: string[] = [];
  const rest: string[] = [];
  const flags: ParsedArgs["flags"] = {};

  const setFlag = (spec: FlagSpec, value: string | boolean | number) => {
    if (spec.type === "string[]") {
      const prev = (flags[spec.name] as string[] | undefined) ?? [];
      flags[spec.name] = [...prev, String(value)];
    } else {
      flags[spec.name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

      // `--no-x` negates a boolean; the parser owns this so commands never see the `no-` form.
      if (!byLong.has(rawName) && rawName.startsWith("no-")) {
        const positive = byLong.get(rawName.slice(3));
        if (positive?.type === "boolean") {
          flags[positive.name] = false;
          continue;
        }
      }

      const spec = byLong.get(rawName);
      if (!spec) throw usage(`unknown flag --${rawName}`, "Run the command with --help to list its flags.");

      if (spec.type === "boolean") {
        if (inlineValue !== undefined) {
          if (inlineValue !== "true" && inlineValue !== "false") {
            throw usage(`--${spec.name} is a boolean; use --${spec.name} or --no-${spec.name}`);
          }
          flags[spec.name] = inlineValue === "true";
        } else {
          flags[spec.name] = true;
        }
        continue;
      }

      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw usage(`--${spec.name} expects a value`);
      setFlag(spec, coerce(spec, value));
      continue;
    }

    // A lone "-" means stdin and is a positional, not a flag.
    if (token.startsWith("-") && token.length > 1) {
      const rawName = token.slice(1);
      const spec = byShort.get(rawName);
      if (!spec) throw usage(`unknown flag -${rawName}`, "Run the command with --help to list its flags.");
      if (spec.type === "boolean") {
        flags[spec.name] = true;
        continue;
      }
      const value = argv[++i];
      if (value === undefined) throw usage(`-${rawName} expects a value`);
      setFlag(spec, coerce(spec, value));
      continue;
    }

    args.push(token);
  }

  // Defaults and env fallbacks fill in only where the user said nothing, keeping precedence at
  // flag > environment > declared default.
  for (const spec of specs) {
    if (flags[spec.name] !== undefined) continue;
    if (spec.env) {
      const fromEnv = process.env[spec.env];
      if (fromEnv !== undefined && fromEnv !== "") {
        flags[spec.name] = spec.type === "string[]" ? [fromEnv] : coerce(spec, fromEnv);
        continue;
      }
    }
    if (spec.default !== undefined) flags[spec.name] = spec.default;
  }

  for (const spec of specs) {
    if (spec.required && flags[spec.name] === undefined) {
      throw usage(`--${spec.name} is required`);
    }
  }

  return { args, flags, rest };
}

/** `90s`, `10m`, `1h`, or a bare number of seconds, in milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) throw usage(`invalid duration ${JSON.stringify(input)}`, "Use forms like 30s, 10m, 1h.");
  const value = Number(m[1]);
  const unit = m[2] ?? "s";
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return value * scale;
}
