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

/** A CIDR in canonical network form: `10.14.124.1/22` -> `10.14.124.0/22`. IPv6 is passed through. */
function networkOf(cidr: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return cidr;
  const bits = Number(m[5]);
  const ip = m.slice(1, 5).reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join(".")}/${bits}`;
}

/**
 * wireproxy's INI configuration. Targets use the `.zerops` suffix: the project resolver answers
 * it, and wireproxy has no search domain to turn a bare `db` into `db.zerops`.
 */
export function wireproxyConfig(
  privateKey: string,
  setup: VpnSetup,
  targets: TunnelTarget[],
  options: { mtu?: number } = {},
): string {
  const { project, peer } = setup;
  const addresses = [
    peer.ipv4?.assignedIpAddress && `${peer.ipv4.assignedIpAddress}/32`,
    peer.ipv6?.assignedIpAddress && `${peer.ipv6.assignedIpAddress}/128`,
  ].filter(Boolean);
  const allowed = [project.ipv4?.network?.network, project.ipv6?.network?.network, peer.ipv4?.network?.network, peer.ipv6?.network?.network]
    .filter((n): n is string => Boolean(n))
    .map(networkOf);
  const dns = project.ipv4?.network?.gateway ?? project.ipv6?.network?.gateway;
  const endpoint = project.ipv4?.sharedEndpoint ?? project.ipv6?.sharedEndpoint;
  if (!addresses.length || !allowed.length || !dns || !endpoint) {
    throw new Error("the VPN setup from the API is incomplete (no address, network, resolver or endpoint)");
  }

  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${addresses.join(", ")}`,
    `DNS = ${dns}`,
    `MTU = ${options.mtu ?? 1420}`,
    "",
    "[Peer]",
    `PublicKey = ${project.publicKey}`,
    `AllowedIPs = ${allowed.join(", ")}`,
    `Endpoint = ${endpoint}`,
    "PersistentKeepalive = 25",
  ];
  for (const t of targets) {
    lines.push("", "[TCPClientTunnel]", `BindAddress = 127.0.0.1:${t.localPort}`, `Target = ${t.service}.zerops:${t.port}`);
  }
  return `${lines.join("\n")}\n`;
}
