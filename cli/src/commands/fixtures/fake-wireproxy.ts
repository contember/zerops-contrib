#!/usr/bin/env bun
/**
 * Stand-in for wireproxy in the tunnel tests. Reads the config like the real one, then:
 * - writes what it saw to $FAKE_WIREPROXY_REPORT (the public key of the private key it was given,
 *   never the private key itself, plus the targets),
 * - answers `PONG <target>` on every TCPClientTunnel BindAddress,
 * - serves /readyz on the -i address.
 * FAKE_WIREPROXY_FAIL=1 makes it exit at once with an error, like a bad config would.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { publicKeyOf } from "../../lib/wireguard.ts";

const args = process.argv.slice(2);
const configPath = args[args.indexOf("-c") + 1]!;
const info = args[args.indexOf("-i") + 1]!;

if (process.env.FAKE_WIREPROXY_FAIL) {
  console.error("bad config: Endpoint is unreachable");
  process.exit(1);
}

const config = readFileSync(configPath, "utf8");
const privateKey = /^PrivateKey = (.+)$/m.exec(config)![1]!;
const tunnels = [...config.matchAll(/BindAddress = 127\.0\.0\.1:(\d+)\nTarget = (.+)/g)].map((m) => ({
  port: Number(m[1]),
  target: m[2]!,
}));

for (const t of tunnels) {
  Bun.listen({
    hostname: "127.0.0.1",
    port: t.port,
    socket: { open: (s) => void s.end(`PONG ${t.target}\n`), data() {} },
  });
}
const [host, port] = info.split(":");
Bun.serve({ hostname: host, port: Number(port), fetch: () => new Response("ok") });

writeFileSync(
  process.env.FAKE_WIREPROXY_REPORT!,
  JSON.stringify({ publicKey: publicKeyOf(privateKey), configPath, tunnels, pid: process.pid }),
);
