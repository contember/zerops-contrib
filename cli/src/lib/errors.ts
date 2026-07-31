/**
 * Exit-code taxonomy and the single error shape.
 *
 * Agents branch on exit codes rather than parsing prose, so the codes carry the retry decision:
 * anything `retriable` is worth backing off and repeating, everything else needs a different
 * request. Every failure path in the CLI funnels through `ZzError` so `--json` consumers only
 * ever need one parser.
 */

export const EXIT = {
  /** Command succeeded. */
  OK: 0,
  /** Unclassified failure. */
  ERROR: 1,
  /** Bad invocation: unknown command, missing/invalid flag. Retrying verbatim cannot help. */
  USAGE: 2,
  /** Missing, invalid, or insufficiently-privileged credentials (401/403). */
  AUTH: 3,
  /** Addressed resource does not exist (404, or a name that resolves to nothing). */
  NOT_FOUND: 4,
  /** Resource already exists, or is already in the requested state (409). */
  CONFLICT: 5,
  /** Transient: rate limit, 5xx, network failure. Safe to retry with backoff. */
  TRANSIENT: 6,
  /** A `--wait` deadline elapsed. The remote operation may still be running. */
  TIMEOUT: 7,
  /** The remote operation ran and finished in a failed state (build failed, process FAILED). */
  REMOTE_FAILED: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_MEANINGS: Record<number, string> = {
  0: "success",
  1: "unclassified error",
  2: "usage error — bad command or flags",
  3: "authentication or permission error",
  4: "resource not found",
  5: "conflict — already exists or already in that state",
  6: "transient error — safe to retry",
  7: "timeout waiting for the operation to finish",
  8: "remote operation finished in a failed state",
};

export interface ZzErrorInit {
  code: string;
  message: string;
  exitCode?: ExitCode;
  /** Actionable next step. Shown to humans, carried in `--json` for agents. */
  hint?: string;
  /** Structured context: the failing operation, the HTTP status, upstream error metadata. */
  details?: Record<string, unknown>;
}

export class ZzError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(init: ZzErrorInit) {
    super(init.message);
    this.name = "ZzError";
    this.code = init.code;
    this.exitCode = init.exitCode ?? EXIT.ERROR;
    this.hint = init.hint;
    this.details = init.details;
  }

  get retriable(): boolean {
    return this.exitCode === EXIT.TRANSIENT;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        exitCode: this.exitCode,
        retriable: this.retriable,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const usage = (message: string, hint?: string) =>
  new ZzError({ code: "usage", message, exitCode: EXIT.USAGE, hint });

export const notFound = (message: string, hint?: string) =>
  new ZzError({ code: "notFound", message, exitCode: EXIT.NOT_FOUND, hint });

export const authError = (message: string, hint?: string) =>
  new ZzError({ code: "unauthorized", message, exitCode: EXIT.AUTH, hint });

export const timeout = (message: string, details?: Record<string, unknown>) =>
  new ZzError({ code: "timeout", message, exitCode: EXIT.TIMEOUT, details });

export const remoteFailed = (message: string, details?: Record<string, unknown>) =>
  new ZzError({ code: "remoteOperationFailed", message, exitCode: EXIT.REMOTE_FAILED, details });
