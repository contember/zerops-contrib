/**
 * HTTP client for the Zerops REST API.
 *
 * Two jobs beyond issuing the request: mapping upstream failures onto the exit-code taxonomy
 * (so callers never inspect status codes), and retrying the classes of failure that are
 * actually worth retrying.
 */
import { EXIT, ZopsError, type ExitCode } from "./errors.ts";
import type { Output } from "./output.ts";
import { findOperation, type OperationDef } from "./operations.ts";

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Skip the Authorization header (only the presigned artifact upload needs this). */
  anonymous?: boolean;
  /** Total attempts for retriable failures. */
  attempts?: number;
  signal?: AbortSignal;
  /** Return the raw Response instead of parsed JSON — used for file downloads. */
  raw?: boolean;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    meta?: unknown;
  };
}

/**
 * Upstream returns 400 for several conditions that are semantically distinct. The error code
 * is the only reliable discriminator, so conflict-shaped codes are lifted out of the generic
 * bucket to give agents something to branch on.
 */
const CONFLICT_CODES = new Set([
  "serviceStackNameAlreadyExists",
  "projectNameAlreadyExists",
  "userDataKeyAlreadyExists",
  "duplicateKey",
  "alreadyExists",
  "serviceStackIsNotInActiveStatus",
  "serviceStackIsAlreadyRunning",
  "serviceStackIsAlreadyStopped",
  "projectIsAlreadyRunning",
  "projectIsAlreadyStopped",
]);

const NOT_FOUND_CODES = new Set([
  "notFound",
  "serviceStackNotFound",
  "projectNotFound",
  "appVersionNotFound",
  "userDataNotFound",
  "processNotFound",
]);

function classify(status: number, code: string | undefined): ExitCode {
  if (status === 401) return EXIT.AUTH;
  if (status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 409) return EXIT.CONFLICT;
  if (status === 429) return EXIT.TRANSIENT;
  if (status >= 500) return EXIT.TRANSIENT;
  if (code && CONFLICT_CODES.has(code)) return EXIT.CONFLICT;
  if (code && NOT_FOUND_CODES.has(code)) return EXIT.NOT_FOUND;
  return EXIT.ERROR;
}

function hintFor(exitCode: ExitCode, code: string | undefined): string | undefined {
  if (exitCode === EXIT.AUTH) {
    return code === "notAllowedForApplicationToken"
      ? "This endpoint rejects personal access tokens; it requires an interactive user session."
      : "Check the token with `zops auth status`, or generate a new one in the Zerops GUI under Settings → Access Token Management.";
  }
  if (exitCode === EXIT.NOT_FOUND) return "List the available resources first, e.g. `zops service list`.";
  if (exitCode === EXIT.TRANSIENT) return "Transient failure — retry with backoff.";
  return undefined;
}

const RETRY_BASE_MS = 400;

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly out: Output,
  ) {}

  /** Interpolates `{id}`-style path params, tolerating the spec's `{path:.*}` regex form. */
  static buildPath(template: string, params: Record<string, string>): string {
    return template.replace(/\{([^}]+)\}/g, (_all, raw: string) => {
      const name = raw.split(":")[0]!;
      const value = params[name];
      if (value === undefined) {
        throw new ZopsError({
          code: "usage",
          message: `missing path parameter '${name}' for ${template}`,
          exitCode: EXIT.USAGE,
        });
      }
      // A `{path:.*}` segment is a whole sub-path and must keep its slashes.
      return raw.includes(":") ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
    });
  }

  async request<T = any>(options: RequestOptions): Promise<T> {
    const attempts = options.attempts ?? 3;
    let lastError: ZopsError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once<T>(options);
      } catch (err) {
        if (!(err instanceof ZopsError) || err.exitCode !== EXIT.TRANSIENT || attempt === attempts) throw err;
        lastError = err;
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        this.out.debug(`retry ${attempt}/${attempts - 1} in ${delay}ms — ${err.message}`);
        await Bun.sleep(delay);
      }
    }
    throw lastError ?? new ZopsError({ code: "unknown", message: "request failed" });
  }

  private async once<T>(options: RequestOptions): Promise<T> {
    const url = new URL(options.path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (!options.anonymous && this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    this.out.debug(`→ ${options.method} ${url.pathname}${url.search}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new ZopsError({
        code: "networkError",
        message: `cannot reach ${url.host}: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: EXIT.TRANSIENT,
        hint: "Check connectivity, then retry.",
      });
    }

    this.out.debug(`← ${response.status} ${options.method} ${url.pathname}`);

    if (options.raw) {
      if (!response.ok) throw await this.toError(response, options);
      return response as unknown as T;
    }

    const text = await response.text();
    if (!response.ok) throw this.toErrorFromText(response, text, options);

    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async toError(response: Response, options: RequestOptions): Promise<ZopsError> {
    return this.toErrorFromText(response, await response.text(), options);
  }

  private toErrorFromText(response: Response, text: string, options: RequestOptions): ZopsError {
    let parsed: ApiErrorBody | undefined;
    try {
      parsed = JSON.parse(text) as ApiErrorBody;
    } catch {
      /* upstream occasionally returns plain text (e.g. 404 from the router) */
    }

    const code = parsed?.error?.code;
    const exitCode = classify(response.status, code);
    const message = parsed?.error?.message ?? (text.trim() || response.statusText || `HTTP ${response.status}`);

    return new ZopsError({
      code: code ?? `http${response.status}`,
      message,
      exitCode,
      hint: hintFor(exitCode, code),
      details: {
        status: response.status,
        method: options.method,
        path: options.path,
        ...(parsed?.error?.meta ? { meta: parsed.error.meta } : {}),
      },
    });
  }

  /** Invokes a generated operation by id. Backs both the curated commands and `zops api`. */
  async call<T = any>(
    operationId: string,
    input: { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
    extra: Partial<RequestOptions> = {},
  ): Promise<T> {
    const op = findOperation(operationId);
    if (!op) {
      throw new ZopsError({
        code: "unknownOperation",
        message: `unknown operation '${operationId}'`,
        exitCode: EXIT.USAGE,
        hint: "Run `zops api --list` to see every available operation.",
      });
    }
    return this.callOperation<T>(op, input, extra);
  }

  async callOperation<T = any>(
    op: OperationDef,
    input: { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
    extra: Partial<RequestOptions> = {},
  ): Promise<T> {
    return this.request<T>({
      method: op.method,
      path: ApiClient.buildPath(op.path, input.path ?? {}),
      query: input.query,
      body: input.body,
      ...extra,
    });
  }
}
