import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ConfigOverrides } from "./config.ts";
import { EXIT, ZopsError } from "./errors.ts";
import { GLOBAL_FLAGS, parseArgs } from "./spec.ts";

const ENV_KEYS = [
  "ZEROPS_TOKEN",
  "ZEROPS_PROFILE",
  "ZEROPS_REGION",
  "ZEROPS_PROJECT",
  "ZEROPS_PROJECT_ID",
  "ZEROPS_SERVICE",
  "ZEROPS_SERVICE_ID",
  "ZEROPS_API_URL",
];

let dir: string;
let userConfig: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zops-config-"));
  userConfig = join(dir, "config.json");
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function writeUser(config: unknown) {
  writeFileSync(userConfig, JSON.stringify(config));
}

/** Everything but the user config path; `cwd` is the temp dir so no repo .zops.json leaks in. */
function load(overrides: ConfigOverrides = {}) {
  return loadConfig({ cwd: dir, userConfig, ...overrides });
}

const PROFILES = {
  profiles: {
    alpha: { token: "fake-alpha", project: "shop", region: "prg2" },
    beta: { tokenCommand: "printf fake-beta" },
  },
};

describe("existing configs", () => {
  test("a top-level token works exactly as before", () => {
    writeUser({ token: "fake-top", project: "legacy", region: "prg1" });
    const config = load();
    expect(config.token).toBe("fake-top");
    expect(config.project).toBe("legacy");
    expect(config.profile).toBeUndefined();
    expect(config.tokenSource).toBe(userConfig);
  });

  test("defining profiles does not change anything until one is selected", () => {
    writeUser({ token: "fake-top", ...PROFILES });
    expect(load().token).toBe("fake-top");
  });
});

describe("profile selection", () => {
  test("`profile` in the user config selects a profile", () => {
    writeUser({ token: "fake-top", project: "legacy", profile: "alpha", ...PROFILES });
    const config = load();
    expect(config.profile).toBe("alpha");
    expect(config.profileSource).toBe(userConfig);
    expect(config.token).toBe("fake-alpha");
    expect(config.project).toBe("shop");
    expect(config.region).toBe("prg2");
    expect(config.apiUrl).toBe("https://api.app-prg2.zerops.io");
    expect(config.tokenSource).toBe("profile alpha");
  });

  test("a profile does not inherit the top-level token or project", () => {
    writeUser({ token: "fake-top", project: "legacy", profiles: { empty: { region: "prg1" } } });
    const config = load({ profile: "empty" });
    expect(config.token).toBeUndefined();
    expect(config.project).toBeUndefined();
  });

  test("flag beats environment beats the stored selection", () => {
    writeUser({ profile: "alpha", ...PROFILES });
    process.env.ZEROPS_PROFILE = "beta";
    expect(load().profile).toBe("beta");
    expect(load().profileSource).toBe("environment");
    expect(load({ profile: "alpha" }).profile).toBe("alpha");
    expect(load({ profile: "alpha" }).profileSource).toBe("flag");
  });

  test("a value the parser took from ZEROPS_PROFILE is reported as the environment", () => {
    writeUser(PROFILES);
    process.env.ZEROPS_PROFILE = "beta";
    const parsed = parseArgs([], GLOBAL_FLAGS);
    expect(parsed.flags.profile).toBe("beta");
    const config = load({ profile: parsed.flags.profile as string, fromEnv: parsed.fromEnv });
    expect(config.profileSource).toBe("environment");
  });

  test("an unknown profile fails when the token is needed, naming the alternatives", () => {
    writeUser(PROFILES);
    const config = load({ profile: "gamma" });
    let error: unknown;
    try {
      void config.token;
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ZopsError);
    expect((error as ZopsError).exitCode).toBe(EXIT.USAGE);
    expect((error as ZopsError).hint).toContain("alpha, beta");
  });

  test("a repo config file cannot select a profile", () => {
    writeUser(PROFILES);
    writeFileSync(join(dir, ".zops.json"), JSON.stringify({ profile: "alpha", project: "pinned" }));
    const config = load();
    expect(config.profile).toBeUndefined();
    expect(config.project).toBe("pinned");
  });
});

describe("tokenCommand", () => {
  test("prints the token, trimmed", () => {
    writeUser({ profiles: { beta: { tokenCommand: "printf '  fake-beta\\n'" } } });
    const config = load({ profile: "beta" });
    expect(config.token).toBe("fake-beta");
    expect(config.tokenSource).toBe("profile beta (tokenCommand)");
  });

  test("runs only when the token is read, and only once", () => {
    const marker = join(dir, "ran");
    writeUser({ profiles: { beta: { tokenCommand: `echo x >> '${marker}'; printf fake-beta` } } });
    const config = load({ profile: "beta" });
    expect(existsSync(marker)).toBe(false);
    expect(config.token).toBe("fake-beta");
    expect(config.token).toBe("fake-beta");
    expect(Bun.file(marker).size).toBe(2);
  });

  test("a failing command is an auth error that quotes its stderr", () => {
    writeUser({ profiles: { beta: { tokenCommand: "echo 'item not found' >&2; exit 44" } } });
    const config = load({ profile: "beta" });
    expect(() => config.token).toThrow(/exited with 44: item not found/);
    try {
      void load({ profile: "beta" }).token;
    } catch (err) {
      expect((err as ZopsError).exitCode).toBe(EXIT.AUTH);
    }
  });

  test("a command that prints nothing is an error, not an empty token", () => {
    writeUser({ profiles: { beta: { tokenCommand: "true" } } });
    expect(() => load({ profile: "beta" }).token).toThrow(/printed nothing/);
  });

  test("a literal token beats a tokenCommand in the same profile", () => {
    writeUser({ profiles: { both: { token: "fake-literal", tokenCommand: "exit 1" } } });
    expect(load({ profile: "both" }).token).toBe("fake-literal");
  });

  test("a repo config file's tokenCommand is never run", () => {
    const marker = join(dir, "pwned");
    writeFileSync(join(dir, ".zops.json"), JSON.stringify({ tokenCommand: `touch '${marker}'` }));
    expect(load().token).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });
});

describe("precedence", () => {
  test("ZEROPS_TOKEN beats the profile, with a warning", () => {
    writeUser(PROFILES);
    process.env.ZEROPS_TOKEN = "fake-env";
    const config = load({ profile: "alpha" });
    expect(config.token).toBe("fake-env");
    expect(config.tokenSource).toBe("environment");
    expect(config.warnings).toEqual(["ZEROPS_TOKEN overrides the token of profile 'alpha'"]);
  });

  test("--token beats the profile without a warning, since it was asked for", () => {
    writeUser(PROFILES);
    const config = load({ profile: "beta", token: "fake-flag" });
    expect(config.token).toBe("fake-flag");
    expect(config.tokenSource).toBe("flag");
    expect(config.warnings).toEqual([]);
  });

  test("a repo's project beats the profile's project; flags beat both", () => {
    writeUser(PROFILES);
    writeFileSync(join(dir, ".zops.json"), JSON.stringify({ project: "pinned" }));
    expect(load({ profile: "alpha" }).project).toBe("pinned");
    expect(load({ profile: "alpha", project: "typed" }).project).toBe("typed");
  });

  test("the profile's region is not overridden by a built-in default", () => {
    writeUser(PROFILES);
    const parsed = parseArgs([], GLOBAL_FLAGS);
    expect(parsed.flags.region).toBeUndefined();
    expect(load({ profile: "alpha", region: parsed.flags.region as string | undefined }).region).toBe("prg2");
    expect(load({ profile: "beta" }).region).toBe("prg1");
  });
});
