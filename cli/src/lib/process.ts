/**
 * Waiting on asynchronous platform operations.
 *
 * Most mutating endpoints return a process id and finish later. Commands wait by default: an
 * agent that gets its shell prompt back before the restart actually happened will make its next
 * decision on stale state.
 */
import type { Context } from "./context.ts";
import { remoteFailed, timeout } from "./errors.ts";

export const PROCESS_TERMINAL = new Set(["FINISHED", "FAILED", "CANCELED"]);
export const PROCESS_SUCCESS = "FINISHED";

export interface ProcessInfo {
  id: string;
  status: string;
  actionName: string;
  projectId: string;
  serviceStackId?: string | null;
  created: string;
  started?: string | null;
  finished?: string | null;
  appVersion?: {
    id: string;
    status?: string;
    build?: { serviceStackId?: string | null } | null;
    prepareCustomRuntime?: { serviceStackId?: string | null } | null;
  } | null;
  [key: string]: unknown;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Poll interval; the platform's own UI polls at roughly this rate. */
  intervalMs?: number;
  /** Invoked on every poll, for log attachment and progress reporting. */
  onPoll?: (process: ProcessInfo) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Polls until the process reaches a terminal state.
 *
 * Exits 8 on FAILED/CANCELED and 7 on deadline — distinct codes because they call for
 * different responses: one means the request was wrong, the other means look again later.
 */
export async function waitForProcess(
  ctx: Context,
  processId: string,
  options: WaitOptions = {},
): Promise<ProcessInfo> {
  const deadline = Date.now() + (options.timeoutMs ?? ctx.timeoutMs);
  const interval = options.intervalMs ?? 1000;

  for (;;) {
    const proc = await ctx.api.call<ProcessInfo>("GetProcessDetails", { path: { id: processId } });
    await options.onPoll?.(proc);

    if (PROCESS_TERMINAL.has(proc.status)) {
      if (proc.status === PROCESS_SUCCESS) return proc;
      throw remoteFailed(`${proc.actionName} finished with status ${proc.status}`, {
        processId,
        status: proc.status,
        actionName: proc.actionName,
        appVersionId: proc.appVersion?.id,
      });
    }

    if (Date.now() >= deadline) {
      throw timeout(
        `timed out after ${Math.round((options.timeoutMs ?? ctx.timeoutMs) / 1000)}s waiting for ${proc.actionName} (status ${proc.status})`,
        { processId, status: proc.status, actionName: proc.actionName },
      );
    }

    await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

/** A mutation's response in either shape the API uses: a bare process, or one nested under `process`. */
export interface ProcessResponse {
  id?: string;
  actionName?: string;
  process?: { id?: string; actionName?: string } | null;
}

/**
 * Pulls the process out of a mutation response.
 *
 * The spec labels some endpoints `ResponseProcess` (flat) and others `ResponseProcessNil`
 * (`{process}`, possibly absent), and the two are not reliably distinguishable from the document
 * alone. Accepting both removes a whole class of "missing path parameter 'id'".
 *
 * The nested form is checked first and that order matters: `CreateServiceStack` answers with the
 * new *service* — its own `id` — alongside the process that provisions it, so preferring the
 * flat `id` would wait on the service id and never find a process.
 */
export function extractProcess(
  response: ProcessResponse | null | undefined,
): { id: string; actionName?: string } | null {
  if (!response || typeof response !== "object") return null;
  if ("process" in response) {
    const nested = response.process;
    return nested && typeof nested.id === "string" ? { id: nested.id, actionName: nested.actionName } : null;
  }
  return typeof response.id === "string" ? { id: response.id, actionName: response.actionName } : null;
}

/**
 * Shared tail for commands that trigger a process: honours --no-wait and --json, and returns
 * the payload the command should print.
 *
 * A response carrying no process means the change applied synchronously — reported as finished
 * rather than treated as an error, because for the caller it is done either way.
 */
export async function settleProcess(
  ctx: Context,
  response: ProcessResponse | null | undefined,
  description: string,
  options: WaitOptions = {},
): Promise<Record<string, unknown>> {
  const process = extractProcess(response);
  if (!process) {
    ctx.out.step(`${description} — applied immediately`);
    return { processId: null, status: PROCESS_SUCCESS, waited: false };
  }

  if (!ctx.wait) {
    ctx.out.info(`${description} started (process ${process.id}); not waiting`);
    return { processId: process.id, status: "PENDING", waited: false };
  }

  ctx.out.info(`${description}…`);
  const finished = await waitForProcess(ctx, process.id, options);
  ctx.out.step(`${description} finished`);
  return {
    processId: finished.id,
    status: finished.status,
    actionName: finished.actionName,
    finished: finished.finished ?? null,
    waited: true,
  };
}
