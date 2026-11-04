import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../lib/context.ts";
import type { CommandSpec } from "../lib/spec.ts";
import { userConfigPath } from "../lib/config.ts";
import { EXIT, ZopsError, usage } from "../lib/errors.ts";
import { shutdown } from "../lib/shutdown.ts";
import { parseDuration } from "../lib/spec.ts";
import { generateKeyPair, parseTarget, wireproxyConfig, type KeyPair, type VpnSetup } from "../lib/wireguard.ts";

// --- state: keys registered and not yet deleted -------------------------------------------------

/**
 * One file per registered key, so concurrent tunnels never rewrite each other's records. Public
 * keys, pids and process start times only: enough for a later run to delete the peer, and stop
 * the wireproxy, of a zops that was killed before its teardown.
 */
const STATE_DIR = join(dirname(userConfigPath), "tunnels");

interface TunnelRecord {
  projectId: string;
  publicKey: string;
  /** The zops that owns the key, and when that process started (guards against pid reuse). */
  pid: number;
  pidStarted: string | null;
  wireproxyPid?: number;
  wireproxyStarted?: string | null;
  startedAt: string;
}

const recordPath = (publicKey: string) =>
  join(STATE_DIR, `${createHash("sha256").update(publicKey).digest("hex").slice(0, 16)}.json`);

function saveRecord(record: TunnelRecord): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = recordPath(record.publicKey);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, path);
}

function dropRecord(publicKey: string): void {
  try {
    unlinkSync(recordPath(publicKey));
  } catch {
    // already gone
  }
}

function readRecords(): TunnelRecord[] {
  let names: string[];
  try {
    names = readdirSync(STATE_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return [JSON.parse(readFileSync(join(STATE_DIR, n), "utf8")) as TunnelRecord];
    } catch {
      return [];
    }
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When `pid` started, as `ps` reports it; null if it is not running or ps cannot tell. */
function processStart(pid: number): string | null {
  if (!alive(pid)) return null;
  // lstart is local, localised time: pinned, or a tunnel started under another TZ or locale would
  // read every live record as stale and delete its key.
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
  });
  return ps.stdout.toString().trim() || null;
}

/** The process recorded under `pid` is still the one running there, not a later one reusing it. */
function stillRunning(pid: number, started: string | null | undefined): boolean {
  if (!alive(pid)) return false;
  return !started || processStart(pid) === started;
}

async function deleteKey(ctx: Context, projectId: string, publicKey: string): Promise<void> {
  await ctx.api.call("DeleteProjectVpn", { path: { id: projectId }, body: { publicKey } });
}

/** Deletes the peers, and stops the wireproxy, of earlier tunnels to this project whose zops is gone. */
async function sweepStale(ctx: Context, projectId: string): Promise<number> {
  let removed = 0;
  for (const record of readRecords()) {
    if (record.projectId !== projectId || stillRunning(record.pid, record.pidStarted)) continue;
    if (record.wireproxyPid && stillRunning(record.wireproxyPid, record.wireproxyStarted)) {
      try {
        process.kill(record.wireproxyPid, "SIGTERM");
      } catch {
        // exited meanwhile
      }
    }
    try {
      await deleteKey(ctx, projectId, record.publicKey);
    } catch (err) {
      // Already gone is fine; anything else stays recorded for the next attempt.
      if (!(err instanceof ZopsError && err.exitCode === EXIT.NOT_FOUND)) continue;
    }
    dropRecord(record.publicKey);
    removed++;
  }
  return removed;
}

// --- signals ----------------------------------------------------------------------------------

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Sig = (typeof SIGNALS)[number];

class Interrupted extends Error {
  /** A signal, or EPIPE when whoever read our stdout went away. */
  constructor(readonly signal: Sig | "EPIPE") {
    super(signal === "EPIPE" ? "stdout was closed" : `interrupted by ${signal}`);
  }
}

/** 128 + signal number, as a shell reports it; a closed stdout is the normal end of a pipe, 0. */
const signalExit = (sig: string) =>
  sig === "EPIPE" ? 0 : 128 + ((osConstants.signals as Record<string, number>)[sig] ?? 1);

/**
 * Installed before the key is registered, so a signal at any point reaches the teardown instead
 * of ending zops with the key registered. By default a signal aborts; `route` hands signals to
 * another policy (a running command, or teardown that must not be cut short).
 */
function watchSignals() {
  const controller = new AbortController();
  let route: ((sig: Sig) => void) | undefined;
  const handlers = SIGNALS.map((sig) => {
    const handler = () => (route ? route(sig) : controller.abort(new Interrupted(sig)));
    process.on(sig, handler);
    return [sig, handler] as const;
  });
  shutdown.onBrokenPipe = () => controller.abort(new Interrupted("EPIPE"));
  return {
    signal: controller.signal,
    interrupted: new Promise<Interrupted>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(controller.signal.reason as Interrupted)),
    ),
    check() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    route(fn: (sig: Sig) => void) {
      route = fn;
    },
    dispose() {
      for (const [sig, handler] of handlers) process.off(sig, handler);
      shutdown.onBrokenPipe = undefined;
    },
  };
}

/**
 * A timer that can be cancelled. A pending Bun.sleep keeps the process alive after the race it
 * lost: a --ttl of 1h would hold zops open for an hour after Ctrl-C.
 */
function delay(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

// --- wireproxy --------------------------------------------------------------------------------

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

/** The wireproxy binary, checked up front so a bad path fails before a key is registered. */
function findWireproxy(explicit: string | undefined): string {
  const found = explicit ?? Bun.which("wireproxy");
  if (found && explicit) {
    let problem: string | undefined;
    try {
      if (!statSync(found).isFile()) problem = "is not a file";
      else accessSync(found, fsConstants.X_OK);
    } catch (err) {
      problem = (err as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "is not executable";
    }
    if (problem) {
      throw new ZopsError({
        code: "dependencyMissing",
        message: `wireproxy at ${found} ${problem}`,
        exitCode: EXIT.ERROR,
        hint: "Point --wireproxy / ZOPS_WIREPROXY at the binary from https://github.com/windtf/wireproxy/releases.",
      });
    }
  }
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

interface Wireproxy {
  proc: ChildProcess;
  exited: Promise<void>;
  /** It exited, was killed, or never started (spawnError sets no exit code). */
  gone(): boolean;
  /** Its stderr, trimmed for quoting: health-probe noise dropped, anything key-shaped redacted. */
  log(): string;
}

/**
 * Starts wireproxy with its config on stdin, so the private key is never written to a file, and
 * in its own process group, so a terminal Ctrl-C meant for the command does not take the tunnel
 * down with it.
 */
function startWireproxy(binary: string, config: string, healthPort: number): Wireproxy {
  const proc = spawn(binary, ["-c", "/dev/stdin", "-s", "-i", `127.0.0.1:${healthPort}`], {
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let truncated = false;
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) {
      stderr = stderr.slice(-8000);
      truncated = true;
    }
  });
  let spawnError: Error | undefined;
  let gone = false;
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => {
      gone = true;
      resolve();
    });
    proc.once("error", (err) => {
      spawnError = err;
      gone = true;
      resolve();
    });
  });
  proc.stdin!.on("error", () => {});
  proc.stdin!.end(config);
  return {
    proc,
    exited,
    gone: () => gone,
    log() {
      // Whole lines only, the last few distinct ones, timestamps aside; health probes dropped,
      // anything key-shaped redacted.
      const lines = stderr.split("\n").slice(truncated ? 1 : 0);
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const line of lines.reverse()) {
        const text = line.replace(/^(ERROR: )?\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, "$1").trim();
        if (!text || text.includes("Health metric request") || seen.has(text)) continue;
        seen.add(text);
        kept.unshift(text.replace(/[A-Za-z0-9+/]{42,43}=/g, "[redacted]"));
        if (kept.length === 4) break;
      }
      if (spawnError) kept.unshift(spawnError.message);
      return kept.join("; ");
    },
  };
}

async function stopWireproxy(wp: Wireproxy | undefined): Promise<void> {
  if (!wp || wp.gone() || wp.proc.pid === undefined) return;
  wp.proc.kill("SIGTERM");
  const grace = delay(3000);
  const stopped = await Promise.race([wp.exited.then(() => true), grace.done.then(() => false)]);
  grace.cancel();
  if (!stopped) {
    wp.proc.kill("SIGKILL");
    await wp.exited;
  }
}

/**
 * TCP ports `pid` listens on at 127.0.0.1, or null when this system offers no way to tell.
 * lsof on macOS (and Linux when installed), else /proc on Linux.
 */
function loopbackListeners(pid: number): Set<number> | null {
  const ports = new Set<number>();
  const lsof = Bun.which("lsof");
  if (lsof) {
    // -a: all conditions at once. Exits 1 when nothing matches, which is an empty set here.
    const r = Bun.spawnSync([lsof, "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    for (const line of r.stdout.toString().split("\n")) {
      const m = /^n127\.0\.0\.1:(\d+)$/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
    return ports;
  }
  if (process.platform !== "linux") return null;
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(m[1]!);
      } catch {
        // fd closed meanwhile
      }
    }
    // Columns: sl local_address rem_address st ... inode. 0A is LISTEN; 0100007F is 127.0.0.1.
    for (const line of readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const [ip, port] = (cols[1] ?? "").split(":");
      if (cols[3] === "0A" && ip === "0100007F" && inodes.has(cols[9] ?? "")) ports.add(parseInt(port!, 16));
    }
  } catch {
    return null;
  }
  return ports;
}

/**
 * Waits until the tunnel is actually usable:
 * - /readyz healthy, which with CheckAlive means the project's resolver answered through the tunnel;
 * - every forward and the health port listening in wireproxy itself. The ports were free when
 *   picked but released before wireproxy bound them, and the health endpoint is unauthenticated:
 *   another local process could take a port in between and receive the credentials meant for the
 *   database. The OS's view of who holds the port is what counts.
 */
async function waitReady(
  wp: Wireproxy,
  healthPort: number,
  ports: number[],
  timeoutMs: number,
  abort: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pid = wp.proc.pid!;
  let healthySince: number | undefined;
  let missing: number[] = [];
  while (Date.now() < deadline) {
    if (abort.aborted) throw abort.reason;
    if (wp.gone()) {
      await wp.exited;
      const log = wp.log();
      throw new ZopsError({
        code: "tunnelFailed",
        message: `wireproxy exited before the tunnel was up${log ? `: ${log}` : ""}`,
        exitCode: EXIT.ERROR,
      });
    }
    if (healthySince === undefined) {
      try {
        const res = await fetch(`http://127.0.0.1:${healthPort}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) healthySince = Date.now();
      } catch {
        // not listening yet
      }
    }
    if (healthySince !== undefined) {
      const held = loopbackListeners(pid);
      if (held === null) {
        throw new ZopsError({
          code: "tunnelFailed",
          message: "cannot verify which process holds the tunnel's ports",
          exitCode: EXIT.ERROR,
          hint: "zops needs lsof (or /proc on Linux) to confirm the forwards belong to wireproxy.",
        });
      }
      missing = [...ports, healthPort].filter((p) => !held.has(p));
      if (missing.length === 0) return;
      // Bound right after the health endpoint; a port still missing after that is held elsewhere.
      if (Date.now() - healthySince > 3_000) break;
    }
    await Bun.sleep(150);
  }
  if (healthySince === undefined) {
    const log = wp.log();
    throw new ZopsError({
      code: "tunnelFailed",
      message: `the tunnel did not come up within ${Math.round(timeoutMs / 1000)}s${log ? `: ${log}` : ""}`,
      exitCode: EXIT.TIMEOUT,
      hint: "The project's network did not answer through WireGuard. Check that the token may use the project, and outbound UDP is allowed.",
    });
  }
  throw new ZopsError({
    code: "tunnelFailed",
    message: `127.0.0.1:${missing.join(", 127.0.0.1:")} is not held by wireproxy; another process may be listening there`,
    exitCode: EXIT.ERROR,
    hint: "Pick another local port (service:port:local-port) or find the process with `lsof -iTCP -sTCP:LISTEN`.",
  });
}

const tunnelFailed = (message: string) => new ZopsError({ code: "tunnelFailed", message, exitCode: EXIT.ERROR });

// --- command ----------------------------------------------------------------------------------

export const tunnelCommands: CommandSpec[] = [
  {
    path: ["tunnel"],
    summary: "Forward services of a project's private network to 127.0.0.1, without root or a VPN.",
    description: `Connects to the project's private network the way \`zcli vpn up\` does, but in userspace:
wireproxy runs WireGuard on its own network stack and listens on 127.0.0.1 only for the services
you name. No interface, route or DNS setting on this machine changes, so no sudo is needed and a
running \`zcli vpn\` is unaffected.

Each run registers a fresh WireGuard key with the project and deletes it again on exit, also when
interrupted. The private key is handed to wireproxy on stdin and never written to disk. The tunnel
counts as up once the project's resolver answers through it and every forward is held by
wireproxy itself; that waits up to 30s, or --timeout if shorter.

With a command after \`--\`, zops runs it once the tunnel is up and exits with its status. In the
command, {port} is replaced by the first tunnel's local port, also exported as ZOPS_TUNNEL_PORT
(and ZOPS_TUNNEL_HOST=127.0.0.1). A terminal Ctrl-C goes to the command, not the tunnel; SIGTERM
and SIGHUP sent to zops are passed on, and SIGINT too when stdin is not a terminal. Without a command,
zops prints the local addresses and holds the tunnel until it is interrupted (exit 128+signal) or
--ttl runs out (exit 0).

A zops killed with SIGKILL cannot clean up: its key stays recorded in ${STATE_DIR}
(public key and pids only), and the next tunnel to the same project deletes it and stops the
orphaned wireproxy.

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
      const readyMs = Math.min(ctx.timeoutMs, 30_000);
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

      const signals = watchSignals();
      let keys: KeyPair | undefined;
      let registered = false;
      let wp: Wireproxy | undefined;
      try {
        const swept = await sweepStale(ctx, project.id);
        if (swept) ctx.out.info(`removed ${swept} key(s) left behind by an earlier tunnel`);
        signals.check();

        for (const t of targets) if (!t.localPort) t.localPort = await freePort();
        const healthPort = await freePort();

        keys = generateKeyPair();
        const record: TunnelRecord = {
          projectId: project.id,
          publicKey: keys.publicKey,
          pid: process.pid,
          pidStarted: processStart(process.pid),
          startedAt: new Date().toISOString(),
        };
        // Recorded before the request: if zops dies while it is in flight, the key may exist.
        saveRecord(record);
        let setup: VpnSetup;
        try {
          setup = await ctx.api.call<VpnSetup>("CreateProjectVpn", {
            path: { id: project.id },
            body: { publicKey: keys.publicKey },
          });
        } catch (err) {
          // A clear 4xx means the key was refused. A 5xx or a dropped connection may have come
          // after the server stored it, so the teardown deletes it to be sure (404 is fine).
          const refused = err instanceof ZopsError && err.exitCode !== EXIT.TRANSIENT;
          if (!refused) registered = true;
          throw err;
        }
        registered = true;
        signals.check();

        wp = startWireproxy(wireproxy, wireproxyConfig(keys.privateKey, setup, targets), healthPort);
        ctx.out.debug(`wireproxy started (pid ${wp.proc.pid}), waiting for the tunnel`);
        const readySince = Date.now();
        if (wp.proc.pid !== undefined) {
          saveRecord({ ...record, wireproxyPid: wp.proc.pid, wireproxyStarted: processStart(wp.proc.pid) });
        }
        await waitReady(wp, healthPort, targets.map((t) => t.localPort), readyMs, signals.signal);
        ctx.out.debug(`tunnel up after ${Date.now() - readySince}ms`);

        const tunnels = targets.map((t) => ({
          service: t.service,
          port: t.port,
          host: "127.0.0.1",
          localPort: t.localPort,
          local: `127.0.0.1:${t.localPort}`,
        }));
        for (const t of tunnels) ctx.out.step(`${t.service}:${t.port} → ${t.local}`);
        const wireproxyExited = wp.exited.then(() => "wireproxy" as const);

        if (command.length) {
          const first = String(targets[0]!.localPort);
          const child = Bun.spawn(
            command.map((a) => a.replaceAll("{port}", first)),
            {
              stdio: ["inherit", "inherit", "inherit"],
              env: { ...process.env, ZOPS_TUNNEL_HOST: "127.0.0.1", ZOPS_TUNNEL_PORT: first },
            },
          );
          // A terminal Ctrl-C already reached the command (psql cancels a query and goes on), so
          // SIGINT is passed on only without a terminal, where a parent process sent it to zops
          // alone (`timeout -s INT`, child.kill("SIGINT")). Termination signals always are.
          const interactive = Boolean(process.stdin.isTTY);
          signals.route((sig) => {
            if (sig !== "SIGINT" || !interactive) child.kill(sig);
          });
          const outcome = await Promise.race([child.exited.then(() => "done" as const), wireproxyExited]);
          if (outcome === "wireproxy") {
            child.kill();
            await child.exited;
            throw tunnelFailed(`the tunnel closed while the command was running${wp.log() ? `: ${wp.log()}` : ""}`);
          }
          ctx.exitCode = child.signalCode ? signalExit(child.signalCode) : (child.exitCode ?? 1);
          return undefined;
        }

        ctx.out.data({ project: project.name, tunnels, ttl: ttlMs ? ctx.flag<string>("ttl") : null });
        const ttl = ttlMs ? delay(ttlMs) : undefined;
        const expired = ttl ? ttl.done.then(() => "ttl" as const) : new Promise<never>(() => {});
        const reason = await Promise.race([signals.interrupted, wireproxyExited, expired]);
        ttl?.cancel();
        if (reason instanceof Interrupted) throw reason;
        if (reason === "wireproxy") throw tunnelFailed(`wireproxy exited unexpectedly${wp.log() ? `: ${wp.log()}` : ""}`);
        ctx.out.info("closing the tunnel (--ttl reached)");
        return undefined;
      } catch (err) {
        if (!(err instanceof Interrupted)) throw err;
        ctx.out.info(`closing the tunnel (${err.signal})`);
        ctx.exitCode = signalExit(err.signal);
        return undefined;
      } finally {
        // A second Ctrl-C must not cut the teardown short and leave the key registered.
        signals.route(() => {});
        const stopSince = Date.now();
        await stopWireproxy(wp);
        if (wp) ctx.out.debug(`wireproxy stopped after ${Date.now() - stopSince}ms`);
        if (keys) {
          try {
            if (registered) {
              try {
                await deleteKey(ctx, project.id, keys.publicKey);
              } catch (err) {
                if (!(err instanceof ZopsError && err.exitCode === EXIT.NOT_FOUND)) throw err;
              }
            }
            dropRecord(keys.publicKey);
          } catch (err) {
            ctx.out.warn(
              `could not delete the tunnel's VPN key (${err instanceof Error ? err.message : String(err)}); ` +
                "the next `zops tunnel` to this project retries",
            );
          }
        }
        signals.dispose();
      }
    },
  },
];
