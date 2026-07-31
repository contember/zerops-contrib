/**
 * The operation index the CLI actually uses: everything generated from the OpenAPI document,
 * plus the hand-declared undocumented endpoints.
 *
 * Kept separate from `generated/operations.ts` so regenerating the spec never clobbers the
 * additions, and so `documented` stays an honest distinction rather than a blurred one.
 */
import {
  OPERATIONS as DOCUMENTED,
  SPEC_VERSION,
  findOperation as findDocumented,
  type OperationDef,
} from "../generated/operations.ts";
import { EXTRA_OPERATIONS } from "./extra-operations.ts";

export type { OperationDef };
export { SPEC_VERSION };

export const DOCUMENTED_COUNT = DOCUMENTED.length;
export const UNDOCUMENTED_COUNT = EXTRA_OPERATIONS.length;

export const OPERATIONS: readonly OperationDef[] = [...DOCUMENTED, ...EXTRA_OPERATIONS].sort((a, b) =>
  a.id.localeCompare(b.id),
);

/** True when the operation is absent from the published OpenAPI document. */
export function isUndocumented(op: OperationDef): boolean {
  return op.tag === "Search";
}

const EXTRA_BY_ID = new Map(EXTRA_OPERATIONS.map((o) => [o.id.toLowerCase(), o]));

/** Documented operations win, so an upstream addition can never be shadowed by an extra. */
export function findOperation(id: string): OperationDef | undefined {
  return findDocumented(id) ?? EXTRA_BY_ID.get(id.toLowerCase());
}
