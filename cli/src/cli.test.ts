import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "./commands/index.ts";
import { VERSION, renderCommandHelp, renderRootHelp } from "./cli.ts";
import { GLOBAL_FLAGS } from "./lib/spec.ts";
import { OPERATIONS, findOperation } from "./lib/operations.ts";
import { ApiClient } from "./lib/http.ts";
import { extractProcess } from "./lib/process.ts";

/**
 * Runs the CLI in a subprocess so exit codes and the stdout/stderr split are observed exactly
 * as a caller would see them. No network: these cases all fail or resolve before any request.
 */
async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", `${import.meta.dir}/index.ts`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      // Neutralise any real credentials or repo config so results are deterministic.
      ZEROPS_TOKEN: "",
      ZEROPS_PROFILE: "",
      ZEROPS_PROJECT: "",
      ZEROPS_SERVICE: "",
      XDG_CONFIG_HOME: "/nonexistent-zops-test-home",
      ...env,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("command specs", () => {
  test("command paths are unique", () => {
    const names = COMMANDS.map((c) => c.path.join(" "));
    expect(new Set(names).size).toBe(names.length);
  });

  test("no command flag collides with a global flag", () => {
    const globals = new Set(GLOBAL_FLAGS.map((f) => f.name));
    for (const command of COMMANDS) {
      for (const flag of command.flags ?? []) {
        expect({ command: command.path.join(" "), flag: flag.name, collides: globals.has(flag.name) })
          .toEqual({ command: command.path.join(" "), flag: flag.name, collides: false });
      }
    }
  });

  test("every command has a summary and every flag a description", () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(10);
      for (const flag of command.flags ?? []) expect(flag.description.length).toBeGreaterThan(5);
      for (const arg of command.args ?? []) expect(arg.description.length).toBeGreaterThan(5);
    }
  });

  test("declared API operations all exist in the generated index", () => {
    for (const command of COMMANDS) {
      for (const id of command.operations ?? []) {
        expect({ command: command.path.join(" "), id, found: Boolean(findOperation(id)) })
          .toEqual({ command: command.path.join(" "), id, found: true });
      }
    }
  });

  test("help renders for every command", () => {
    for (const command of COMMANDS) {
      const help = renderCommandHelp(command);
      expect(help).toContain(`zops ${command.path.join(" ")}`);
      expect(help).toContain("Global flags:");
    }
    expect(renderRootHelp()).toContain("Exit codes:");
  });
});

describe("generated operations", () => {
  test("covers the whole documented API surface", () => {
    expect(OPERATIONS.length).toBe(247 + 17);
  });

  test("resolves ids case-insensitively but keeps genuinely distinct ids apart", () => {
    expect(findOperation("restartservicestack")?.id).toBe("RestartServiceStack");
    // These two differ only by case and are different endpoints; exact casing must win.
    expect(findOperation("getUserInfo")?.path).toBe("/api/rest/public/auth/info");
    expect(findOperation("GetUserInfo")?.path).toBe("/api/rest/public/user/info");
  });
});

describe("process extraction", () => {
  test("reads the flat ResponseProcess shape", () => {
    expect(extractProcess({ id: "p1", actionName: "restart" })).toEqual({ id: "p1", actionName: "restart" });
  });

  test("reads the nested ResponseProcessNil shape", () => {
    expect(extractProcess({ process: { id: "p2" } })).toEqual({ id: "p2", actionName: undefined });
  });

  test("prefers the nested process over a sibling id", () => {
    // CreateServiceStack answers with the new service's own id alongside the provisioning
    // process; waiting on the service id would never find a process.
    expect(extractProcess({ id: "serviceId", process: { id: "p3" } })?.id).toBe("p3");
  });

  test("treats a missing process as work that already finished", () => {
    expect(extractProcess({ process: null })).toBeNull();
    expect(extractProcess(undefined)).toBeNull();
    expect(extractProcess({})).toBeNull();
  });
});

describe("path building", () => {
  test("interpolates and encodes parameters", () => {
    expect(ApiClient.buildPath("/a/{id}/b", { id: "xyz" })).toBe("/a/xyz/b");
    expect(ApiClient.buildPath("/a/{name}", { name: "a b" })).toBe("/a/a%20b");
  });

  test("keeps slashes in a greedy {path:.*} segment", () => {
    expect(ApiClient.buildPath("/purge/{path:.*}", { path: "images/logo.png" })).toBe("/purge/images/logo.png");
  });

  test("fails loudly on a missing parameter", () => {
    expect(() => ApiClient.buildPath("/a/{id}", {})).toThrow(/missing path parameter/);
  });
});

describe("cli behaviour", () => {
  test("exits 0 and prints help on --help", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("agent-first CLI");
  });

  test("exits 2 with a hint on an unknown command", async () => {
    const { stderr, stdout, exitCode } = await runCli(["frobnicate"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown command");
  });

  test("exits 2 on an unknown flag", async () => {
    expect((await runCli(["service", "list", "--bogus"])).exitCode).toBe(2);
  });

  test("exits 3 when no token is configured", async () => {
    const { stderr, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("no access token");
  });

  test("errors are JSON on stderr, leaving stdout clean for jq", async () => {
    const { stdout, stderr, exitCode } = await runCli(["auth", "status", "--json"]);
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    const parsed = JSON.parse(stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.exitCode).toBe(3);
    expect(parsed.error.retriable).toBe(false);
    expect(typeof parsed.error.hint).toBe("string");
  });

  test("a global flag before the command still resolves the command", async () => {
    // Regression: the flag's value used to be mistaken for the command word.
    const { stderr, exitCode } = await runCli(["--token", "zopsbogus", "auth", "status", "--region", "prg1"]);
    expect(stderr).not.toContain("unknown command");
    expect(exitCode).not.toBe(2);
  });

  test("lists a group when given only the group name", async () => {
    const { stdout, exitCode } = await runCli(["backup"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("backup create");
  });

  test("api --list covers every operation and -q prints bare ids", async () => {
    const { stdout, exitCode } = await runCli(["api", "--list", "-q"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(247 + 17);
  });

  test("api --describe prints an expanded schema without hitting the network", async () => {
    const { stdout, exitCode } = await runCli(["api", "--describe", "ConfigureAutoscaling", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.method).toBe("PUT");
    expect(parsed.bodySchemaExpanded.properties.customAutoscaling).toBeDefined();
  });

  test("commands --json is a complete, parseable catalog", async () => {
    const { stdout, exitCode } = await runCli(["commands", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.tool).toBe("zops");
    expect(parsed.commands.length).toBe(COMMANDS.length);
    expect(parsed.exitCodes["8"]).toContain("remote operation");
    expect(parsed.documentedOperationCount).toBe(247);
    expect(parsed.undocumentedOperationCount).toBe(17);
  });

  test("destructive commands refuse to run unattended without --yes", async () => {
    const { stderr, exitCode } = await runCli(["service", "delete", "x"], {
      ZEROPS_TOKEN: "zopsbogus",
      ZEROPS_PROJECT: "p",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--yes|token|not authorized/i);
  });
});

describe("profiles", () => {
  // A stand-in for the API that answers GetUserInfo with an organization derived from the bearer
  // token, so a test can see which token a command actually sent. Tokens here are fake.
  let server: ReturnType<typeof Bun.serve>;
  let home: string;
  const seen: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        seen.push(token);
        if (!token.startsWith("fake-")) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
        return Response.json({
          id: "u1",
          email: "someone@example.com",
          fullName: "Someone",
          status: "ACTIVE",
          clientUserList: [{ clientId: `client-${token}`, status: "ACTIVE", roleCode: "ADMIN", client: { accountName: `org of ${token}` } }],
        });
      },
    });
    home = mkdtempSync(join(tmpdir(), "zops-profiles-"));
  });

  afterAll(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  const cli = (args: string[], env: Record<string, string> = {}) =>
    runCli(args, { XDG_CONFIG_HOME: home, ZEROPS_API_URL: `http://localhost:${server.port}`, ...env });
  const stored = () => JSON.parse(readFileSync(join(home, "zops", "config.json"), "utf8"));

  test("login with --token-command stores the command, never the token, and selects the first profile", async () => {
    const { stdout, exitCode } = await cli(["auth", "login", "--profile", "alpha", "--project", "shop", "--token-command", "printf fake-alpha", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("fake-alpha\"");
    expect(JSON.parse(stdout)).toMatchObject({ saved: true, profile: "alpha", selected: true, credential: "tokenCommand" });
    expect(stored()).toEqual({ profile: "alpha", profiles: { alpha: { tokenCommand: "printf fake-alpha", project: "shop" } } });
    expect(seen.at(-1)).toBe("fake-alpha");
  });

  test("a second profile does not take over the selection", async () => {
    const { stdout, exitCode } = await cli(["auth", "login", "--profile", "beta", "--token-command", "printf fake-beta", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).selected).toBe(false);
    expect(stored().profile).toBe("alpha");
  });

  test("auth status reports the profile and where the token came from, and sends that token", async () => {
    const { stdout, exitCode } = await cli(["auth", "status", "--json"]);
    expect(exitCode).toBe(0);
    const status = JSON.parse(stdout);
    expect(status).toMatchObject({ profile: "alpha", tokenSource: "profile alpha (tokenCommand)", project: "shop" });
    expect(status.organization).toBe("org of fake-alpha");
    expect(stdout).not.toContain("\"fake-alpha\"");
  });

  test("--profile and ZEROPS_PROFILE switch the organization for one command", async () => {
    expect(JSON.parse((await cli(["auth", "status", "--profile", "beta", "--json"])).stdout).organization).toBe("org of fake-beta");
    const viaEnv = JSON.parse((await cli(["auth", "status", "--json"], { ZEROPS_PROFILE: "beta" })).stdout);
    expect(viaEnv).toMatchObject({ profile: "beta", profileSource: "environment" });
  });

  test("ZEROPS_TOKEN still wins, with a warning on stderr", async () => {
    const json = await cli(["auth", "status", "--json"], { ZEROPS_TOKEN: "fake-env" });
    expect(JSON.parse(json.stdout)).toMatchObject({ tokenSource: "environment", organization: "org of fake-env" });
    // Warnings are human output; --json keeps stderr for the error envelope only.
    const { stderr } = await cli(["auth", "status"], { ZEROPS_TOKEN: "fake-env" });
    expect(stderr).toContain("ZEROPS_TOKEN overrides the token of profile 'alpha'");
  });

  test("profile list shows credentials by kind, not by value", async () => {
    const { stdout, exitCode } = await cli(["profile", "list", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { name: "alpha", active: true, credential: "tokenCommand", project: "shop", service: null, region: null, tokenCommand: "printf fake-alpha" },
      { name: "beta", active: false, credential: "tokenCommand", project: null, service: null, region: null, tokenCommand: "printf fake-beta" },
    ]);
  });

  test("profile use switches the default and rejects unknown names", async () => {
    expect((await cli(["profile", "use", "beta"])).exitCode).toBe(0);
    expect(stored().profile).toBe("beta");
    const missing = await cli(["profile", "use", "gamma"]);
    expect(missing.exitCode).toBe(4);
    expect(missing.stderr).toContain("alpha, beta");
    expect(stored().profile).toBe("beta");
  });

  test("an unknown --profile is a usage error, not a silent fallback", async () => {
    const { stderr, exitCode } = await cli(["auth", "status", "--profile", "gamma"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no profile named 'gamma'");
  });

  test("a literal token in a profile is stored with 0600 and never echoed", async () => {
    const { stdout, exitCode } = await cli(["auth", "login", "--profile", "gamma", "fake-gamma", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("fake-gamma");
    expect(stored().profiles.gamma).toEqual({ token: "fake-gamma" });
    const mode = (await Bun.file(join(home, "zops", "config.json")).stat()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("logout --profile removes the profile and clears a selection pointing to it", async () => {
    expect((await cli(["auth", "logout", "--profile", "beta"])).exitCode).toBe(0);
    expect(stored().profile).toBeUndefined();
    expect(Object.keys(stored().profiles)).toEqual(["alpha", "gamma"]);
  });

  test("scale set takes the autoscaling profile as --autoscaling-profile", async () => {
    const { stdout, exitCode } = await cli(["scale", "set", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--autoscaling-profile <id>");
  });
});

describe("version", () => {
  // Three files carry the version and nothing derives one from another, so only a test keeps
  // `zops --version` honest about which plugin release the user actually installed.
  test("cli.ts, package.json and the plugin manifest agree", async () => {
    const root = `${import.meta.dir}/../..`;
    const pkg = await Bun.file(`${root}/cli/package.json`).json();
    const plugin = await Bun.file(`${root}/.claude-plugin/plugin.json`).json();

    expect(pkg.version).toBe(VERSION);
    expect(plugin.version).toBe(VERSION);
  });
});
