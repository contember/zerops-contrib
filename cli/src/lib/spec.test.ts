import { describe, expect, test } from "bun:test";
import { parseArgs, parseDuration, GLOBAL_FLAGS, type FlagSpec } from "./spec.ts";
import { ZopsError, EXIT } from "./errors.ts";

const FLAGS: FlagSpec[] = [
  { name: "name", type: "string", description: "" },
  { name: "count", type: "number", description: "" },
  { name: "tag", type: "string[]", description: "" },
  { name: "force", short: "f", type: "boolean", description: "" },
  { name: "wait", type: "boolean", default: true, description: "" },
  { name: "mode", type: "string", enum: ["a", "b"], description: "" },
];

const parse = (argv: string[]) => parseArgs(argv, FLAGS);

describe("parseArgs", () => {
  test("separates positionals from flags", () => {
    const r = parse(["one", "--name", "x", "two"]);
    expect(r.args).toEqual(["one", "two"]);
    expect(r.flags.name).toBe("x");
  });

  test("accepts --flag=value and coerces numbers", () => {
    const r = parse(["--name=x", "--count=7"]);
    expect(r.flags.name).toBe("x");
    expect(r.flags.count).toBe(7);
  });

  test("collects repeatable flags", () => {
    expect(parse(["--tag", "a", "--tag", "b"]).flags.tag).toEqual(["a", "b"]);
  });

  test("supports short booleans and --no- negation", () => {
    expect(parse(["-f"]).flags.force).toBe(true);
    expect(parse([]).flags.wait).toBe(true);
    expect(parse(["--no-wait"]).flags.wait).toBe(false);
  });

  test("passes everything after -- through untouched", () => {
    const r = parse(["a", "--", "--not-a-flag", "-x"]);
    expect(r.args).toEqual(["a"]);
    expect(r.rest).toEqual(["--not-a-flag", "-x"]);
  });

  test("treats a bare - as a positional, since it means stdin", () => {
    expect(parse(["KEY", "-"]).args).toEqual(["KEY", "-"]);
  });

  test("rejects unknown flags rather than silently ignoring them", () => {
    expect(() => parse(["--nope"])).toThrow(ZopsError);
    try {
      parse(["--nope"]);
    } catch (err) {
      expect((err as ZopsError).exitCode).toBe(EXIT.USAGE);
    }
  });

  test("rejects values outside an enum and non-numeric numbers", () => {
    expect(() => parse(["--mode", "c"])).toThrow(/one of: a, b/);
    expect(() => parse(["--count", "abc"])).toThrow(/expects a number/);
  });

  test("rejects a flag with a missing value", () => {
    expect(() => parse(["--name"])).toThrow(/expects a value/);
  });

  test("falls back to the environment, but a flag still wins", () => {
    const specs: FlagSpec[] = [{ name: "token", type: "string", env: "ZZ_TEST_TOKEN", description: "" }];
    process.env.ZZ_TEST_TOKEN = "from-env";
    try {
      expect(parseArgs([], specs).flags.token).toBe("from-env");
      expect(parseArgs(["--token", "from-flag"], specs).flags.token).toBe("from-flag");
    } finally {
      delete process.env.ZZ_TEST_TOKEN;
    }
  });
});

describe("parseDuration", () => {
  test("parses the documented forms", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("90")).toBe(90_000);
  });

  test("rejects nonsense", () => {
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
  });
});

describe("global flags", () => {
  test("every global flag documents itself", () => {
    for (const flag of GLOBAL_FLAGS) {
      expect(flag.description.length).toBeGreaterThan(10);
    }
  });
});
