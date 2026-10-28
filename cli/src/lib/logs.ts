/**
 * Client for the project log proxy.
 *
 * The REST API hands out a short-lived, pre-authorized access token per project. It opens two
 * endpoints: the project's VictoriaLogs (LogsQL, under the `urlUi` prefix), used for reading
 * history, and the older log API's websocket stream, used for following. Build logs are
 * ordinary container logs emitted by a throwaway builder service and tagged
 * `zbuilder@<appVersionId>`, which is what makes `zops push` able to show them.
 */
import type { Context } from "./context.ts";
import { ZopsError, EXIT } from "./errors.ts";

/** Syslog facilities the platform uses to separate app output from webserver access logs. */
export const FACILITY = { APPLICATION: 16, WEBSERVER: 17 } as const;
export type MessageType = keyof typeof FACILITY;

export const SEVERITY: Record<string, number> = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFORMATIONAL: 6,
  DEBUG: 7,
};

export interface LogEntry {
  id: string;
  timestamp: string;
  hostname: string;
  content: string;
  message: string;
  tag: string;
  appName: string;
  severity: number;
  severityLabel: string;
  facility: number;
  facilityLabel: string;
  priority: number;
  client: string;
  procId: string;
  msgId: string;
  structuredData: string;
  version: number;
}

export interface LogStreamQuery {
  serviceStackId: string;
  containerId?: string;
  tags?: string[];
  facility?: number;
  minimumSeverity?: number;
}

/** A history read through LogsQL. The service scope is a stream filter the query cannot widen. */
export interface LogSearch {
  serviceStackId: string;
  tags?: string[];
  containerId?: string;
  facility?: number;
  minimumSeverity?: number;
  start?: Date;
  end?: Date;
  /** Substring of the message. */
  grep?: string;
  /** LogsQL filters and pipes; the filters above narrow it further. */
  query?: string;
  limit: number;
}

/** One log line as zops prints it, whichever endpoint it came from. */
export interface LogLine {
  timestamp: string;
  severity: number;
  severityLabel: string;
  facility: number;
  tag: string;
  hostname: string;
  message: string;
}

/** A LogsQL result row: field name to value. Pipes such as `stats` produce rows without `_time`. */
export type LogsqlRow = Record<string, string>;

interface LogAccess {
  url: string;
  urlUi: string;
  accessToken: string;
  expiration: string;
}

const SEVERITY_LABELS = ["Emergency", "Alert", "Critical", "Error", "Warning", "Notice", "Informational", "Debug"];

export class LogClient {
  private constructor(
    private readonly access: LogAccess,
    private readonly ctx: Context,
  ) {}

  static async forProject(ctx: Context, projectId: string): Promise<LogClient> {
    const access = await ctx.api.call<LogAccess>("GetProjectLog", { path: { id: projectId } });
    return new LogClient(access, ctx);
  }

  private streamUrl(query: LogStreamQuery): URL {
    // The issued URL already carries ?accessToken=…; the stream lives one path segment deeper
    // and speaks websocket. It ignores `limit` and `from`.
    const base = new URL(this.access.url);
    const url = new URL(base);
    url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${base.pathname.replace(/\/$/, "")}/stream`;
    url.searchParams.set("desc", "0");
    url.searchParams.set("facility", String(query.facility ?? FACILITY.APPLICATION));
    url.searchParams.set("serviceStackId", query.serviceStackId);
    if (query.containerId) url.searchParams.set("containerId", query.containerId);
    if (query.tags?.length) url.searchParams.set("tags", query.tags.join(","));
    if (query.minimumSeverity !== undefined) {
      url.searchParams.set("minimumSeverity", String(query.minimumSeverity));
    }
    return url;
  }

  /**
   * Reads history through LogsQL. Rows come back oldest-first; rows a pipe aggregated keep the
   * server's order.
   */
  async search(search: LogSearch): Promise<LogsqlRow[]> {
    const url = new URL("select/logsql/query", this.access.urlUi);
    const params = logsqlParams(search);
    this.ctx.out.debug(`→ POST ${url.pathname.replace(this.access.accessToken, "<token>")} (${params})`);

    const response = await fetch(url, { method: "POST", body: params });
    if (!response.ok) {
      const text = (await response.text()).trim();
      throw new ZopsError({
        code: "logReadFailed",
        message: `log query failed: HTTP ${response.status}${text ? `: ${text}` : ""}`,
        exitCode: response.status >= 500 ? EXIT.TRANSIENT : response.status === 400 ? EXIT.USAGE : EXIT.ERROR,
        hint: response.status === 400 ? "Check the --query syntax against the LogsQL documentation." : undefined,
      });
    }
    const rows = parseLogsqlRows(await response.text());
    // The server returns the newest matching lines first.
    return rows.some((row) => row._time !== undefined) ? rows.reverse() : rows;
  }

  /**
   * Follows the log stream, reconnecting when the socket drops. Every connect replays the whole
   * matching history first, so lines up to the newest one in `seen` are skipped, and so is
   * anything already yielded. Ends when `signal` aborts.
   */
  async *follow(query: LogStreamQuery, signal: AbortSignal, seen: LogLine[] = []): AsyncGenerator<LogEntry> {
    const replay = new ReplayFilter(seen);

    while (!signal.aborted) {
      const url = this.streamUrl(query);
      const queue: LogEntry[] = [];
      let notify: (() => void) | null = null;
      let closed = false;
      // Held in an object so the value written by the socket callback is visible to the reader
      // below; a plain `let` gets narrowed to its initializer by control-flow analysis.
      const failure: { error: Error | null } = { error: null };

      const socket = new WebSocket(url.toString());
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as LogEntry | { items?: LogEntry[] };
          const entries = Array.isArray((parsed as { items?: LogEntry[] }).items)
            ? (parsed as { items: LogEntry[] }).items
            : [parsed as LogEntry];
          for (const entry of entries) if (entry?.id) queue.push(entry);
        } catch {
          /* a frame that is not a log entry (keepalive) is not worth failing over */
        }
        notify?.();
      };
      socket.onerror = () => {
        failure.error = new Error("log stream socket error");
        closed = true;
        notify?.();
      };
      socket.onclose = () => {
        closed = true;
        notify?.();
      };

      const onAbort = () => {
        closed = true;
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        notify?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        while (!closed || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
              if (closed) resolve();
            });
            notify = null;
            continue;
          }
          const entry = queue.shift()!;
          if (replay.accept(entry)) yield entry;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }

      if (signal.aborted) return;
      this.ctx.out.debug(`log stream closed${failure.error ? ` (${failure.error.message})` : ""}; reconnecting`);
      await Bun.sleep(1000);
    }
  }
}

/**
 * Passes only lines newer than everything accepted so far. The stream carries no stable id, so
 * position is the timestamp; lines sharing the newest timestamp are told apart by their message.
 */
export class ReplayFilter {
  private newest: bigint | null = null;
  private atNewest = new Set<string>();

  constructor(seen: LogLine[]) {
    for (const line of seen) this.accept(line);
  }

  accept(line: { timestamp: string; message: string }): boolean {
    const time = timestampNanos(line.timestamp);
    if (this.newest !== null && time < this.newest) return false;
    if (this.newest === null || time > this.newest) {
      this.newest = time;
      this.atNewest = new Set();
    }
    if (this.atNewest.has(line.message)) return false;
    this.atNewest.add(line.message);
    return true;
  }
}

/** Nanoseconds since the epoch. `Date` keeps milliseconds, and lines often differ by microseconds. */
export function timestampNanos(timestamp: string): bigint {
  const m = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  const seconds = m ? Date.parse(`${m[1]}Z`) : Number.NaN;
  if (!m || Number.isNaN(seconds)) {
    throw new ZopsError({ code: "logReadFailed", message: `unexpected log timestamp ${JSON.stringify(timestamp)}` });
  }
  return BigInt(seconds) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}

/**
 * Request parameters for a search. The filters zops adds travel in `extra_stream_filters` and
 * `extra_filters`, which the server ANDs with the whole query, so an `or` in --query cannot widen them.
 */
export function logsqlParams(search: LogSearch): URLSearchParams {
  const filters: string[] = [];
  if (search.facility !== undefined) filters.push(`facility:=${search.facility}`);
  if (search.minimumSeverity !== undefined) filters.push(`severity:<=${search.minimumSeverity}`);
  if (search.containerId) filters.push(`containerId:=${JSON.stringify(search.containerId)}`);
  if (search.tags?.length) filters.push(`appName:in(${search.tags.map((tag) => JSON.stringify(tag)).join(",")})`);
  if (search.grep) filters.push(`_msg:~${JSON.stringify(escapeRegExp(search.grep))}`);

  const params = new URLSearchParams({
    query: search.query ?? "*",
    limit: String(search.limit),
    extra_stream_filters: `{stackId=${JSON.stringify(search.serviceStackId)}}`,
  });
  if (filters.length > 0) params.set("extra_filters", filters.join(" "));
  if (search.start) params.set("start", search.start.toISOString());
  if (search.end) params.set("end", search.end.toISOString());
  return params;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parses the JSON-lines body of `/select/logsql/query`. */
export function parseLogsqlRows(body: string): LogsqlRow[] {
  const rows: LogsqlRow[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ZopsError({ code: "logReadFailed", message: `unexpected log query row: ${line.slice(0, 200)}` });
    }
    const row: LogsqlRow = {};
    for (const [key, value] of Object.entries(parsed)) row[key] = String(value);
    rows.push(row);
  }
  return rows;
}

/** A LogsQL row as a log line, or null for a row a pipe produced (it has no `_time`). */
export function logLineFromRow(row: LogsqlRow): LogLine | null {
  if (row._time === undefined) return null;
  const severity = Number(row.severity ?? SEVERITY.INFORMATIONAL);
  return {
    timestamp: row._time,
    severity,
    severityLabel: SEVERITY_LABELS[severity] ?? String(severity),
    facility: Number(row.facility ?? FACILITY.APPLICATION),
    tag: row.appName ?? "",
    hostname: row.hostname ?? "",
    message: row._msg ?? "",
  };
}

export function logLineFromEntry(entry: LogEntry): LogLine {
  return {
    timestamp: entry.timestamp,
    severity: entry.severity,
    severityLabel: entry.severityLabel,
    facility: entry.facility,
    tag: entry.tag,
    hostname: entry.hostname,
    message: entry.message,
  };
}

/** `2026-07-31T12:06:49Z  INFO   app   message` */
export function formatLogLine(entry: LogLine, opts: { short?: boolean } = {}): string {
  if (opts.short) return entry.message;
  return `${entry.timestamp}  ${entry.severityLabel.padEnd(13)} ${entry.tag.padEnd(16)} ${entry.message}`;
}
