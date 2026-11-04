import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../lib/context.ts";
import type { CommandSpec } from "../lib/spec.ts";
import { userConfigPath } from "../lib/config.ts";
import { EXIT, ZopsError, usage } from "../lib/errors.ts";
import { parseDuration } from "../lib/spec.ts";
import {
  generateKeyPair,
  parseTarget,
  wireproxyConfig,
  type TunnelTarget,
  type VpnSetup,
} from "../lib/wireguard.ts";

/**
 * Keys this machine registered and has not deleted yet. Public keys and pids only: enough for the
 * next run to remove the peer left behind by a zops that was killed before its teardown.
 */
const STATE_FILE = join(dirname(userConfigPath), "tunnels.json");

interface TunnelRecord {
  projectId: string;
  publicKey: string;
  /** The zops process that owns the key. */
  pid: number;
  /** Its wireproxy, killed by the sweep if it outlived its zops. */
  wireproxyPid?: number;
  startedAt: string;
}

function readState(): TunnelRecord[] {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeState(records: TunnelRecord[]): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when `pid` is a running wireproxy, so a recycled pid is never killed by mistake. */
function isWireproxy(pid: number): boolean {
  if (!alive(pid)) return false;
  const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], { stdout: "pipe", stderr: "ignore" });
  return ps.stdout.toString().includes("wireproxy");
}

async function deleteKey(ctx: Context, projectId: string, publicKey: string): Promise<void> {
  await ctx.api.call("DeleteProjectVpn", { path: { id: projectId }, body: { publicKey } });
}

/** Removes the peers of tunnels in this project whose zops is gone. */
async function sweepStale(ctx: Context, projectId: string): Promise<number> {
  const stale = readState().filter((r) => r.projectId === projectId && !alive(r.pid));
  let removed = 0;
  for (const record of stale) {
    if (record.wireproxyPid && isWireproxy(record.wireproxyPid)) process.kill(record.wireproxyPid, "SIGTERM");
    try {
      await deleteKey(ctx, projectId, record.publicKey);
    } catch (err) {
      // Already gone is fine; anything else stays in the file for the next attempt.
      if (!(err instanceof ZopsError && err.exitCode === EXIT.NOT_FOUND)) continue;
    }
    writeState(readState().filter((r) => r.publicKey !== record.publicKey));
    removed++;
  }
  return removed;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function findWireproxy(explicit: string | undefined): string {
  const found = explicit ?? Bun.which("wireproxy");
  if (!found) {
    throw new ZopsError({
      code: "dependencyMissing",
      message: "wireproxy not found",
      exitCode: EXIT.ERROR,
      hint: "Download it from https://github.com/windtf/wireproxy/releases and put it on PATH, or pass --wireproxy <path> / set ZOPS_WIREPROXY.",
    });
  }
  return found;
}

/** Polls wireproxy's health endpoint until it is ready, or fails with what it printed. */
async function waitReady(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, healthPort: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const stderr = (await new Response(proc.stderr).text()).trim().slice(-500);
      throw new ZopsError({
        code: "tunnelFailed",
        message: `wireproxy exited before the tunnel was up${stderr ? `: ${stderr}` : ""}`,
        exitCode: EXIT.ERROR,
      });
    }
    try {
      const res = await fetch(`http://127.0.0.1:${healthPort}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(150);
  }
  throw new ZopsError({ code: "tunnelFailed", message: "wireproxy did not become ready in time", exitCode: EXIT.TIMEOUT });
}

export const tunnelCommands: CommandSpec[] = [
  {
    path: ["tunnel"],
    summary: "Forward services of a project's private network to 127.0.0.1, without root or a VPN.",
    description: `Connects to the project's private network the way \`zcli vpn up\` does, but in userspace:
wireproxy runs WireGuard on its own network stack and listens on 127.0.0.1 only for the services
you name. No interface, route or DNS setting on this machine changes, so no sudo is needed and a
running \`zcli vpn\` is unaffected.

Each run registers a fresh WireGuard key with the project and deletes it again on exit. The private
key exists only in memory and in a 0600 file in a private temp directory, removed as soon as
wireproxy has read it. A run that was killed leaves its key in ${STATE_FILE} (public key only),
and the next tunnel to the same project deletes it.

With a command after \`--\`, zops runs it once the tunnel is up and exits with its status. In the
command, {port} is replaced by the first tunnel's local port, also exported as ZOPS_TUNNEL_PORT
(and ZOPS_TUNNEL_HOST=127.0.0.1). Without a command, zops prints the local addresses and holds
the tunnel until it is interrupted or --ttl runs out.

Reaching the network is not the same as logging in: database credentials still come from the
service's environment (\`zops env\`). Requires wireproxy (https://github.com/windtf/wireproxy) and a
token with at least the BASIC_USER role in the project.`,
    args: [
      {
        name: "target",
        description: "<service>:<port>[:<local-port>], e.g. db:5432. The local port is picked when omitted.",
        required: true,
        variadic: true,
      },
    ],
    flags: [
      {
        name: "ttl",
        type: "string",
        default: "1h",
        placeholder: "<duration>",
        description: "Without a command, close the tunnel after this long. 0 keeps it until interrupted.",
      },
      {
        name: "wireproxy",
        type: "string",
        env: "ZOPS_WIREPROXY",
        placeholder: "<path>",
        description: "Path to the wireproxy binary when it is not on PATH.",
      },
    ],
    examples: [
      "zops tunnel db:5432 -P myapp -- psql -h 127.0.0.1 -p {port} -U db -c 'select count(*) from orders'",
      "zops tunnel db:5432:15432 cache:6379 -P myapp --ttl 30m",
      "zops tunnel db:5432 -P myapp --dry-run --json",
    ],
    operations: ["CreateProjectVpn", "DeleteProjectVpn"],
    async run(ctx, parsed) {
      const targets = parsed.args.map(parseTarget);
      const locals = targets.map((t) => t.localPort).filter((p) => p !== 0);
      if (new Set(locals).size !== locals.length) throw usage("two targets ask for the same local port");
      const command = parsed.rest;
      const ttlMs = parseDuration(ctx.flag<string>("ttl") ?? "1h");
      const wireproxy = findWireproxy(ctx.flag<string>("wireproxy"));

      const project = await ctx.project();
      // Resolve each hostname now, so a typo fails before a key is registered.
      for (const t of targets) t.service = (await ctx.service(t.service)).name;

      if (ctx.dryRun) {
        return {
          dryRun: true,
          project: project.name,
          operations: ["CreateProjectVpn", "DeleteProjectVpn"],
          tunnels: targets.map((t) => ({ target: `${t.service}.zerops:${t.port}`, local: t.localPort ? `127.0.0.1:${t.localPort}` : "auto" })),
          command: command.length ? command : null,
        };
      }

      const swept = await sweepStale(ctx, project.id);
      if (swept) ctx.out.info(`removed ${swept} key(s) left behind by an earlier tunnel`);

      for (const t of targets) if (!t.localPort) t.localPort = await freePort();
      const healthPort = await freePort();

      const keys = generateKeyPair();
      const setup = await ctx.api.call<VpnSetup>("CreateProjectVpn", {
        path: { id: project.id },
        body: { publicKey: keys.publicKey },
      });
      writeState([
        ...readState(),
        { projectId: project.id, publicKey: keys.publicKey, pid: process.pid, startedAt: new Date().toISOString() },
      ]);

      const dir = mkdtempSync(join(tmpdir(), "zops-tunnel-"));
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
      const stopSignals: (() => void)[] = [];
      try {
        const configPath = join(dir, "wireproxy.conf");
        writeFileSync(configPath, wireproxyConfig(keys.privateKey, setup, targets), { mode: 0o600 });
        proc = Bun.spawn([wireproxy, "-c", configPath, "-s", "-i", `127.0.0.1:${healthPort}`], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const wireproxyPid = proc.pid;
        writeState(readState().map((r) => (r.publicKey === keys.publicKey ? { ...r, wireproxyPid } : r)));

        await waitReady(proc, healthPort, 30_000);
        // wireproxy has parsed the file; the private key now lives only in its memory.
        rmSync(dir, { recursive: true, force: true });

        const tunnels = targets.map((t: TunnelTarget) => ({
          service: t.service,
          port: t.port,
          host: "127.0.0.1",
          localPort: t.localPort,
          local: `127.0.0.1:${t.localPort}`,
        }));
        for (const t of tunnels) ctx.out.step(`${t.service}:${t.port} → ${t.local}`);

        // A signal must reach the teardown below, not end zops with the key still registered.
        const interrupted = new Promise<string>((resolve) => {
          for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
            const handler = () => resolve(sig);
            process.on(sig, handler);
            stopSignals.push(() => process.off(sig, handler));
          }
        });
        const wireproxyExited = proc.exited.then(() => "wireproxy exited");

        if (command.length) {
          const first = String(targets[0]!.localPort);
          const child = Bun.spawn(
            command.map((a) => a.replaceAll("{port}", first)),
            {
              stdio: ["inherit", "inherit", "inherit"],
              env: { ...process.env, ZOPS_TUNNEL_HOST: "127.0.0.1", ZOPS_TUNNEL_PORT: first },
            },
          );
          const outcome = await Promise.race([child.exited.then(() => "done"), interrupted, wireproxyExited]);
          if (outcome === "SIGINT" || outcome === "SIGTERM" || outcome === "SIGHUP") {
            // A terminal Ctrl-C reaches the child too; a signal sent to zops alone is passed on.
            if (child.exitCode === null) child.kill(outcome);
            await child.exited;
            ctx.exitCode = child.exitCode ?? 130;
            return undefined;
          }
          if (outcome !== "done") {
            child.kill();
            await child.exited;
            throw new ZopsError({ code: "tunnelFailed", message: "the tunnel closed while the command was running", exitCode: EXIT.ERROR });
          }
          ctx.exitCode = child.exitCode ?? 1;
          return undefined;
        }

        ctx.out.data({ project: project.name, tunnels, ttl: ttlMs ? ctx.flag<string>("ttl") : null });
        const expired = ttlMs ? Bun.sleep(ttlMs).then(() => "ttl") : new Promise<string>(() => {});
        const reason = await Promise.race([interrupted, wireproxyExited, expired]);
        ctx.out.info(`closing the tunnel (${reason})`);
        if (reason === "wireproxy exited") {
          throw new ZopsError({ code: "tunnelFailed", message: "wireproxy exited unexpectedly", exitCode: EXIT.ERROR });
        }
        return undefined;
      } finally {
        for (const off of stopSignals) off();
        if (proc && proc.exitCode === null) {
          proc.kill("SIGTERM");
          await proc.exited;
        }
        rmSync(dir, { recursive: true, force: true });
        try {
          await deleteKey(ctx, project.id, keys.publicKey);
          writeState(readState().filter((r) => r.publicKey !== keys.publicKey));
        } catch (err) {
          ctx.out.warn(
            `could not delete the tunnel's VPN key (${err instanceof Error ? err.message : String(err)}); ` +
              "the next `zops tunnel` to this project retries",
          );
        }
      }
    },
  },
];
