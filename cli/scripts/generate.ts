#!/usr/bin/env bun
/**
 * Generates the low-level operation index from the vendored OpenAPI document.
 *
 * The whole point of `zops` is that every one of the API's operations is reachable, so the
 * index is derived mechanically rather than hand-listed — `bun run generate` after dropping
 * in a newer `openapi.yml` is the entire upgrade path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "openapi.yml");
const OUT_OPS = join(ROOT, "src/generated/operations.ts");
const OUT_SCHEMAS = join(ROOT, "src/generated/schemas.json");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Json = Record<string, any>;

const spec: Json = Bun.YAML.parse(readFileSync(SPEC, "utf8")) as Json;

/** Resolves a local `$ref` one level; the spec only ever points into `#/components/...`. */
function deref(node: Json): Json {
  if (node && typeof node.$ref === "string") {
    const path = node.$ref.replace(/^#\//, "").split("/");
    let cur: any = spec;
    for (const seg of path) cur = cur?.[seg];
    if (!cur) throw new Error(`unresolvable $ref: ${node.$ref}`);
    return cur;
  }
  return node;
}

/** `#/components/schemas/Foo` -> `Foo`; anything else stays inline. */
function schemaName(node: Json | undefined): string | null {
  if (!node) return null;
  if (typeof node.$ref === "string") {
    const m = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
    if (m) return m[1]!;
  }
  return null;
}

interface ParamDef {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: string;
  description: string;
  enum?: string[];
}

function paramDef(raw: Json): ParamDef | null {
  const p = deref(raw);
  const where = p.in as string;
  if (where !== "path" && where !== "query" && where !== "header") return null;
  const schema = p.schema ? deref(p.schema) : {};
  return {
    name: p.name,
    in: where,
    required: Boolean(p.required) || where === "path",
    type: schema.type === "array" ? `${deref(schema.items ?? {}).type ?? "string"}[]` : (schema.type ?? "string"),
    description: collapse(p.description ?? schema.description ?? ""),
    ...(schema.enum ? { enum: schema.enum as string[] } : {}),
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The API documents permissions as a trailing "Allowed roles: `OWNER`, `ADMIN`" line. */
function parseRoles(description: string): string[] {
  const m = /Allowed roles:\s*(.+)$/m.exec(description);
  if (!m) return [];
  return [...m[1]!.matchAll(/`([A-Z_]+)`/g)].map((x) => x[1]!);
}

function stripRoles(description: string): string {
  return description.replace(/\n*Allowed roles:.*$/ms, "").trim();
}

interface OperationDef {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  roles: string[];
  params: ParamDef[];
  body: string | null;
  response: string | null;
  deprecated: boolean;
  auth: boolean;
}

const operations: OperationDef[] = [];

for (const [path, itemRaw] of Object.entries(spec.paths as Json)) {
  const item = itemRaw as Json;
  const shared = (item.parameters ?? []) as Json[];
  for (const method of HTTP_METHODS) {
    const op = item[method] as Json | undefined;
    if (!op) continue;

    const rawDesc = (op.description ?? op.summary ?? "") as string;
    const description = stripRoles(rawDesc);
    const params = [...shared, ...((op.parameters ?? []) as Json[])]
      .map(paramDef)
      .filter((p): p is ParamDef => p !== null);

    const bodySchema = op.requestBody
      ? (() => {
          const content = deref(op.requestBody).content ?? {};
          const first = Object.values(content)[0] as Json | undefined;
          return first?.schema ? (schemaName(first.schema) ?? "inline") : null;
        })()
      : null;

    const responseSchema = (() => {
      const ok = (op.responses?.["200"] ?? op.responses?.["201"]) as Json | undefined;
      if (!ok) return null;
      const content = deref(ok).content ?? {};
      const first = Object.values(content)[0] as Json | undefined;
      return first?.schema ? schemaName(first.schema) : null;
    })();

    operations.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      tag: (op.tags?.[0] ?? "Other").replace(/^Public/, ""),
      summary: collapse(description.split("\n")[0] ?? ""),
      description,
      roles: parseRoles(rawDesc),
      params,
      body: bodySchema,
      response: responseSchema,
      deprecated: Boolean(op.deprecated),
      auth: Array.isArray(op.security) ? op.security.length > 0 : true,
    });
  }
}

operations.sort((a, b) => a.id.localeCompare(b.id));

// Operation ids are inconsistently cased upstream (`GetProcessDetails` vs `createAppVersion`), so
// lookups fall back to case-insensitive matching. `getUserInfo` and `GetUserInfo` are genuinely
// distinct operations though, so ambiguous folds are dropped from the alias map rather than
// silently resolving to whichever sorted first.
const folded = new Map<string, string[]>();
for (const op of operations) {
  const key = op.id.toLowerCase();
  folded.set(key, [...(folded.get(key) ?? []), op.id]);
}
const aliases = [...folded.entries()].filter(([, ids]) => ids.length === 1).map(([k, ids]) => [k, ids[0]!]);
const ambiguous = [...folded.entries()].filter(([, ids]) => ids.length > 1);
for (const [key, ids] of ambiguous) {
  console.error(`note: '${key}' is ambiguous (${ids.join(", ")}) — exact casing required`);
}

const header = `// Code generated by scripts/generate.ts from openapi.yml. DO NOT EDIT.
// Spec version: ${spec.info?.version ?? "unknown"}
// Operations: ${operations.length}

export interface ParamDef {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: string;
  description: string;
  enum?: string[];
}

export interface OperationDef {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  roles: string[];
  params: ParamDef[];
  body: string | null;
  response: string | null;
  deprecated: boolean;
  auth: boolean;
}

export const SPEC_VERSION = ${JSON.stringify(spec.info?.version ?? "unknown")};

export const OPERATIONS: readonly OperationDef[] = ${JSON.stringify(operations, null, 2)};

const BY_ID = new Map<string, OperationDef>(OPERATIONS.map((o) => [o.id, o]));

/** Case-folded ids that resolve to exactly one operation. */
const ALIASES = new Map<string, string>(${JSON.stringify(aliases)});

/**
 * Exact id first, then a case-insensitive fallback so agents need not remember upstream's
 * mixed casing. Ids that only differ by case (getUserInfo / GetUserInfo) resolve exactly or
 * not at all.
 */
export function findOperation(id: string): OperationDef | undefined {
  const exact = BY_ID.get(id);
  if (exact) return exact;
  const aliased = ALIASES.get(id.toLowerCase());
  return aliased ? BY_ID.get(aliased) : undefined;
}
`;

writeFileSync(OUT_OPS, header);
writeFileSync(OUT_SCHEMAS, JSON.stringify(spec.components?.schemas ?? {}, null, 0));

const byTag = new Map<string, number>();
for (const op of operations) byTag.set(op.tag, (byTag.get(op.tag) ?? 0) + 1);

console.error(`operations: ${operations.length}`);
console.error(`schemas:    ${Object.keys(spec.components?.schemas ?? {}).length}`);
console.error(`tags:       ${byTag.size}`);
