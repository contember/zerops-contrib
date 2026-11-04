#!/usr/bin/env bun
/**
 * Stand-in for wireproxy in the tunnel tests. Reads its config like the real one (zops passes it
 * on stdin as `-c /dev/stdin`), then:
 * - writes what it saw to $FAKE_WIREPROXY_REPORT (its pid and the public key of the private key it
 *   was given, never the private key itself, plus the targets),
 * - answers `PONG <target>` on every TCPClientTunnel BindAddress,
 * - serves /readyz on the -i address: 200, or 503 as long as the peer is "unreachable", which is
 *   what the real one does with CheckAlive set and no ping coming back.
 *
 * FAKE_WIREPROXY_FAIL=1         exit at once with an error, like a bad config would
 * FAKE_WIREPROXY_SKIP=<port>    leave that forward unbound, as if another process held the port
 * FAKE_WIREPROXY_DELAY_MS=<ms>  wait before binding anything (a slow handshake)
 * FAKE_WIREPROXY_UNREACHABLE=1  /readyz never turns healthy
 */
import { writeFileSync } from "node:fs";
import { publicKeyOf } from "../../lib/wireguard.ts";

const args = process.argv.slice(2);
const configPath = args[args.indexOf("-c") + 1]!;
const info = args[args.indexOf("-i") + 1]!;

if (process.env.FAKE_WIREPROXY_FAIL) {
  // The real binary prints the offending value, keys included; zops must redact it.
  console.error("invalid base64 string: iKfPMINJsQbI+HPvWM7R+1AmHgw6t2P5qetSJ1DefnQ=");
  process.exit(1);
}

const config = configPath === "/dev/stdin" ? await Bun.stdin.text() : await Bun.file(configPath).text();
const privateKey = /^PrivateKey = (.+)$/m.exec(config)![1]!;
const tunnels = [...config.matchAll(/BindAddress = 127\.0\.0\.1:(\d+)\nTarget = (.+)/g)].map((m) => ({
  port: Number(m[1]),
  target: m[2]!,
}));

writeFileSync(
  process.env.FAKE_WIREPROXY_REPORT!,
  JSON.stringify({ publicKey: publicKeyOf(privateKey), configPath, tunnels, pid: process.pid, checkAlive: /^CheckAlive = /m.test(config) }),
);

await Bun.sleep(Number(process.env.FAKE_WIREPROXY_DELAY_MS ?? 0));

for (const t of tunnels) {
  if (String(t.port) === process.env.FAKE_WIREPROXY_SKIP) continue;
  Bun.listen({
    hostname: "127.0.0.1",
    port: t.port,
    socket: { open: (s) => void s.end(`PONG ${t.target}\n`), data() {} },
  });
}
const [host, port] = info.split(":");
Bun.serve({
  hostname: host,
  port: Number(port),
  fetch: () => {
    console.error("Health metric request: /readyz");
    return new Response("", { status: process.env.FAKE_WIREPROXY_UNREACHABLE ? 503 : 200 });
  },
});
