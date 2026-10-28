# Zerops Box (`zbox@1`) — sandboxes for AI agents

**Beta.** Behaviour, API and CLI still change and there is no SLA. When something here disagrees
with `zbox --help` or the workspace's OpenAPI document, trust those.

Zerops Box runs isolated sandboxes — each a Firecracker microVM with its own kernel — for agents
that run untrusted code. Comparable to E2B, Daytona or Modal.

## Mental model

```text
Zerops project
├── your services
└── Box Workspace service (type zbox@1) = one VM = one workspace
    ├── orchestrator: HTTP API + web console on :8080, sandbox ingress on :8081
    ├── bases (images) and templates (base + size + policy, optionally warm)
    └── sandboxes (microVMs)
```

- **Two control planes.** Zerops manages the *service* (lifecycle, size, env vars, subdomain, logs).
  Everything *inside* — sandboxes, bases, templates, policy, domains, integrations, webhooks — goes
  through the workspace's own HTTP API, which the `zbox` CLI, the web console and `zbox mcp` all call.
  It is **not** part of the Zerops public API, so neither `zcli` nor `zops` reaches it.
- **Managed service, like a database.** No `zerops.yaml`, no build, no deploy, no backups, no web
  terminal in the GUI.
- **Billing**: only the workspace VM's CPU/RAM/disk. Sandboxes, snapshots, templates cost nothing
  extra; the VM size is the capacity. A stopped workspace still pays for disk.

## Which tool for what

| Task | Tool |
|---|---|
| Sandboxes, exec, files, shell/SSH, ports, bases, templates, snapshots, policy, domains, integrations, connectors, webhooks, events | **`zbox`** CLI (or its API) |
| Code execution for an MCP client | `zbox mcp` (`claude mcp add zbox -- zbox mcp`) |
| Create the workspace | `zbox setup`, or import YAML / GUI (then finish it by hand, below) |
| Restart, reload, stop/start, resize, env vars, subdomain, custom domain route, orchestrator log | `zops` (or GUI; `zcli` only has stop/start) |

## Install and authenticate `zbox`

```sh
curl -fsSL https://box.zerops.io/install.sh | sh   # or: go install github.com/zeropsio/zbox-cli/cmd/zbox@latest
zbox login                                         # browser consent; or: zbox login --token <PAT>
```

Two ways to reach a workspace:

- **Zerops login** (`zbox workspace authorize <service-id>`): the CLI mints a short-lived access via
  `POST /service-stack/{id}/ui-access` and Zerops adds the API key on the way. No key on disk. No
  60-second edge timeout, no 50 MiB upload cap.
- **API key** (`ZBOX_WORKSPACE_URL` + `ZBOX_API_KEY`, set both or neither; or `zbox workspace use
  <url> --api-key <key>`): for CI, other services, and a sandbox managing its own workspace. Goes
  through the public edge: **requests end after 60 s** (a long `zbox exec` fails with 504 while the
  command keeps running) and **uploads cap at 50 MiB**.

`zbox workspace key` prints the key, which needs the login in **sudo mode** — a personal access token
cannot enter it, so this needs a browser `zbox login`. The key is the service env
`ZBOX_WORKSPACE_API_KEY`.

**The API key is total authority**: no scopes, no per-user keys. Anyone who can read the service's
env vars or open the console from the GUI controls every sandbox. Grant project roles accordingly.

## Create a workspace

`zbox setup` does everything: new project `zbox-<timestamp>` (or `--project-id`), service `zbox`,
subdomain access on, default base pulled, 8081 subdomain added as a domain. Sizes: `--cpu --ram
--disk`, default 2 / 4 GB / 10 GB.

Created via import YAML or GUI, the workspace starts **without a base and without a domain**:

The docs write `zbox@1`; the live import schema lists it as `ubuntu/zbox@1`.

```yaml
services:
  - hostname: box
    type: zbox@1
    enableSubdomainAccess: true   # the GUI form leaves it off
```

```sh
zbox workspace authorize <service-id>
zbox base add https://storage.cdn.zerops.app/4ga3k-boxstorage/zbox/zbox-base.tar.gz --name default
zbox workspace domain add <hostname>-<prefix>-8081.<region>.zerops.app --form dash
```

Without a domain, sandbox ports have no public URL and `zbox open` has nothing to open.

## The Zerops side — what each service action does to sandboxes

| Action | Running sandboxes | Parked sandboxes |
|---|---|---|
| **Reload** | keep running | untouched |
| Restart, stop+start, **resize**, node move | killed → `PARKED` **without memory**; unflushed writes lost | untouched |
| Delete | gone, with every base, snapshot and template | gone |

- **Park running sandboxes before restart, stop or resize**, wake them after. Only reload is safe.
- **Every resize stops and starts the VM**, CPU and RAM included. Vertical only, never autoscales.
  **Disk only grows.** Limits: 2–24 cores, 2–48 GB RAM, 10–1024 GB disk.
- **No backups.** Lineage export is not available yet.
- Env var edits apply **without** restart (secrets, integration credentials, registry logins),
  except `ZBOX_WORKSPACE_API_KEY`, which takes effect on the next reload. After rotation, logged-in
  GUI/CLI accesses keep sending the old key for up to an hour → `Missing or invalid Workspace API key`;
  rerun `zbox workspace authorize <id>`.
- `ZBOX_WORKSPACE_VOLUME_KEY` unlocks the LUKS data disk. Not editable.
- Orchestrator log: the service's runtime log, tag `zerops-zbox-orchestrator`. It never contains
  sandbox output — the main process logs to `/var/log/zbox-workload.log` inside the sandbox.
- Other services reach the API at `http://<hostname>:8080` with the key as bearer token. The console
  needs HTTPS: over the VPN it loads but sign-in silently fails.

## Capacity

- vCPU capacity = cores × `cpuOvercommit` (8). Memory = VM RAM − `coreReserveBytes` (512 MiB), never
  overcommitted. Disk needs 1 GiB headroom.
- A **running** sandbox reserves its full size (+8 MiB), not what it uses — a 4 GB workspace
  (3.3 GiB usable) runs one 2 GiB sandbox, not two, however idle it is. A **parked** one reserves
  only disk. Base pulls/builds reserve 512 MiB while running.
- **Sandboxes do not reserve disk** — each sees 10 GiB regardless. Watch `zbox workspace`.
- Out of capacity → `409 workspaceFull`, CLI exit 7. The workspace never evicts anything: park,
  remove, or resize.

## Sandbox lifecycle

```sh
zbox new app -p 8000                       # 1 vCPU / 512 MiB unless --cpus/--memory or a template
zbox new agent --template dev --network project --idle-ttl 30m
zbox park app            # keeps memory; wake resumes processes
zbox park app --no-memory   # disk synced, guest shut down; next wake cold-boots
zbox wake app
zbox fork app --name try-a --name try-b    # children continue running processes
zbox snapshot create app before --with-memory
zbox snapshot restore <id> --name app-2 --with-memory   # always a NEW sandbox
zbox remove -y app
```

- **Size and network mode are fixed at create.** To change either, create a new sandbox.
- **Implicit wake**: exec, process, shell, ssh, file ops and port requests wake a parked sandbox.
  Reading it, `zbox ps`, events and metrics do not.
- **TTLs are recorded but not enforced yet.** Park or remove sandboxes yourself.
- **`zbox set` replaces name and both TTLs and clears what you omit** — always pass all three.
  `zbox rename` clears both TTLs.
- **Removing a sandbox deletes its snapshots** (they still list, but cannot restore). Restore into
  a new sandbox first if the state must survive.
- A disk-only snapshot of a running sandbox misses unflushed writes: `zbox exec app -- sync` first,
  or use `--with-memory`.
- A VM that dies on its own (e.g. OOM) keeps showing `RUNNING` and its reservation.
- `FAILED`: try `zbox wake`, else `zbox remove -y $(zbox list -q --status failed)`.
- Lifecycle calls are **operations**; the CLI waits by default (`--no-wait`, `--timeout`,
  `zbox operation wait <id>`). One operation per sandbox at a time → `operationInFlight`.

## Running commands

```sh
zbox exec app --json -- sh -c 'cd /workspace && npm test'   # argv, no shell, no stdin
zbox process app -q -- npm run dev                          # background → session id
zbox session get <id>; zbox session output <id>; zbox session interrupt <id>
zbox file put app ./main.py /workspace/    # parent dir must exist
zbox file archive app /workspace -o ws.tar # file get is regular files only
```

- Everything runs as **root**. `exec` default timeout 60 s, max 10 min; stdout/stderr cut at 4 MiB
  each, silently in plain output — check `stdoutTruncated`/`stderrTruncated` under `--json`.
- `zbox exec` exit codes: the command's own; **125** = zbox itself failed; **127** = not found;
  **5** = `--timeout` hit.
- Over the API key path keep each exec well under 60 s; use `zbox process` for builds, test suites
  and servers.
- **A park cuts open sessions** (`FAILED`). After a memory wake the process still runs, but its
  output and interrupt are lost; use `zbox ps` and `zbox exec … kill`.

## Networking

- **Ports are HTTP only**, declared as `port[/access][/wake|/no-wake]`: `zbox new app -p 3000/public`,
  `zbox port open app 5432/project`. Apps must bind `0.0.0.0`.
- Access modes: `members` (default; one-time ticket via `zbox open`), `ticket`, `token`, `public`,
  `project` (only from the project network). The API key never opens a port.
- **A `zbox open` session lasts about a minute** (its 60 s credential). For anything longer:
  `zbox credential issue app --port 3000 --ttl 2h`. Sessions cap at 12 h.
- Port URL: `https://<port>-<sandbox-id>-<8081 subdomain>` (dash form) or
  `https://<port>-<sandbox-id>.<your-domain>` (dot form, wildcard routed to port **8081**). Your own
  domain without a dedicated IPv4 drops IPv4 connections after ~2 min — WebSockets break.
- Egress by **network mode**: `project_internet` (default), `internet`, `project`, `airgapped`.
  Narrow with policy `egress` rules (IPv4 CIDRs or `project`, no domain names). With an `egress`
  block present, everything not allowed is dropped.
- **Inside a sandbox, project services resolve only as `<hostname>.zerops`** — bare hostnames don't.
- Sandboxes never reach each other or their workspace directly — only via public port URLs.
  The default mode **does** reach your project's databases; restrict with mode or workspace policy.
- **The router strips `Authorization`** (plus its own cookie and the `ticket`/`token` query params)
  on **every** access mode, `project` and `public` included. An app that authenticates callers with
  `Authorization` never sees it; use another header.
- From a project service to a `project` port: `curl -H "Host: <port-url-host>" http://<ws>.zerops:8081/`,
  with the host copied from the sandbox's `hosts`. Ports have no host without a workspace domain, so
  **even internal access answers `NO_ROUTE` until a domain is added**.
- `zbox ssh app` needs no key, VPN or sshd in the image, works airgapped. `zbox ssh-config --install`
  for plain `ssh`/`scp`/VS Code; host is `zbox-<sandbox-id>`. No `-R` forwards.

## Secrets and credentials

Values come from the **workspace service's env vars** (set them with `zops env set` or the GUI).
Variables starting with `ZBOX_` are never delivered.

- **Secret** (`zbox new agent --secret DATABASE_URL`): delivered as an env var; the sandbox holds the
  value. Names are exact and the sandbox sees the same name; an unknown name is skipped silently.
  A secret-bearing sandbox **cannot be forked or snapshotted with memory**; a disk snapshot works,
  and its restore starts without the secrets until a `park --no-memory` + wake.
- **`-e` env is never a secret.** `zbox new -e` is stored in the sandbox's `launchContract.env`,
  returned by every sandbox read and list, and copied to forks. `zbox exec -e` / `zbox process -e`
  is stored in the session's `command.env` and returned by the session and process lists.
- **Stale secrets**: any change to a selected var marks the sandbox stale. A parked stale sandbox
  refuses implicit wake (`secretsStale` / `503 SECRETS_STALE`); use `zbox wake --redeliver-secrets`
  (cold boot). A running one needs `park --no-memory` first.
- **Integration** (preferred for API tokens): the credentials proxy injects the credential; the
  sandbox calls `http://<label>.int.workspace/...` and never sees it.
  `zbox integration create stripe --target-url https://api.stripe.com --credential-env STRIPE_KEY --inject bearer`,
  then `--integration stripe` at create or `zbox attach`. Responses are not filtered — an endpoint
  that echoes headers leaks the credential.
- **Connectors** `claude`, `github`, `codex`: `zbox connector login <name>` or
  `gh auth token | zbox connector set github`. **Attach at create** (`--integration claude
  --integration github --integration github-api`) — tools inside are configured at boot, so a later
  attach routes traffic but leaves tools unconfigured until a cold boot. `gh` itself is not
  authenticated by the connector; `git` and the REST API are.
- Attaching to a sandbox parked with memory doesn't resolve after wake — attach to running ones.

## Images

- **Base**: `zbox base add python:3.12-slim --name python` (any OCI registry or a `docker save`
  tarball URL; private registry via `--registry-credential-env VAR` holding `user:token`), or
  `zbox base build ./dir --name app` (Dockerfile at context root, ≤512 MiB, ≤30 min). Must be
  `linux/amd64` and contain `/dev`, `/run`, `/etc`. `USER` is ignored.
- `--name` on add **takes the name over** from another base; adding an already-registered image
  under a new name renames that base.
- **Base builds run on the workspace VM** with access to the project network — build only trusted
  Dockerfiles.
- **Template**: `zbox template create --base app --name dev --cpus 2 --memory 2g [-f policy.json]`.
  `--warm --warmup '<cmd>'` snapshots a booted sandbox, so creates resume instead of booting. A warm
  resume happens only at **exactly** the template's size and not in `airgapped` mode — otherwise
  it cold-boots without the warm-up. The warm-up has no network.
- **Bases embed the Zerops Box agent from when they were added** — re-add/rebuild them after
  platform updates; replace warm templates.
- Default base: Ubuntu with Node.js, Python, gcc, git, `gh`, Claude Code, Codex; `/workspace`,
  `sleep infinity`. Guest kernel is fixed: no modules, no KVM, no swap. **Docker inside a sandbox
  is not supported yet.**

## Workspace policy and monitoring

- `zbox workspace policy > p.json`, edit, `zbox workspace policy -f p.json` (**replaces** the whole
  policy). Fields: `allowedNetworkModes`, `maxCpus`, `maxMemoryBytes`, TTL caps, `coreReserveBytes`,
  `cpuOvercommit`. Over a ceiling → `422 policyViolation`.
- A sandbox policy is versioned: `PUT /sandbox/{id}/policy` takes the **whole** policy plus the
  `policyGeneration` that was read, and a concurrent change is refused. Read, modify, write back —
  `zbox policy app > p.json` prints it in that shape.
- `zbox events [--sandbox app] [--follow]`; webhooks `zbox webhook create --url … --event ready`
  (signing secret printed once; HMAC-SHA256 over `t.` + raw body; at-least-once, dedupe on
  `X-Zbox-Delivery`); hourly `zbox metrics app`.

## CLI contract

`--json` returns API objects; `-q` ids only; piped output is TSV. Destructive commands need `--yes`
without a TTY. Exit codes: `0` ok · `1` failed · `2` usage/invalid · `3` not found · `4` conflict ·
`5` wait timed out · `6` not authorized · `7` unavailable or **workspace full** · `130` interrupted.

The API: every route under `/api/rest/`, bearer key (never in the query string), OpenAPI at
`<API URL>/api/rest/swagger/openapi.yml`. Capacity-consuming POSTs **require an `Idempotency-Key`**
header; operations long-poll with `?waitSeconds=30`.
