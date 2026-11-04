import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `zops tunnel` end to end against a stand-in API and a fake wireproxy
 * (fixtures/fake-wireproxy.ts), so the whole lifecycle runs without a network: key registered,
 * config handed over and removed, forwards up, command run, key deleted.
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
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      XDG_CONFIG_HOME: home,
      ZEROPS_TOKEN: "fake-token",
      ZEROPS_PROFILE: "",
      ZEROPS_PROJECT: "",
      ZEROPS_API_URL: `http://localhost:${server.port}`,
      ZOPS_WIREPROXY: FAKE,
      FAKE_WIREPROXY_REPORT: report,
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

const stateFile = () => join(home, "zops", "tunnels.json");
const state = () => (existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : []);
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
    expect(existsSync(seen.configPath)).toBe(false);
    expect(existsSync(dirname(seen.configPath))).toBe(false);
    expect(state()).toEqual([]);
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
    expect(stderr).toContain("bad config: Endpoint is unreachable");
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(created);
    expect(state()).toEqual([]);
  });

  test("without wireproxy it says how to get it and registers nothing", async () => {
    const { stderr, exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID], { ZOPS_WIREPROXY: "", PATH: "/nonexistent" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("wireproxy not found");
    expect(stderr).toContain("github.com/windtf/wireproxy");
    expect(created).toEqual([]);
  });

  test("deletes the key a killed run left behind in the same project", async () => {
    mkdirSync(join(home, "zops"), { recursive: true });
    const stale = { projectId: PROJECT_ID, publicKey: "stale-key", pid: 2 ** 22 + 1, startedAt: "2026-11-04T00:00:00Z" };
    const other = { ...stale, projectId: "OtherProjectId00000001", publicKey: "other-project-key" };
    writeFileSync(stateFile(), JSON.stringify([stale, other]));
    const { exitCode } = await run(["tunnel", "db:5432", "-P", PROJECT_ID, "--", "true"]);
    expect(exitCode).toBe(0);
    expect(deleted).toEqual(["stale-key", created[0]!]);
    expect(state()).toEqual([other]);
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
