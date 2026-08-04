/**
 * The output contract.
 *
 * stdout carries data and nothing else — every diagnostic, progress line and warning goes to
 * stderr, so `zops service list --json | jq` can never be corrupted by a status message. Errors
 * are diagnostics too and therefore also land on stderr, which keeps stdout parseable even on
 * the failure path.
 */
import type { ZopsError } from "./errors.ts";

export interface Column<T> {
  key: string;
  header: string;
  get?: (row: T) => unknown;
  /** Dropped first when the terminal is too narrow. */
  optional?: boolean;
}

export interface RenderOptions<T = any> {
  columns?: Column<T>[];
  /** Field emitted by `--quiet`, one per line. Defaults to `name`, then `id`. */
  quietField?: string;
  /** Printed to stderr when the result set is empty. */
  emptyMessage?: string;
}

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  private readonly color: boolean;

  constructor(opts: { json?: boolean; quiet?: boolean; verbose?: boolean }) {
    this.json = Boolean(opts.json);
    this.quiet = Boolean(opts.quiet);
    this.verbose = Boolean(opts.verbose);
    this.color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && !this.json;
  }

  private paint(text: string, code: keyof typeof COLORS): string {
    return this.color ? `${COLORS[code]}${text}${COLORS.reset}` : text;
  }

  // --- stderr: diagnostics -------------------------------------------------

  /** Progress and context. Suppressed by --quiet and --json; never touches stdout. */
  info(message: string): void {
    if (this.quiet || this.json) return;
    process.stderr.write(`${message}\n`);
  }

  /** A completed step. Same suppression rules as info(). */
  step(message: string): void {
    if (this.quiet || this.json) return;
    process.stderr.write(`${this.paint("✓", "green")} ${message}\n`);
  }

  /** Survives --quiet: a warning the caller did not ask for but needs. */
  warn(message: string): void {
    if (this.json) return;
    process.stderr.write(`${this.paint("warning:", "yellow")} ${message}\n`);
  }

  /** Only with --verbose. Used for the HTTP trace. */
  debug(message: string): void {
    if (!this.verbose) return;
    process.stderr.write(`${this.paint(message, "dim")}\n`);
  }

  /** Raw passthrough to stderr, used for streamed log lines. */
  stderr(line: string): void {
    process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  fail(err: ZopsError): void {
    if (this.json) {
      process.stderr.write(`${JSON.stringify(err.toJSON())}\n`);
      return;
    }
    process.stderr.write(`${this.paint("error:", "red")} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${this.paint("hint:", "cyan")} ${err.hint}\n`);
    if (this.verbose && err.details) {
      process.stderr.write(`${this.paint(JSON.stringify(err.details, null, 2), "dim")}\n`);
    }
  }

  // --- stdout: data --------------------------------------------------------

  /** Writes a payload to stdout in whichever shape the caller asked for. */
  data<T>(value: T, options: RenderOptions<T extends (infer U)[] ? U : T> = {}): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify(value, null, this.quiet ? 0 : 2)}\n`);
      return;
    }

    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      this.renderList(value, options as RenderOptions<any>);
      return;
    }

    if (typeof value === "object") {
      this.renderRecord(value as Record<string, unknown>, options as RenderOptions<any>);
      return;
    }

    process.stdout.write(`${String(value)}\n`);
  }

  /** Bare text straight to stdout, for commands whose payload is a document (YAML, logs). */
  raw(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  private quietValue(row: any, options: RenderOptions<any>): string {
    const field = options.quietField ?? (row?.name !== undefined ? "name" : "id");
    const column = options.columns?.find((c) => c.key === field);
    const value = column?.get ? column.get(row) : row?.[field];
    return value === undefined || value === null ? "" : String(value);
  }

  private renderList(rows: any[], options: RenderOptions<any>): void {
    if (this.quiet) {
      for (const row of rows) {
        const v = typeof row === "object" && row !== null ? this.quietValue(row, options) : String(row);
        if (v !== "") process.stdout.write(`${v}\n`);
      }
      return;
    }

    if (rows.length === 0) {
      if (options.emptyMessage) process.stderr.write(`${options.emptyMessage}\n`);
      return;
    }

    if (typeof rows[0] !== "object" || rows[0] === null) {
      for (const row of rows) process.stdout.write(`${String(row)}\n`);
      return;
    }

    const columns: Column<any>[] =
      options.columns ??
      Object.keys(rows[0]).map((key) => ({ key, header: key.toUpperCase() }));

    const cells = rows.map((row) =>
      columns.map((c) => formatCell(c.get ? c.get(row) : row[c.key])),
    );
    const widths = columns.map((c, i) =>
      Math.max(c.header.length, ...cells.map((r) => visibleWidth(r[i] ?? ""))),
    );

    const line = (values: string[]) =>
      values
        .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]! + 2)))
        .join("")
        .trimEnd();

    process.stdout.write(`${this.paint(line(columns.map((c) => c.header)), "dim")}\n`);
    for (const row of cells) process.stdout.write(`${line(row)}\n`);
  }

  private renderRecord(record: Record<string, unknown>, options: RenderOptions<any>): void {
    if (this.quiet) {
      const v = this.quietValue(record, options);
      if (v !== "") process.stdout.write(`${v}\n`);
      return;
    }
    const entries = options.columns
      ? options.columns.map((c) => [c.header, c.get ? c.get(record) : record[c.key]] as const)
      : Object.entries(record);
    const width = Math.max(0, ...entries.map(([k]) => String(k).length));
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      process.stdout.write(`${String(key).padEnd(width + 2)}${formatCell(value)}\n`);
    }
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.length === 0 ? "-" : value.map(formatCell).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  const s = String(value);
  return s === "" ? "-" : s;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function visibleWidth(s: string): number {
  return s.replace(ANSI, "").length;
}
