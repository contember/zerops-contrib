import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `zops tunnel` end to end against a stand-in API and a fake wireproxy
 * (fixtures/fake-wireproxy.ts), so the whole lifecycle runs without a network: key registered,
 * config handed over on stdin, forwards verified, command run, key deleted, on every path.
 */
const PROJECT_ID = "Pr0jectIdForTests00001";
const FAKE = join(import.meta.dir, "fixtures", "fake-wireproxy.ts");
const SETUP = {
  project: {
    publicKey: "c2VydmVyLXB1YmxpYy1rZXktZm9yLXRlc3RzLW9ubHk=",
    ipv4: { sharedEndpoint: "127.0.0.1:9", network: { network: "10.14.124.1/22", gateway: "10.14.124.1" } },
    ipv6: { sharedEndpoint: "127.0.0.1:9", network: { network: "fda0::/64", gateway: "fda0::1" } },
  },
  peer: {
    ipv4: { assignedIpAddress: "10.14.128.4", network: { network: "10.14.128.0/22" } },
    ipv6: { assignedIpAddress: "fda1::4", network: { network: "fda1::/64" } },
  },
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let report: string;
const created: string[] = [];
const deleted: string[] = [];
/** Makes the stand-in API answer CreateProjectVpn with this status, after storing the key. */
let createStatus = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace("/api/rest/public", "");
      if (req.method === "GET" && path === `/project/${PROJECT_ID}`) {
        return Response.json({ id: PROJECT_ID, name: "shop", status: "ACTIVE", clientId: "c1" });
      }
      const byName = /^\/service-stack-by-name\/[^/]+\/([^/]+)$/.exec(path);
      if (req.method === "GET" && byName) {
        return ["db", "cache"].includes(byName[1]!)
          ? Response.json({ id: `svc-${byName[1]}`, name: byName[1], status: "ACTIVE" })
          : Response.json({ error: { code: "serviceStackNotFound", message: "not found" } }, { status: 404 });
      }
      if (req.method === "GET" && path === `/project/${PROJECT_ID}/service-stack`) {
        return Response.json({ items: [{ id: "svc-db", name: "db" }, { id: "svc-cache", name: "cache" }] });
      }
      if (path === `/project/${PROJECT_ID}/vpn`) {
        const { publicKey } = (await req.json()) as { publicKey: string };
        if (req.method === "POST") {
          created.push(publicKey);
          if (createStatus !== 200) return Response.json({ error: { code: "internal", message: "boom" } }, { status: createStatus });
          return Response.json(SETUP);
        }
        if (req.method === "DELETE") {
          deleted.push(publicKey);
          return Response.json({ success: true });
        }
      }
      return Response.json({ error: { code: "notFound", message: `${req.method} ${path}` } }, { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zops-tunnel-test-"));
  report = join(home, "report.json");
  created.length = 0;
  deleted.length = 0;
  createStatus = 200;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env(extra),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  NO_COLOR: "1",
  XDG_CONFIG_HOME: home,
  ZEROPS_TOKEN: "fake-token",
  ZEROPS_PROFILE: "",
  ZEROPS_PROJECT: "",
  ZEROPS_API_URL: `http://localhost:${server.port}`,
  ZOPS_WIREPROXY: FAKE,
  FAKE_WIREPROXY_REPORT: report,
  ...extra,
});
const stateDir = () => join(home, "zops", "tunnels");
const records = () => (existsSync(stateDir()) ? readdirSync(stateDir()).filter((n) => n.endsWith(".json")) : []);
const recordFile = (publicKey: string) =>
  join(stateDir(), `${createHash("sha256").update(publicKey).digest("hex").slice(0, 16)}.json`);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}
const PROBE = "import socket,sys; print(socket.create_connection(('127.0.0.1', int(sys.argv[1]))).recv(100).decode().strip())";

describe("zops tunnel", () => {
  test("runs a command through the tunnel, passes its exit code on, and deletes the key", async () => {
    const { stdout, stderr, exitCode } = await run([
      "tunnel", "db:5432", "-P", PROJECT_ID, "--",
      "sh", "-c", `python3 -c "${PROBE}" "$1"; echo "env=$ZOPS_TUNNEL_HOST:$ZOPS_TUNNEL_PORT arg=$1"; exit 7`, "sh", "{port}",
    ]);
    expect(exitCode).toBe(7);
    const [pong, envLine] = stdout.trim().split("\n");
    expect(pong).toBe("PONG db.zerops:5432");
    const port = /arg=(\d+)/.exec(envLine!)![1];
    expect(envLine).toBe(`env=127.0.0.1:${port} arg=${port}`);

    // One fresh key: registered, handed to wireproxy as its private half, then deleted.
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(created);
    const seen = JSON.parse(readFileSync(report, "utf8"));
    expect(seen.publicKey).toBe(created[0]);
    // The config, private key included, travels on stdin and never touches the disk.
    expect(seen.configPath).toBe("/dev/stdin");
    expect(seen.checkAlive).toBe(true);
    expect(alive(seen.pid)).toBe(false);
    expect(records()).toEqual([]);
    expect(`${stdout}${stderr}`).not.toContain("PrivateKey");
  });

  test("without a command, prints the forwards and closes after --ttl", async () => {
    const { stdout, exitCode } = await run(["tunnel", "db:5432:0", "cache:6379", "-P", PROJECT_ID, "--ttl", "1s", "--json"]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.project).toBe("shop");
    expect(out.tunnels.map((t: { service: string; port: number }) => `${t.service}:${t.port}`)).toEqual(["db:5432", "cache:6379"]);
    for (const t of out.tunnels) expect(t.local).toBe(`127.0.0.1:${t.localPort}`);
    expect(deleted).toEqual(created);
    expect(records()).toEqual([]);
  });

  test("an unknown service fails before any key is registered", async () => {
    const { stderr, exitCode } = await run(["tunnel", "nope:5432", "-P", PROJECT_ID, "--", "true"]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain("no service named 'nope'");
    expect(created).toEqual([]);
  });

  test("a wireproxy that fails to start is reported, and its key is still deleted", async () => {
    const { stderr, exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"], { FAKE_WIREPROXY_FAIL: "1" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("wireproxy exited before the tunnel was up: invalid base64 string: [redacted]");
    expect(stderr).not.toContain("iKfPMINJ");
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(created);
    expect(records()).toEqual([]);
  });

  test("a forward port held by another process fails closed: the command never runs", async () => {
    // Stands in for a local process that grabbed the port between zops picking it and wireproxy
    // binding it; it would otherwise receive whatever the command sends, credentials included.
    const squatter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open: (s) => void s.end("SQUAT\n") } });
    try {
      const marker = join(home, "ran");
      const { stderr, exitCode } = await run(
        ["tunnel", `db:5432:${squatter.port}`, "-P", PROJECT_ID, "--", "touch", marker],
        { FAKE_WIREPROXY_SKIP: String(squatter.port) },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`127.0.0.1:${squatter.port} is not held by wireproxy`);
      expect(existsSync(marker)).toBe(false);
      expect(deleted).toEqual(created);
    } finally {
      squatter.stop(true);
    }
  });

  test("without wireproxy it says how to get it and registers nothing", async () => {
    const { stderr, exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID], { ZOPS_WIREPROXY: "", PATH: "/nonexistent" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("wireproxy not found");
    expect(stderr).toContain("github.com/windtf/wireproxy");
    expect(created).toEqual([]);
  });

  test("deletes keys and stops wireproxies that killed runs left behind, in this project only", async () => {
    mkdirSync(stateDir(), { recursive: true });
    // As zops records it: pinned to UTC and the C locale.
    const lstart = (pid: number) =>
      Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
        stdout: "pipe",
        env: { PATH: process.env.PATH!, LC_ALL: "C", TZ: "UTC" },
      }).stdout.toString().trim();
    // A dead zops whose wireproxy is still running.
    const orphan = Bun.spawn(["sleep", "30"]);
    const dead = { projectId: PROJECT_ID, publicKey: "dead-key", pid: 2 ** 22 + 1, pidStarted: null, wireproxyPid: orphan.pid, wireproxyStarted: lstart(orphan.pid), startedAt: "2026-11-04T00:00:00Z" };
    // A live pid that was reused after the zops recorded under it died (start time differs).
    const reused = { ...dead, publicKey: "reused-pid-key", pid: process.pid, pidStarted: "Thu Jan  1 00:00:00 2015", wireproxyPid: undefined, wireproxyStarted: undefined };
    // Another project's leftovers are not this run's to touch.
    const other = { ...dead, projectId: "OtherProjectId00000001", publicKey: "other-project-key", wireproxyPid: undefined };
    for (const r of [dead, reused, other]) writeFileSync(recordFile(r.publicKey), JSON.stringify(r));

    const { exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"]);
    expect(exitCode).toBe(0);
    expect(deleted.slice(0, 2).sort()).toEqual(["dead-key", "reused-pid-key"]);
    expect(deleted[2]).toBe(created[0]!);
    expect(records()).toEqual([recordFile("other-project-key").split("/").pop()!]);
    await orphan.exited;
    expect(orphan.signalCode).toBe("SIGTERM");
  });

  test("a signal before the tunnel is up still deletes the key and stops wireproxy", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"], {
      stdout: "pipe",
      stderr: "pipe",
      env: env({ FAKE_WIREPROXY_DELAY_MS: "20000" }),
    });
    await until(() => created.length === 1 && existsSync(report));
    const fakePid = JSON.parse(readFileSync(report, "utf8")).pid as number;
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(deleted).toEqual(created);
    expect(alive(fakePid)).toBe(false);
    expect(records()).toEqual([]);
  });

  test("Ctrl-C in the terminal reaches the command but not the tunnel", async () => {
    // Its own process group, like a shell job: the group signal below is what a terminal sends.
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--",
        "sh", "-c", `trap "" INT; sleep 1.5; python3 -c "${PROBE}" "$1"`, "sh", "{port}",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"], env: env() },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await until(() => stderr.includes("→"));
    process.kill(-child.pid!, "SIGINT");
    expect(await exited).toBe(0);
    expect(stdout.trim()).toBe("PONG db.zerops:5432");
    expect(deleted).toEqual(created);
  });

  test("a held tunnel closes promptly on SIGINT with 130, however long its --ttl", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--ttl", "1h"], {
      stdout: "pipe",
      stderr: "pipe",
      env: env(),
    });
    try {
      let stderr = "";
      void (async () => {
        for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
      })();
      await until(() => stderr.includes("→"));
      const started = Date.now();
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(deleted).toEqual(created);
      expect(records()).toEqual([]);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("a tunnel that never answers times out under --timeout and cleans up", async () => {
    const { stderr, exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--timeout", "2s", "--", "true"], {
      FAKE_WIREPROXY_UNREACHABLE: "1",
    });
    expect(exitCode).toBe(7);
    expect(stderr).toContain("the tunnel did not come up within 2s");
    expect(stderr).not.toContain("Health metric request");
    expect(deleted).toEqual(created);
  });

  test("concurrent tunnels each clean up their own key", async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"])));
    expect(runs.map((r) => r.exitCode)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(new Set(created).size).toBe(6);
    expect([...deleted].sort()).toEqual([...created].sort());
    expect(records()).toEqual([]);
  });

  test("a tunnel started under another TZ or locale leaves a live tunnel's key alone", async () => {
    const held = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--ttl", "1m"], {
      stdout: "pipe",
      stderr: "pipe",
      env: env({ TZ: "America/Los_Angeles", LC_ALL: "en_US.UTF-8" }),
    });
    try {
      let stderr = "";
      void (async () => {
        for await (const chunk of held.stderr) stderr += new TextDecoder().decode(chunk);
      })();
      await until(() => stderr.includes("→"));
      const heldKey = created[0]!;
      const other = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"], { TZ: "Asia/Tokyo", LC_ALL: "C" });
      expect(other.exitCode).toBe(0);
      expect(other.stderr).not.toContain("left behind");
      expect(deleted).not.toContain(heldKey);
      held.kill("SIGINT");
      expect(await held.exited).toBe(130);
      expect(deleted).toContain(heldKey);
    } finally {
      held.kill("SIGKILL");
    }
  });

  test("a 5xx on registration still deletes the key, which the server may have stored", async () => {
    createStatus = 502;
    const { exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"]);
    expect(exitCode).toBe(6);
    expect(new Set(created).size).toBe(1);
    expect(deleted).toEqual([created[0]!]);
    expect(records()).toEqual([]);
  });

  test("a clear refusal of the key needs no delete", async () => {
    createStatus = 403;
    const { exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"]);
    expect(exitCode).toBe(3);
    expect(deleted).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("a wireproxy path that does not exist or is not executable fails before registering", async () => {
    const missing = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"], { ZOPS_WIREPROXY: "/nonexistent/wireproxy" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("/nonexistent/wireproxy does not exist");
    const plain = join(home, "not-executable");
    writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    const notExec = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"], { ZOPS_WIREPROXY: plain });
    expect(notExec.exitCode).toBe(1);
    expect(notExec.stderr).toContain("is not executable");
    expect(created).toEqual([]);
  });

  test("a closed stdout ends a held tunnel through its teardown", async () => {
    const child = spawn(process.execPath, [join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--ttl", "1m", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env(),
    });
    // Whoever reads the addresses goes away before they are written, like `| true`.
    child.stdout!.destroy();
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code).toBe(0);
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(created);
    expect(records()).toEqual([]);
  });

  test("without a terminal, SIGINT sent to zops alone reaches the command", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), "tunnel", "db:5432", "-P", PROJECT_ID, "--", "sleep", "30"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(),
    });
    try {
      let stderr = "";
      void (async () => {
        for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
      })();
      await until(() => stderr.includes("→"));
      const started = Date.now();
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(deleted).toEqual(created);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("--json after -- does not switch zops's own errors to JSON", async () => {
    const { stderr, exitCode } = await run(["tunnel", "db", "-P", PROJECT_ID, "--", "jq", "--json"]);
    expect(exitCode).toBe(2);
    expect(stderr).toStartWith("error: invalid tunnel target");
  });

  test("dry-run registers nothing", async () => {
    const { stdout, exitCode } = await run(["tunnel", "db:5432:15432", "-P", PROJECT_ID, "--dry-run", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).tunnels).toEqual([{ target: "db.zerops:5432", local: "127.0.0.1:15432" }]);
    expect(created).toEqual([]);
  });

  test("rejects bad targets and duplicate local ports as usage errors", async () => {
    expect((await run(["tunnel", "db", "-P", PROJECT_ID])).exitCode).toBe(2);
    expect((await run(["tunnel", "db:5432:15432", "cache:6379:15432", "-P", PROJECT_ID])).exitCode).toBe(2);
  });

  test("--help after -- belongs to the wrapped command", async () => {
    const { stdout, exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "sh", "-c", "echo wrapped", "sh", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("wrapped");
  });
});
