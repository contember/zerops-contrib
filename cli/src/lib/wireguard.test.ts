import { describe, expect, test } from "bun:test";
import { generateKeyPair, parseTarget, publicKeyOf, wireproxyConfig, type VpnSetup } from "./wireguard.ts";

// A throwaway pair made with `wg genkey | wg pubkey`; never registered anywhere.
const WG_PRIVATE = "iKfPMINJsQbI+HPvWM7R+1AmHgw6t2P5qetSJ1DefnQ=";
const WG_PUBLIC = "eQALYoZt+5W4udH8zhMMj7k5EN4hDKbQr9VyE1Ppwio=";

/** The shape CreateProjectVpn answered with on a real project (addresses changed). */
const SETUP: VpnSetup = {
  project: {
    publicKey: "c2VydmVyLXB1YmxpYy1rZXktZm9yLXRlc3RzLW9ubHk=",
    ipv4: { sharedEndpoint: "proxy.app-prg1.zerops.io:14307", network: { network: "10.14.124.1/22", gateway: "10.14.124.1" } },
    ipv6: { sharedEndpoint: "proxy.app-prg1.zerops.io:14307", network: { network: "fda0:5ef:39e:c0de::/64", gateway: "fda0:5ef:39e:c0de::1" } },
  },
  peer: {
    ipv4: { assignedIpAddress: "10.14.128.4", network: { network: "10.14.128.1/22" } },
    ipv6: { assignedIpAddress: "fda0:5ef:39e:c0df::4", network: { network: "fda0:5ef:39e:c0df::/64" } },
  },
};

describe("keys", () => {
  test("derives the same public key as `wg pubkey`", () => {
    expect(publicKeyOf(WG_PRIVATE)).toBe(WG_PUBLIC);
  });

  test("generates a matching pair in WireGuard's base64 form", () => {
    const pair = generateKeyPair();
    expect(pair.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
    expect(generateKeyPair().privateKey).not.toBe(pair.privateKey);
  });
});

describe("targets", () => {
  test("parses service:port with an optional local port", () => {
    expect(parseTarget("db:5432")).toEqual({ service: "db", port: 5432, localPort: 0 });
    expect(parseTarget("cache-1:6379:16379")).toEqual({ service: "cache-1", port: 6379, localPort: 16379 });
  });

  test("rejects anything that is not a plain hostname and valid ports", () => {
    for (const bad of ["db", "db:", "db:0", "db:70000", "db:5432:x", "DB:5432", "db.zerops:5432", "a:1:2:3", "db:5432\nx", ":5432"]) {
      expect(() => parseTarget(bad)).toThrow(/invalid tunnel target/);
    }
  });
});

describe("wireproxy config", () => {
  test("routes the project and peer networks and forwards each target by its .zerops name", () => {
    const config = wireproxyConfig(WG_PRIVATE, SETUP, [
      { service: "db", port: 5432, localPort: 15432 },
      { service: "cache", port: 6379, localPort: 16379 },
    ]);
    expect(config).toBe(`[Interface]
PrivateKey = ${WG_PRIVATE}
Address = 10.14.128.4/32, fda0:5ef:39e:c0df::4/128
DNS = 10.14.124.1
MTU = 1420

[Peer]
PublicKey = c2VydmVyLXB1YmxpYy1rZXktZm9yLXRlc3RzLW9ubHk=
AllowedIPs = 10.14.124.0/22, fda0:5ef:39e:c0de::/64, 10.14.128.0/22, fda0:5ef:39e:c0df::/64
Endpoint = proxy.app-prg1.zerops.io:14307
PersistentKeepalive = 25

[TCPClientTunnel]
BindAddress = 127.0.0.1:15432
Target = db.zerops:5432

[TCPClientTunnel]
BindAddress = 127.0.0.1:16379
Target = cache.zerops:6379
`);
  });

  test("works for an IPv6-only project", () => {
    const v6only: VpnSetup = {
      project: { publicKey: SETUP.project.publicKey, ipv6: SETUP.project.ipv6 },
      peer: { ipv6: SETUP.peer.ipv6 },
    };
    const config = wireproxyConfig(WG_PRIVATE, v6only, [{ service: "db", port: 5432, localPort: 1 }]);
    expect(config).toContain("Address = fda0:5ef:39e:c0df::4/128\n");
    expect(config).toContain("DNS = fda0:5ef:39e:c0de::1\n");
    expect(config).toContain("AllowedIPs = fda0:5ef:39e:c0de::/64, fda0:5ef:39e:c0df::/64\n");
  });

  test("refuses an incomplete setup instead of writing a config that cannot connect", () => {
    expect(() => wireproxyConfig(WG_PRIVATE, { project: { publicKey: "x" }, peer: {} }, [])).toThrow(/incomplete/);
  });
});
