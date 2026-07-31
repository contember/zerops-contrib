/**
 * Client for the project log proxy.
 *
 * The REST API hands out a short-lived, pre-authorized log URL per project; everything after
 * that is filtering. Build logs are ordinary container logs emitted by a throwaway builder
 * service and tagged `zbuilder@<appVersionId>`, which is what makes `zz push` able to show them.
 */
import type { Context } from "./context.ts";
import { ZzError, EXIT } from "./errors.ts";

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

export interface LogQuery {
  serviceStackId?: string;
  containerId?: string;
  tags?: string[];
  /** How many matching entries to return. Applied locally, after the server's filtering. */
  limit?: number;
  /**
   * How far back through the project's combined log stream the server looks.
   *
   * The upstream `limit` parameter is a scan window, not a result count: filters are applied to
   * the most recent N entries of the whole project, so a narrow window over a chatty project
   * returns nothing for a quiet service. Scan wide, then trim locally.
   */
  scan?: number;
  facility?: number;
  minimumSeverity?: number;
  /** Resume marker: only entries newer than this log id. */
  from?: string;
}

interface LogAccess {
  url: string;
  accessToken: string;
  expiration: string;
}

export class LogClient {
  private constructor(
    private readonly access: LogAccess,
    private readonly ctx: Context,
  ) {}

  static async forProject(ctx: Context, projectId: string): Promise<LogClient> {
    const access = await ctx.api.call<LogAccess>("GetProjectLog", { path: { id: projectId } });
    return new LogClient(access, ctx);
  }

  private buildUrl(query: LogQuery, opts: { stream: boolean }): URL {
    // The issued URL already carries ?accessToken=…; the stream variant lives one path segment
    // deeper and speaks websocket.
    const base = new URL(this.access.url);
    const url = new URL(base);
    if (opts.stream) {
      url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${base.pathname.replace(/\/$/, "")}/stream`;
    }
    url.searchParams.set("limit", String(query.scan ?? query.limit ?? 100));
    // desc=1 returns newest-first for a one-shot read; a stream must arrive oldest-first.
    url.searchParams.set("desc", opts.stream ? "0" : "1");
    url.searchParams.set("facility", String(query.facility ?? FACILITY.APPLICATION));
    if (query.serviceStackId) url.searchParams.set("serviceStackId", query.serviceStackId);
    if (query.containerId) url.searchParams.set("containerId", query.containerId);
    if (query.tags?.length) url.searchParams.set("tags", query.tags.join(","));
    if (query.minimumSeverity !== undefined) {
      url.searchParams.set("minimumSeverity", String(query.minimumSeverity));
    }
    if (query.from) url.searchParams.set("from", query.from);
    return url;
  }

  /** One-shot read. Returns at most `limit` entries, oldest-first. */
  async fetch(query: LogQuery): Promise<LogEntry[]> {
    const url = this.buildUrl(query, { stream: false });
    this.ctx.out.debug(`→ GET ${url.pathname} (logs, scan=${query.scan ?? query.limit ?? 100})`);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new ZzError({
        code: "logReadFailed",
        message: `log query failed: HTTP ${response.status}`,
        exitCode: response.status >= 500 ? EXIT.TRANSIENT : EXIT.ERROR,
      });
    }
    const body = (await response.json()) as { items?: LogEntry[] };
    // The server returns newest-first; trim to the newest `limit` before restoring read order.
    const newestFirst = body.items ?? [];
    const limit = query.limit ?? newestFirst.length;
    return newestFirst.slice(0, limit).reverse();
  }

  /**
   * Follows the log stream, reconnecting from the last seen id so a dropped socket does not
   * silently lose lines. Ends when `signal` aborts.
   */
  async *follow(query: LogQuery, signal: AbortSignal): AsyncGenerator<LogEntry> {
    let from = query.from;

    while (!signal.aborted) {
      const url = this.buildUrl({ ...query, from }, { stream: true });
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
          from = entry.id;
          yield entry;
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

/** `2026-07-31T12:06:49Z  INFO   app   message` */
export function formatLogLine(entry: LogEntry, opts: { short?: boolean } = {}): string {
  if (opts.short) return entry.message;
  return `${entry.timestamp}  ${entry.severityLabel.padEnd(13)} ${entry.tag.padEnd(16)} ${entry.message}`;
}
