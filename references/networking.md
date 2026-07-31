# Networking and access

## Contents

- [Architecture](#architecture)
- [Internal access](#internal-access)
- [502 diagnostic checklist](#502-diagnostic-checklist)
- [Public access](#public-access)
- [Zerops subdomains](#zerops-subdomains)
- [Custom domains](#custom-domains)
- [IP addresses](#ip-addresses)
- [Direct port access](#direct-port-access)
- [Firewall](#firewall)
- [L7 balancer](#l7-balancer)
- [Cloudflare](#cloudflare)
- [VPN](#vpn)
- [SSH](#ssh)

## Architecture

Per project:

- **Private VXLAN network** — all services, isolated from every other project.
- **L7 HTTP balancer** — nginx-based, 2 HA containers, auto-scaling. Domain routing, SSL
  termination (Let's Encrypt, auto-renewed), round-robin with health checks, connection pooling.
- **L3 core balancer** — IP addresses and direct TCP/UDP port access, integrated firewall.

Services are not publicly reachable until you configure access. Internal communication works
immediately.

## Internal access

Address any sibling by **hostname and internal port**:

```
http://api:3000/health
http://db:5432
```

Rules:

- **Always `http://`, never `https://`.** SSL terminates at the balancer; the private network is
  already isolated. `https://api:3000` fails.
- Ports must be declared in `run.ports` in the target's `zerops.yaml`.
- Service discovery is automatic — no configuration.
- **Cross-project private networking is impossible.** Bridge projects via public access.
- Environment variables are not shared automatically — see
  [`env-variables.md`](env-variables.md#cross-service-references).

## 502 diagnostic checklist

Work in order:

1. **Binding address** — is the app on `0.0.0.0`? `127.0.0.1`/`localhost` is the #1 cause.
   `app.listen(3000, '0.0.0.0')`, `server.address: 0.0.0.0` for Spring, `HOST=0.0.0.0` for Node.
2. **Port match** — does the app listen on the port declared in `run.ports`?
3. **App running** — check the runtime log for a crash or startup error.
4. **Health check** — if configured, is it returning 2xx / exit 0?
5. **Readiness check** — traffic only routes after it passes.
6. **Service status** — is the service actually active?
7. **Timeouts** — for slow responses raise `send_timeout` (default 2 s) in the L7 config.

Verify independently of public access with `curl http://<hostname>:<port>/health` from a sibling
service or over the VPN.

## Public access

| Method | Best for | Limits |
|---|---|---|
| Zerops subdomain (`.zerops.app`) | development, testing | 50 MB upload, shared balancer, not for production |
| Custom domain | production | needs IPv4/IPv6, DNS setup |
| Direct port access | non-HTTP protocols | runtime services and PostgreSQL only |

## Zerops subdomains

Enable with `enableSubdomainAccess: true` in the import YAML, or the **Zerops subdomain access**
toggle under *Subdomain & domain & IP access*, or `zcli service enable-subdomain`.

URL shape: `{hostname}-{subdomainHostPrefix}[-{port}].{rest}`.
With hostname `appdev`, `zeropsSubdomainHost` `1df2.prg1.zerops.app` and port 3000:

```
https://appdev-1df2-3000.prg1.zerops.app
```

Port 80 omits the port suffix. **Every HTTP port gets its own subdomain.**

Limitations: shared HTTPS balancer across all Zerops projects (scalability bottleneck), hard
**50 MB** upload cap, not configurable. Development and testing only.

## Custom domains

1. Assign IP addresses (below).
2. Service detail → *Subdomain & domain & IP access* → **Setup first domain access**.
3. Enter one or more domains, choose SSL management (Let's Encrypt recommended — Zerops installs
   and renews automatically, free).
4. Define routing rules: **source** = public path, **destination** = service + internal port.
5. Configure DNS at your registrar.

Traffic path: public IP → project's dedicated HTTPS balancer → SSL termination → plain HTTP to your
container. The balancer runs 2 containers, scales vertically, and cannot be modified directly
(only through the advanced L7 configuration).

Upload limit on a custom domain is 512 MB by default, configurable up to 2048 MB.

## IP addresses

| Type | Cost | Notes |
|---|---|---|
| IPv6 | free | One per project, auto-activated with the first domain. Recommended alongside IPv4. |
| Shared IPv4 | free | **HTTP/HTTPS only**, limited connections, shorter timeouts, blacklist risk. Requires **both A and AAAA** records — Zerops reverse-looks-up the AAAA record for SNI ownership verification; without it routing fails silently. Not for production. |
| Dedicated IPv4 | $3 / 30 days | All protocols, one per project, shared by all its services. Auto-renews, non-refundable, reusable in another project until the subscription ends. **Recommended for production.** |

## Direct port access

Available for **runtime services and PostgreSQL** only.

- Any port **10–65435**; 80 and 443 are reserved.
- TCP and UDP.
- Each public port maps to any internal port; several public ports may share one internal port.
- IPv4 and IPv6 configured independently.
- Configure under *Subdomain & domain & IP access* (runtimes) or *Direct access through IP address*
  (PostgreSQL), then **Publish IP access changes**.

PostgreSQL public access always routes through pgBouncer on `6432` over TLS. The replica port
`5433` is never exposed publicly.

## Firewall

Per public port, optional:

- **Blacklist** — block listed IPs/CIDRs, allow everything else.
- **Whitelist** — allow only listed IPs/CIDRs.

Rules accept a single IP or a CIDR range.

## L7 balancer

nginx-based. Client information arrives as headers set by the balancer itself (client-supplied
values are overwritten; `Forwarded` and `Proxy` headers are stripped):

`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`.

Key defaults, adjustable under **Advanced balancer configuration**:

| Parameter | Default | Range |
|---|---|---|
| `worker_connections` | 4000 | 1024–65535 |
| `keepalive_timeout` | 30s | 1s–300s |
| `keepalive_requests` | 100000 | 1–1000000 |
| `client_max_body_size` | 512m | 1k–2048m |
| `client_header_timeout` | 10s | 1s–300s |
| `client_body_timeout` | 10s | 1s–300s |
| `send_timeout` | 2s | 1s–300s |
| `proxy_buffering` | on | on/off |

GUI-configurable routing features: redirects (301/302/307/308 with `preservePath` /
`preserveQuery`), CIDR access policies (403 on deny), per-IP or per-domain rate limiting with burst
queue (503 when exceeded), HTTP basic auth per location, and custom static content responses.

## Cloudflare

- SSL mode must be **Full (strict)**. "Flexible" causes redirect loops.
- **Do not combine shared IPv4 with the Cloudflare proxy** — the reverse AAAA lookup breaks.
- Best setup: IPv6-only AAAA record with Cloudflare proxying (it handles IPv4 translation).
- Add a WAF skip rule for `/.well-known/acme-challenge/` so certificate issuance works.
- Wildcard SSL: `CNAME _acme-challenge.<domain>` → `<domain>.zerops.zone`.

## VPN

Puts your workstation on the project's private network. WireGuard, bundled with `zcli`.

```sh
zcli vpn up <project-id>     # --auto-disconnect, --mtu (default 1420)
curl http://api:3000/health
zcli vpn down
```

- Both `api` and `api.zerops` resolve (a DNS search domain is installed). If a name does not
  resolve, try the `.zerops` suffix.
- **One project at a time** — connecting elsewhere disconnects the current one.
- Use plain `http://` and no database TLS on `5432`/`5433`; the tunnel already encrypts.
- **Environment variables are not available over the VPN.** Copy access details from the GUI.
- Set a default project with `ZEROPS_PROJECTID` or `.zcli.yml` to skip the argument.

## SSH

```sh
ssh <service-hostname>
```

Reachable once you are on the private network (VPN, or from another container). Useful for
debugging and inspection.

**Changes made over SSH are not persistent** — the container is replaced on the next deploy or
scale event. Once a setup step works, move it into `run.prepareCommands` (system packages) or
`run.initCommands` (per-start work) so it survives.

SSH isolation defaults to `vpn` (`--ssh-isolation` on `zcli project create` / `service create`).
