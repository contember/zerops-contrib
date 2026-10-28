import { describe, expect, test } from "bun:test";
import { ReplayFilter, logLineFromRow, logsqlParams, parseLogsqlRows, timestampNanos } from "./logs.ts";

describe("logsqlParams", () => {
  test("keeps the scope and the flag filters out of the query text", () => {
    const params = logsqlParams({
      serviceStackId: "svc1",
      facility: 16,
      minimumSeverity: 3,
      tags: ["zbuilder@v1"],
      query: "crond or *",
      limit: 10,
    });
    expect(params.get("query")).toBe("crond or *");
    expect(params.get("extra_stream_filters")).toBe('{stackId="svc1"}');
    expect(params.get("extra_filters")).toBe('facility:=16 severity:<=3 appName:in("zbuilder@v1")');
    expect(params.get("limit")).toBe("10");
  });

  test("matches --grep as a literal substring", () => {
    const params = logsqlParams({ serviceStackId: "svc1", grep: 'a.b "c"', limit: 1 });
    expect(params.get("query")).toBe("*");
    expect(params.get("extra_filters")).toBe(String.raw`_msg:~"a\\.b \"c\""`);
  });

  test("sends the time range as RFC 3339", () => {
    const params = logsqlParams({
      serviceStackId: "svc1",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-02T00:00:00Z"),
      limit: 1,
    });
    expect(params.get("start")).toBe("2026-10-01T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-10-02T00:00:00.000Z");
    expect(params.has("extra_filters")).toBe(false);
  });
});

describe("LogsQL rows", () => {
  test("parses JSON lines and turns log rows into log lines", () => {
    const rows = parseLogsqlRows(
      '{"_time":"2026-10-19T00:26:01.980606Z","_msg":"boom","severity":"3","facility":"16","appName":"zerops@zerops","hostname":"h"}\n' +
        '{"severity":"6","lines":"558"}\n',
    );
    expect(logLineFromRow(rows[0]!)).toEqual({
      timestamp: "2026-10-19T00:26:01.980606Z",
      severity: 3,
      severityLabel: "Error",
      facility: 16,
      tag: "zerops@zerops",
      hostname: "h",
      message: "boom",
    });
    expect(logLineFromRow(rows[1]!)).toBeNull();
  });

  test("an empty message is an absent _msg", () => {
    const [row] = parseLogsqlRows('{"_time":"2026-10-19T00:26:01Z"}');
    expect(logLineFromRow(row!)?.message).toBe("");
  });
});

describe("timestampNanos", () => {
  test("orders lines that share a millisecond", () => {
    expect(timestampNanos("2026-10-19T00:26:01.980596Z")).toBeLessThan(timestampNanos("2026-10-19T00:26:01.980606Z"));
    expect(timestampNanos("2026-10-19T00:26:01Z")).toBe(timestampNanos("2026-10-19T00:26:01.000000000Z"));
  });

  test("rejects a timestamp it cannot read", () => {
    expect(() => timestampNanos("19/Oct/2026")).toThrow();
  });
});

describe("ReplayFilter", () => {
  const line = (timestamp: string, message: string) => ({ timestamp, message });

  test("skips the replayed history and passes what is new", () => {
    const filter = new ReplayFilter([
      { ...line("2026-10-19T10:00:00.5Z", "a"), severity: 6, severityLabel: "", facility: 16, tag: "", hostname: "" },
    ]);
    expect(filter.accept(line("2026-10-19T09:00:00Z", "old"))).toBe(false);
    expect(filter.accept(line("2026-10-19T10:00:00.5Z", "a"))).toBe(false);
    expect(filter.accept(line("2026-10-19T10:00:00.5Z", "b"))).toBe(true);
    expect(filter.accept(line("2026-10-19T10:00:01Z", "a"))).toBe(true);
  });

  test("a reconnect replay does not repeat lines", () => {
    const filter = new ReplayFilter([]);
    expect(filter.accept(line("2026-10-19T10:00:00Z", "a"))).toBe(true);
    expect(filter.accept(line("2026-10-19T10:00:01Z", "b"))).toBe(true);
    expect(filter.accept(line("2026-10-19T10:00:00Z", "a"))).toBe(false);
    expect(filter.accept(line("2026-10-19T10:00:01Z", "b"))).toBe(false);
  });
});
