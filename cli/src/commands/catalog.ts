/**
 * Self-description: `zz commands` dumps the entire command surface as data.
 *
 * An agent can enumerate what this CLI can do in one call, without scraping help text or
 * shipping a copy of the manual that goes stale.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { GLOBAL_FLAGS } from "../lib/spec.ts";
import { COMMANDS } from "./index.ts";
import { EXIT_MEANINGS } from "../lib/errors.ts";
import { DOCUMENTED_COUNT, UNDOCUMENTED_COUNT, SPEC_VERSION } from "../lib/operations.ts";
import { VERSION } from "../cli.ts";

export const catalogCommands: CommandSpec[] = [
  {
    path: ["commands"],
    summary: "Dump the full command catalog, for tooling and self-discovery.",
    description: `Machine-readable description of every command, argument, flag and exit code. Intended for
agents and wrappers that want to enumerate the surface rather than parse --help.`,
    flags: [
      { name: "search", type: "string", placeholder: "<substring>", description: "Only commands matching this substring." },
    ],
    examples: [
      "zz commands --json",
      "zz commands --json | jq -r '.commands[].name'",
      "zz commands --search backup",
    ],
    operations: [],
    async run(ctx) {
      const search = ctx.flag<string>("search")?.toLowerCase();
      const commands = COMMANDS.filter(
        (c) => !search || `${c.path.join(" ")} ${c.summary}`.toLowerCase().includes(search),
      ).map((c) => ({
        name: c.path.join(" "),
        summary: c.summary,
        description: c.description ?? null,
        destructive: Boolean(c.destructive),
        args: (c.args ?? []).map((a) => ({
          name: a.name,
          description: a.description,
          required: Boolean(a.required),
          variadic: Boolean(a.variadic),
        })),
        flags: (c.flags ?? []).map((f) => ({
          name: f.name,
          short: f.short ?? null,
          type: f.type,
          description: f.description,
          default: f.default ?? null,
          required: Boolean(f.required),
          enum: f.enum ?? null,
        })),
        examples: c.examples ?? [],
        apiOperations: c.operations ?? [],
      }));

      if (!ctx.out.json) {
        ctx.out.data(commands, {
          columns: [
            { key: "name", header: "COMMAND" },
            { key: "destructive", header: "DESTRUCTIVE" },
            { key: "summary", header: "SUMMARY" },
          ],
          emptyMessage: "no commands matched",
        });
        return;
      }

      ctx.out.data({
        tool: "zz",
        version: VERSION,
        apiSpecVersion: SPEC_VERSION,
        rawOperationCount: DOCUMENTED_COUNT + UNDOCUMENTED_COUNT,
        documentedOperationCount: DOCUMENTED_COUNT,
        undocumentedOperationCount: UNDOCUMENTED_COUNT,
        outputContract: {
          stdout: "data only",
          stderr: "progress, warnings, errors",
          json: "--json emits structured data on stdout; errors use a single envelope on stderr",
          quiet: "--quiet emits bare values, one per line",
        },
        exitCodes: EXIT_MEANINGS,
        globalFlags: GLOBAL_FLAGS.map((f) => ({
          name: f.name,
          short: f.short ?? null,
          type: f.type,
          description: f.description,
          default: f.default ?? null,
          env: f.env ?? null,
        })),
        commands,
      });
    },
  },
];
