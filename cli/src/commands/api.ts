/**
 * Raw passthrough to any of the API's operations.
 *
 * The curated commands cover the common workflows; this covers everything else, so a gap in the
 * former is never a dead end. Operations, parameters and schemas all come from the generated
 * index, which means this surface is complete by construction rather than by maintenance.
 */
import { readFile } from "node:fs/promises";
import type { CommandSpec } from "../lib/spec.ts";
import { OPERATIONS, findOperation, isUndocumented, type OperationDef } from "../lib/operations.ts";
import { usage } from "../lib/errors.ts";
import { waitForProcess } from "../lib/process.ts";

/** Resolves a JSON-Schema `$ref` chain into something printable, guarding against cycles. */
async function expandSchema(name: string, depth = 0, seen = new Set<string>()): Promise<unknown> {
  const schemas = (await import("../generated/schemas.json")).default as Record<string, any>;

  const walk = (node: any, level: number, path: Set<string>): unknown => {
    if (!node || typeof node !== "object") return node;

    if (typeof node.$ref === "string") {
      const ref = node.$ref.split("/").pop()!;
      if (path.has(ref) || level > 4) return { $ref: ref };
      return walk(schemas[ref], level + 1, new Set([...path, ref]));
    }
    if (Array.isArray(node)) return node.map((n) => walk(n, level, path));

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // Descriptions are long and often Czech; they add noise without helping a caller.
      if (key === "description" && level > 0) continue;
      out[key] = walk(value, level, path);
    }
    return out;
  };

  const root = schemas[name];
  if (!root) return null;
  return walk(root, depth, new Set([name, ...seen]));
}

function describe(op: OperationDef): Record<string, unknown> {
  return {
    id: op.id,
    method: op.method,
    path: op.path,
    tag: op.tag,
    summary: op.summary,
    description: op.description,
    roles: op.roles,
    deprecated: op.deprecated,
    pathParams: op.params.filter((p) => p.in === "path"),
    queryParams: op.params.filter((p) => p.in === "query"),
    bodySchema: op.body,
    responseSchema: op.response,
  };
}

/** `key=value` pairs, with `@project` / `@service` resolved from the current context. */
async function collectParams(
  ctx: import("../lib/context.ts").Context,
  raw: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) throw usage(`--param expects key=value, got ${JSON.stringify(entry)}`);
    const key = entry.slice(0, eq);
    let value = entry.slice(eq + 1);
    if (value === "@project") value = await ctx.projectId();
    else if (value === "@service") value = await ctx.serviceId();
    else if (value === "@client") value = await ctx.clientId();
    out[key] = value;
  }
  return out;
}

export const apiCommands: CommandSpec[] = [
  {
    path: ["api"],
    summary: "Call any API operation directly.",
    description: `Complete access to every operation in the API, generated from its OpenAPI document. Use this
when no curated command covers what you need.

  zops api --list                        every operation
  zops api --list --tag ServiceStack     operations in one group
  zops api --describe <operationId>      parameters, body schema, response schema
  zops api <operationId> [--param k=v]   invoke

Path and query parameters are passed with --param. The values @project, @service and @client
resolve from the current context, so you rarely need to paste ids.

Request bodies come from --body (inline JSON), --body-file, or --body - for stdin.

Operations that start a background job return a process object; pass --follow-process to wait
for it, or hand the id to \`zops process wait\`.`,
    args: [{ name: "operation-id", description: "Operation to call, e.g. RestartServiceStack. Case-insensitive." }],
    flags: [
      { name: "list", type: "boolean", description: "List operations instead of calling one." },
      { name: "describe", type: "string", placeholder: "<operationId>", description: "Print one operation's full signature and schemas." },
      { name: "tag", type: "string", placeholder: "<tag>", description: "With --list, restrict to one group, e.g. Project." },
      { name: "search", type: "string", placeholder: "<substring>", description: "With --list, match id, path or summary." },
      { name: "param", type: "string[]", placeholder: "<key=value>", description: "Path or query parameter. Repeatable. Accepts @project, @service, @client." },
      { name: "body", type: "string", placeholder: "<json>", description: "Request body as inline JSON, or '-' to read stdin." },
      { name: "body-file", type: "string", placeholder: "<path>", description: "Request body from a JSON file." },
      { name: "follow-process", type: "boolean", description: "If the response is a process, wait for it to finish." },
    ],
    examples: [
      "zops api --list --tag ServiceStack",
      "zops api --describe ConfigureAutoscaling",
      "zops api GetProjectDetails --param id=@project",
      "zops api RestartServiceStack --param id=@service --follow-process",
      "zops api ConfigurePrometheus --param id=@project --body '{\"retention\":30}'",
    ],
    operations: [],
    async run(ctx, parsed) {
      // --- discovery -------------------------------------------------------
      const describeId = ctx.flag<string>("describe");
      if (describeId) {
        const op = findOperation(describeId);
        if (!op) {
          throw usage(`unknown operation '${describeId}'`, "Run `zops api --list` to see them all.");
        }
        const detail = describe(op);
        if (op.body) detail.bodySchemaExpanded = await expandSchema(op.body);
        if (op.response) detail.responseSchemaExpanded = await expandSchema(op.response);
        ctx.out.data(detail);
        return;
      }

      if (ctx.bool("list") || (!parsed.args[0] && !describeId)) {
        let ops = [...OPERATIONS];
        const tag = ctx.flag<string>("tag")?.toLowerCase();
        if (tag) ops = ops.filter((o) => o.tag.toLowerCase() === tag);
        const search = ctx.flag<string>("search")?.toLowerCase();
        if (search) {
          ops = ops.filter((o) => `${o.id} ${o.path} ${o.summary}`.toLowerCase().includes(search));
        }
        if (!ctx.bool("list") && !parsed.args[0]) {
          ctx.out.info("no operation given — listing all; use --describe <id> for details");
        }
        ctx.out.data(
          ops.map((o) => ({
            id: o.id,
            method: o.method,
            path: o.path,
            tag: o.tag,
            summary: o.summary,
            deprecated: o.deprecated,
            documented: !isUndocumented(o),
          })),
          {
            columns: [
              { key: "id", header: "OPERATION" },
              { key: "method", header: "METHOD" },
              { key: "path", header: "PATH" },
              { key: "tag", header: "TAG" },
            ],
            quietField: "id",
            emptyMessage: "no operations matched",
          },
        );
        return;
      }

      // --- invocation ------------------------------------------------------
      const op = findOperation(parsed.args[0]!);
      if (!op) {
        const needle = parsed.args[0]!.toLowerCase();
        const near = OPERATIONS.filter((o) => o.id.toLowerCase().includes(needle)).slice(0, 5);
        throw usage(
          `unknown operation '${parsed.args[0]}'`,
          near.length
            ? `Did you mean: ${near.map((o) => o.id).join(", ")}?`
            : "Run `zops api --list` to see every operation.",
        );
      }

      if (op.deprecated) ctx.out.warn(`${op.id} is marked deprecated in the API specification`);
      if (isUndocumented(op)) {
        ctx.out.warn(`${op.id} is not in the published OpenAPI document and may change without notice`);
      }

      const supplied = await collectParams(ctx, ctx.flag<string[]>("param") ?? []);
      const pathParams: Record<string, string> = {};
      const query: Record<string, unknown> = {};

      for (const param of op.params) {
        const value = supplied[param.name];
        if (value === undefined) {
          if (param.in === "path") {
            const expected = op.params
              .filter((p) => p.in === "path")
              .map((p) => `--param ${p.name}=<${p.type}>`)
              .join(" ");
            throw usage(
              `${op.id} needs path parameter '${param.name}'`,
              `Usage: zops api ${op.id} ${expected}\nRun \`zops api --describe ${op.id}\` for the full signature.`,
            );
          }
          continue;
        }
        if (param.in === "path") pathParams[param.name] = value;
        else query[param.name] = value;
      }

      // Anything not declared by the spec is still forwarded as a query parameter rather than
      // silently dropped — the spec occasionally lags the implementation.
      for (const [key, value] of Object.entries(supplied)) {
        if (!op.params.some((p) => p.name === key)) query[key] = value;
      }

      let body: unknown;
      const inlineBody = ctx.flag<string>("body");
      const bodyFile = ctx.flag<string>("body-file");
      if (inlineBody !== undefined && bodyFile !== undefined) {
        throw usage("pass either --body or --body-file, not both");
      }
      if (bodyFile !== undefined) {
        body = JSON.parse(await readFile(bodyFile, "utf8"));
      } else if (inlineBody !== undefined) {
        const text = inlineBody === "-" ? await Bun.stdin.text() : inlineBody;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw usage(`--body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (op.body) {
        // Several endpoints take an all-optional body; an empty object is the right default.
        body = {};
      }

      if (ctx.dryRun) {
        ctx.out.data({
          dryRun: true,
          operation: op.id,
          method: op.method,
          path: op.path,
          pathParams,
          query,
          body,
        });
        return;
      }

      const result = await ctx.api.callOperation(op, { path: pathParams, query, body });

      if (ctx.bool("follow-process") && result && typeof result === "object" && "id" in result && "actionName" in result) {
        const finished = await waitForProcess(ctx, (result as { id: string }).id, { timeoutMs: ctx.timeoutMs });
        ctx.out.data(finished);
        return;
      }

      ctx.out.data(result);
    },
  },
];
