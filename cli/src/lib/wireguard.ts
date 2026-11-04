/**
 * WireGuard pieces for `zops tunnel`: key pairs and the wireproxy configuration.
 *
 * zcli's VPN brings up a kernel interface through `wg-quick`, which needs root for the
 * interface, the routes and the system resolver. wireproxy runs WireGuard in userspace on a
 * gVisor network stack and exposes chosen services as ports on 127.0.0.1 instead, so nothing on
 * the machine changes and no root is needed. The API side is the same one zcli uses.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { usage } from "./errors.ts";

export interface KeyPair {
  /** Base64, as WireGuard writes keys. Never persisted by zops. */
  privateKey: string;
  publicKey: string;
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "jwk" }).d!;
  const pub = publicKey.export({ format: "jwk" }).x!;
  return {
    privateKey: Buffer.from(priv, "base64url").toString("base64"),
    publicKey: Buffer.from(pub, "base64url").toString("base64"),
  };
}

/** PKCS#8 prefix for a raw X25519 private key. */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** The public key WireGuard derives from a private key (`wg pubkey`). */
export function publicKeyOf(privateKey: string): string {
  const raw = Buffer.from(privateKey, "base64");
  if (raw.length !== 32) throw new Error("a WireGuard private key is 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

/** The parts of a CreateProjectVpn answer that a client needs. */
export interface VpnSetup {
  project: {
    publicKey: string;
    ipv4?: { sharedEndpoint?: string; network?: { network?: string; gateway?: string } };
    ipv6?: { sharedEndpoint?: string; network?: { network?: string; gateway?: string } };
  };
  peer: {
    ipv4?: { assignedIpAddress?: string; network?: { network?: string } };
    ipv6?: { assignedIpAddress?: string; network?: { network?: string } };
  };
}

export interface TunnelTarget {
  /** Service hostname inside the project. */
  service: string;
  port: number;
  /** Port on 127.0.0.1; 0 until one is picked. */
  localPort: number;
}

const HOSTNAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `db:5432`, `db:5432:15432`. The local port is optional. */
export function parseTarget(spec: string): TunnelTarget {
  const parts = spec.split(":");
  const port = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN);
  const [service, remote, local] = parts;
  const target = { service: service ?? "", port: port(remote), localPort: local === undefined ? 0 : port(local) };
  const valid =
    parts.length >= 2 &&
    parts.length <= 3 &&
    HOSTNAME_RE.test(target.service) &&
    target.port >= 1 &&
    target.port <= 65535 &&
    target.localPort >= 0 &&
    target.localPort <= 65535;
  if (!valid) {
    throw usage(`invalid tunnel target '${spec}'`, "Use <service>:<port>[:<local-port>], e.g. db:5432 or db:5432:15432.");
  }
  return target;
}

/**
 * Values from the API go into an INI file; anything beyond address, key and host characters
 * (a newline, a bracket) could add a section, so it is refused rather than escaped.
 */
const INI_SAFE = /^[A-Za-z0-9.:/+=_-]+$/;
function safe(value: string, what: string): string {
  if (!INI_SAFE.test(value)) throw new Error(`unexpected characters in the VPN setup's ${what}`);
  return value;
}

/**
 * wireproxy's INI configuration. Targets use the `.zerops` suffix: the project resolver answers
 * it, and wireproxy has no search domain to turn a bare `db` into `db.zerops`.
 *
 * CheckAlive pings the project's resolver through the tunnel, and wireproxy's /readyz stays
 * unhealthy until a ping comes back. Without it /readyz is healthy as soon as the process runs,
 * handshake or not.
 */
export function wireproxyConfig(
  privateKey: string,
  setup: VpnSetup,
  targets: TunnelTarget[],
  options: { mtu?: number } = {},
): string {
  const { project, peer } = setup;
  const addresses = [
    peer.ipv4?.assignedIpAddress && `${safe(peer.ipv4.assignedIpAddress, "address")}/32`,
    peer.ipv6?.assignedIpAddress && `${safe(peer.ipv6.assignedIpAddress, "address")}/128`,
  ].filter(Boolean);
  const allowed = [project.ipv4?.network?.network, project.ipv6?.network?.network, peer.ipv4?.network?.network, peer.ipv6?.network?.network]
    .filter((n): n is string => Boolean(n))
    .map((n) => safe(n, "network"));
  const resolver = project.ipv4?.network?.gateway ?? project.ipv6?.network?.gateway;
  const endpoint = project.ipv4?.sharedEndpoint ?? project.ipv6?.sharedEndpoint;
  if (!addresses.length || !allowed.length || !resolver || !endpoint) {
    throw new Error("the VPN setup from the API is incomplete (no address, network, resolver or endpoint)");
  }

  const lines = [
    "[Interface]",
    `PrivateKey = ${safe(privateKey, "private key")}`,
    `Address = ${addresses.join(", ")}`,
    `DNS = ${safe(resolver, "resolver")}`,
    `MTU = ${options.mtu ?? 1420}`,
    `CheckAlive = ${resolver}`,
    "CheckAliveInterval = 1",
    "",
    "[Peer]",
    `PublicKey = ${safe(project.publicKey, "public key")}`,
    `AllowedIPs = ${allowed.join(", ")}`,
    `Endpoint = ${safe(endpoint, "endpoint")}`,
    "PersistentKeepalive = 25",
  ];
  for (const t of targets) {
    lines.push("", "[TCPClientTunnel]", `BindAddress = 127.0.0.1:${t.localPort}`, `Target = ${t.service}.zerops:${t.port}`);
  }
  return `${lines.join("\n")}\n`;
}
