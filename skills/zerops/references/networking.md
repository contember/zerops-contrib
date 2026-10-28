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
- [CDN](#cdn)
- [Cloudflare](#cloudflare)
- [VPN](#vpn)
- [Getting a shell](#getting-a-shell)
- [Local development](#local-development)

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

**`zeropsSubdomainHost` holds the bare prefix** — verified live it is e.g. `291e`, not the whole
host. But you rarely need to assemble the URL yourself: there is an **undocumented but present
project variable `zeropsSubdomainString`** that carries the full template with the host already
filled in, e.g. `https://${hostname}-291e-${port}.prg1.zerops.app` (and on a specific service the
hostname is already substituted). Read one of them instead of composing from memory:

```sh
zcli project env --service app | grep -i subdomain
# zeropsSubdomainHost=291e
# zeropsSubdomainString=https://app-291e-${port}.prg1.zerops.app
```

or take the link from the service detail page in the GUI. To verify an app is up without depending
on any of this, curl it internally: `curl http://app:3000/health` from a sibling or over the VPN.

**`enableSubdomainAccess: true` in the import YAML does not take effect on a service that has never
been deployed — verified live.** After the import the service reads `subdomainAccess: false`, and
enabling it explicitly fails too:

```
error: Service stack is not http or https
```

The subdomain needs a *deployed* HTTP port, so this is a field an import file cannot establish on
its own. Deploy first, then `zops service enable-subdomain <service>` / `zcli service enable-subdomain`
/ the GUI toggle — or re-run `zops apply`, which reports it as pending drift and converges it on the
next pass.

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

`zops route http get <domain>` reports what the platform itself thinks — `dnsCheckStatus` per
domain and `sslStatus` for the certificate — which separates "DNS has not propagated" from
"certificate never issued". After fixing a record, `zops route http dns-check <domain>` asks for a
re-check instead of waiting for the platform's own schedule.

## IP addresses

| Type | Cost | Notes |
|---|---|---|
| IPv6 | free | One per project, auto-activated with the first domain. Recommended alongside IPv4. |
| Shared IPv4 | free | **HTTP/HTTPS only**, limited connections, shorter timeouts, blacklist risk. Requires **both A and AAAA** records — Zerops reverse-looks-up the AAAA record for SNI ownership verification; without it routing fails silently. Not for production. |
| Dedicated IPv4 | $3 per month | All protocols, one per project, shared by all its services. Called **unique IPv4 address** in the GUI. **Recommended for production.** |

**Dedicated IPv4 lifecycle.** Activation needs an active project, at least one past top-up in the
organization, and a balance covering the first month. Monthly subscription from the activation
moment, charged in advance, never refunded. **Releasing** it (GUI *Add-ons*, `PUT
/project/{id}/release-ipv4`) drops the project to the shared IPv4 at once; the paid period stays
with the organization and is reused free by the next activation on any of its projects. **The next
activation may get a different address — recheck DNS A records.** Zerops also releases it when it
stops a project for lack of credit, and starting the project again does not bring it back.

## Direct port access

Available for **runtime services and PostgreSQL** only.

- Any port **10–65435** for the *public* port; 80 and 443 are reserved for public direct access
  (internally, `run.ports` may use 80).
- TCP and UDP.
- Each public port maps to any internal port; several public ports may share one internal port.
- IPv4 and IPv6 configured independently.
- Configure under *Subdomain & domain & IP access* (runtimes) or *Direct access through IP address*
  (PostgreSQL), then **Publish IP access changes**. Headlessly this is
  `zops route port create|update|delete`, which publishes for you; a change made elsewhere needs
  `zops route port sync` before it serves.

PostgreSQL public access always routes through pgBouncer on `6432` over TLS. The replica port
`5433` is never exposed publicly.

## Firewall

### Inbound, per public port

- **Blacklist** — block listed IPs/CIDRs, allow everything else.
- **Whitelist** — allow only listed IPs/CIDRs.

Rules accept a single IP or a CIDR range. Set them with
`zops route port create|update … --firewall-policy WHITELIST --firewall-ip-range <cidr>`;
`--allow-my-ip` adds the caller's current public address, which is the usual way to open a
database port to one workstation. `--firewall-ip-range` replaces the whole list rather than
appending, so a tightened whitelist is one call.

### Outbound, platform-wide

Zerops runs nftables with **TCP ports 1–1024 restricted — only 22, 53, 80, 123, 443 and 587 are
allowed outbound.** UDP and TCP 1025–65535 are unrestricted. Changing this requires emailing
`support@zerops.io` with the Project ID and Organization ID.

The consequence that bites most often is **email**: port **587 (STARTTLS) is the only usable SMTP
port**; 25 and 465 are permanently blocked. A perfectly ordinary `SMTP_PORT: "465"` silently never
connects.

**Verified live, and the failure mode matters:** the firewall **drops, it does not reject**. A probe
to `587` connects in ~0 s; probes to `465` and `25` **hang until timeout** (~16 s each in the test),
returning a timeout, not an instant connection-refused. So a wrong SMTP port does not fail fast —
the app stalls on every send. Budget for that when you see mysterious multi-second hangs in a mailer.

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

**Verified live, `X-Forwarded-Proto` did NOT reach a `bun@1.3.9` container** over a
`.zerops.app` subdomain: an app trusting it still saw the internal `http` scheme, and a
client-supplied value did not pass through either. `X-Real-IP` does arrive. Do not build an
origin or scheme check on `X-Forwarded-Proto` here without testing it — have the deployment
state its own public origin instead.

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

## CDN

nginx + Cloudflare geo-steering across six regions: Prague and Falkenstein (EU, also the global
fallback), London, Sydney, Singapore, Beauharnois. DNS TTL is 30 s, so node failover is fast, and EU
is always served if everything else is down.

Two modes today:

| Mode | Serves | URL | Project env var |
|---|---|---|---|
| **Object storage** | files in a Zerops object-storage bucket | `https://storage.cdn.zerops.app/<bucket>/path` | `${storageCdnUrl}` |
| **Static** | static assets behind a custom domain | `https://static.cdn.zerops.app/<domain>/path` | `${staticCdnUrl}` |

An API mode (`${apiCdnUrl}`) is announced but not released.

- Object-storage mode: enable the CDN option on the service (`zops cdn storage enable <service>`),
  then set a **public read** policy — private objects are never cached, they always fall through
  to origin.
- Static mode: enable **"Enable CDN for static files"** on the domain in the L7 balancer section,
  or pass `--cdn` to `zops route http create` / `zops route http update`.
  **Wildcard domains are not supported**; use specific names.
- Test one node directly with `https://{cz|de|uk|au|sg|ca}-{storage|static}.cdn.zerops.app/…`.

### Caching

**A fixed 30-day TTL, and HTTP caching headers do not influence it.** `Cache-Control`, `Expires` and
`Pragma` still drive *browser* caching, but the CDN ignores them. Content is evicted early only by
capacity (LRU) or an explicit purge. Version your filenames if you need immediate turnover.

```sh
zsc cdn purge example.com            # whole domain
zsc cdn purge example.com "/*"       # everything
zsc cdn purge example.com "/images/" # a directory
zsc cdn purge example.com "/css/main.css$"
```

`zsc cdn purge` runs from **any container in the project** that has the CDN-enabled domain active,
and **only works for static mode**. From outside a container, `zops` covers both modes — and the two
are separate endpoints, so purging one does nothing to the other:

```sh
zops cdn purge example.com "/images/"   # static mode, by domain and path
zops cdn storage purge "images/" assets # object-storage mode, by object path in the bucket
```

Pattern rules: a `*` wildcard must be **at the end**, a specific file must end with `$`, and nested
wildcards (`/dir/*.jpg`) are unsupported.

The `${storageCdnUrl}` / `${staticCdnUrl}` project variables only reach a container after a
**restart**. Services created before the CDN feature shipped may need a dummy project variable added
and removed to force the variable set to regenerate.

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

## Local development

Development on Zerops is **network-first**: every path below puts you on the same project-private
network, with the same hostnames, managed services and pipeline that staging and production use.
What differs between environments is policy — credentials, resources, data, release authority — not
the platform. Switching paths needs no reprovisioning.

| | Local + VPN | Cloud IDE | Native IDE over SSH |
|---|---|---|---|
| Editor runs | local | browser | local |
| Toolchain | local | hosted workspace | workspace or service container |
| Network entry | WireGuard VPN | browser into the project | VPN, then SSH |
| Hosted workspace | not needed | required | optional |
| Git auth | your local credentials | `gh auth login`, or a token in the workspace's `envSecrets` | SSH agent forwarding |
| Best for | keeping your existing setup | zero local setup, disposable envs | native UX, lighter laptop |

**Local + VPN** — `zcli vpn up <project-id>`, then point your normal dev loop at `db:5432`,
`cache:6379`, `api:3000` instead of Docker Compose. No `zcli push`, no new editor.

**Cloud IDE** — a normal Zerops service in the project with Browser VS Code, `zcli`, git tooling and
database clients. It can mount other services' runtime files (`/var/www/apidev`), so you can edit
code that runs in a different container. Reachable **VPN-only** (most secure) or on a `.zerops.app`
subdomain behind an auto-generated password.

**Native IDE over SSH** — once the VPN is up, `ssh apidev` works from VS Code Remote SSH, JetBrains
Gateway, Cursor, Zed or plain `ssh`. Agent forwarding keeps git pushes on your laptop's key:

```ssh-config
Host apidev.zerops
    HostName apidev
    ForwardAgent yes
```

### The env-variable gap

**The VPN gives network reachability, not the env store** — this is the thing that bites. Options,
in order of preference:

1. Generate a local `.env` with `zcp` (`zerops_env action="generate-dotenv"`), which resolves
   `${db_password}`-style references to real values —
   [`zcp-mcp.md`](zcp-mcp.md#generating-a-local-env).
2. Copy connection details from the service detail page (**Peek access details**).

Either way `.env` goes into `.gitignore` immediately, and it is a snapshot — regenerate it after any
env change in Zerops.

### Diagnosing a local connection

```sh
nc -zv db 5432 -w 3          # reachability — use this, not dig/nslookup
zcli vpn up <project-id>     # reconnect; one project at a time
```

| Symptom | Cause |
|---|---|
| `nc` times out | VPN down, or connected to the wrong project |
| Connects but auth fails | stale `.env` — regenerate |
| Name does not resolve | try the `.zerops` suffix; `dig`/`nslookup`/`host` bypass the system resolver and report false NXDOMAIN over the VPN |
| Service unreachable | the service is stopped, not a network fault |
