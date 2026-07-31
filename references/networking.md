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
- [Getting a shell](#getting-a-shell)

## Architecture

Per project:

- **Private VXLAN network** — all services, isolated from every other project.
- **L7 HTTP balancer** — nginx-based, 2 HA containers, auto-scaling. Domain routing, SSL
  termination (Let's Encrypt, auto-renewed), round-robin with health checks, connection pooling.
- **L3 core balancer** — IP addresses and direct TCP/UDP port access, integrated firewall.

Services are not publicly reachable until you configure access. Internal communication works
immediately.

## Internal access

Address any sibling by **hostname and internal port**. The hostname is the service name; both
`api` and `api.zerops` resolve.

```sh
curl http://api:3000/health     # HTTP service
psql -h db -p 5432 ...          # Postgres — not HTTP, just host:port
redis-cli -h cache -p 6379 ...  # Valkey
```

Rules:

- **For HTTP between services use `http://`, never `https://`.** SSL terminates at the L7 balancer
  and the private network is already isolated, so `https://api:3000` fails.
- **Non-HTTP protocols are not affected by that rule** — they connect to `hostname:port` and follow
  their own TLS conventions. Some managed services expose both a plaintext and a TLS port, and a
  few *require* TLS: PostgreSQL `5432`/`5433` are plaintext-only while pgBouncer on `6432` requires
  it; Valkey serves `6379` plaintext and `6380` TLS. Per-service details in
  [`service-catalog.md`](service-catalog.md#generated-environment-variables).
- HTTP ports must be declared in `run.ports` in the target's `zerops.yaml`. Webserver runtimes
  (`php-*`, `nginx`, `static`) declare none — their port is implicit.
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

URL shape: `{hostname}-{prefix}[-{port}].{rest}`. With hostname `appdev`, prefix `1df2`, region
segment `prg1.zerops.app` and port 3000:

```
https://appdev-1df2-3000.prg1.zerops.app
```

Port 80 omits the port suffix. **Every HTTP port gets its own subdomain**, and the subdomain route
only materialises once a deploy has declared that HTTP port.

**Do not compose this URL from memory.** Upstream is inconsistent about whether the
`zeropsSubdomainHost` variable holds the bare prefix (`1df2`) or the whole host
(`1df2.prg1.zerops.app`), and the two readings produce different — one of them broken — URLs. Read
the actual value instead of assuming:

```sh
zcli project env --service app | grep -i subdomain
```

or take the link from the service detail page in the GUI. To verify an app is up without depending
on any of this, curl it internally: `curl http://app:3000/health` from a sibling or over the VPN.

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

### DNS records

Two ways to point a domain at the project:

- **A + AAAA** — the direct form, values from the project's IP addresses. A shared IPv4 requires
  **both** records: Zerops reverse-looks-up the AAAA record to verify ownership for SNI routing, and
  without it routing fails silently.
- **CNAME** — for subdomains, or at the apex with a provider that supports CNAME flattening. Take
  the target from GUI → service → **Public access & internal ports** → the **CNAME** option; Zerops
  creates A/AAAA records behind it. **With any CDN or proxy in front, toggle off "Shared IPv4
  included in the CNAME"** or routing breaks.

Certificates: a plain domain validates over HTTP-01, so it must already route to the service before
the certificate can issue. Wildcards need DNS-01 — `CNAME _acme-challenge.<domain>` →
`<domain>.zerops.zone`.

Verify after propagation (5–10 minutes):

```sh
dig AAAA <domain>
curl -vI https://<domain>
curl -4 -v https://<domain>    # test each stack separately
curl -6 -v https://<domain>
```

## IP addresses

| Type | Cost | Notes |
|---|---|---|
| IPv6 | free | One per project, auto-activated with the first domain. Recommended alongside IPv4. |
| Shared IPv4 | free | **HTTP/HTTPS only**, limited connections, shorter timeouts, blacklist risk. Requires **both A and AAAA** records — Zerops reverse-looks-up the AAAA record for SNI ownership verification; without it routing fails silently. Not for production. |
| Dedicated IPv4 | $3 / 30 days | All protocols, one per project, shared by all its services. Auto-renews, non-refundable, reusable in another project until the subscription ends. **Recommended for production.** |

## Direct port access

Available for **runtime services and PostgreSQL** only.

- Any port **10–65435** for the *public* port; 80 and 443 are reserved for public direct access
  (internally, `run.ports` may use 80).
- TCP and UDP.
- Each public port maps to any internal port; several public ports may share one internal port.
- IPv4 and IPv6 configured independently.
- Configure under *Subdomain & domain & IP access* (runtimes) or *Direct access through IP address*
  (PostgreSQL), then **Publish IP access changes**.

PostgreSQL public access always routes through pgBouncer on `6432` over TLS. The replica port
`5433` is never exposed publicly.

## Firewall

### Inbound, per public port

- **Blacklist** — block listed IPs/CIDRs, allow everything else.
- **Whitelist** — allow only listed IPs/CIDRs.

Rules accept a single IP or a CIDR range.

### Outbound, platform-wide

Zerops runs nftables with **TCP ports 1–1024 restricted — only 22, 53, 80, 123, 443 and 587 are
allowed outbound.** UDP and TCP 1025–65535 are unrestricted. Changing this requires emailing
`support@zerops.io` with the Project ID and Organization ID.

The consequence that bites most often is **email**: port **587 (STARTTLS) is the only usable SMTP
port**; 25 and 465 are permanently blocked. A perfectly ordinary `SMTP_PORT: "465"` silently never
connects.

| Provider | Host | Port |
|---|---|---|
| SendGrid | `smtp.sendgrid.net` | 587 (username `apikey`) |
| Mailgun | `smtp.mailgun.org` | 587 |
| Amazon SES | `email-smtp.{region}.amazonaws.com` | 587 |
| Gmail | `smtp.gmail.com` | 587 (app password) |
| Office 365 | `smtp.office365.com` | 587 |

Non-secret SMTP settings go in `run.envVariables` (`zerops.yaml`); the password goes in
`envSecrets` (import YAML). Different files — a bare top-level `envVariables:` block is invalid.

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
- Set a default project with `ZEROPS_PROJECTID` or `./.zcli.yaml` to skip the argument.
- **`dig`/`nslookup`/`host` bypass the system resolver** and report false NXDOMAIN over the VPN.
  Test reachability with `nc -zv db 5432 -w 3` instead.

## Getting a shell

**SSH works only for runtime services and web servers.** Databases, message brokers and object
storage are not SSH-able — reach those with their own client over the VPN.

### Web terminal — the zero-setup path

Every service detail page has a **Remote Web Terminal**: no VPN, instant, and **never blocked by
SSH isolation rules**. It is the emergency access route and the right first answer to "get me a
shell". The GUI also has a **file browser** with a container selector for inspecting the deployed
filesystem.

### SSH over the VPN

```sh
zcli vpn up <project-id>
ssh app                          # random container in HA
ssh node-id-1.runtime.app.zerops # a specific container
```

Container hostnames follow `node-id-<n>.runtime.<service>.zerops` or
`node<n>.runtime.<service>.zerops`. Numbers are **not sequential** — decommissioned names are never
recycled, so you may see `node-id-5` and `node-id-12` side by side, and they change as the service
scales. Never connect by IP; container IPs are dynamic.

In HA, plain `ssh <service>` lands on a **random** container. To inspect the one that is
misbehaving, use its container hostname.

### Persistence

**Changes made over SSH are not persistent** — in HA they affect only that one container, and any
container replacement (deploy, scale, failover) restores the deployed version. Once a setup step
works, move it into `run.prepareCommands` (system packages) or `run.initCommands` (per-start work).

### `sshIsolation`

A project variable, overridable per service, default `vpn`. Set it in the import YAML
(`project.sshIsolation` / `services[].sshIsolation`), in the GUI, or with `--ssh-isolation` on
`zcli project create` / `service create`.

Allow rules: `vpn` (VPN SSH), `project` (any service in the project), `service` (containers of the
same service), `service@name` (one named service). Prefix with `-` to block. Combine with spaces:
`sshIsolation: "vpn project"`.

Evaluation order, most specific first: `service@name` → `service` → `project` → `vpn`. Block rules
win over allow rules at the same specificity, and a broad block can make a later allow unreachable
— `project -service` blocks all service-to-service SSH despite the `project` rule.

| Goal | Value |
|---|---|
| Production default | `vpn` |
| Development / microservice debugging | `vpn project` |
| Only one service may SSH out | `vpn service@gateway` |
| Everyone except one service | `project -service@untrusted` |

Web terminal access bypasses all of these, always.

If an SSH connection is refused, check `sshIsolation` before assuming a network fault — and use the
web terminal in the meantime.
