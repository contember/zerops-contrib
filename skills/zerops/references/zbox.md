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
  Everything *inside* — sandboxes, bases, templates, tokens, policy, domains, integrations,
  webhooks — goes through the workspace's own HTTP API, which the `zbox` CLI, the web console and `zbox mcp` all call.
  It is **not** part of the Zerops public API, so neither `zcli` nor `zops` reaches it.
- **Managed service, like a database.** No `zerops.yaml`, no build, no deploy, no backups, no web
  terminal in the GUI.
- **Billing**: only the workspace VM's CPU/RAM/disk. Sandboxes, snapshots, templates cost nothing
  extra; the VM size is the capacity. A stopped workspace still pays for disk.

## Which tool for what

| Task | Tool |
|---|---|
| Sandboxes, exec, files, shell/SSH, ports, bases, templates, snapshots, export/import, scoped tokens, policy, domains, integrations, connectors, webhooks, events | **`zbox`** CLI (or its API) |
| Code execution for an MCP client | `zbox mcp` (`claude mcp add zbox -- zbox mcp`) |
| Create the workspace | `zbox setup`, or import YAML / GUI (then finish it by hand, below) |
| Restart, reload, stop/start, resize, env vars, subdomain, custom domain route, orchestrator log | `zops` (or GUI; `zcli` only has stop/start) |

## Install and authenticate `zbox`

```sh
curl -fsSL https://box.zerops.io/install.sh | sh   # or: go install github.com/zeropsio/zbox-cli/cmd/zbox@latest
zbox login                                         # browser consent; or: zbox login --token <PAT>
```

Ways to reach a workspace:

- **Zerops login** (`zbox workspace authorize <service-id>`): the CLI mints a short-lived access via
  `POST /service-stack/{id}/ui-access` and Zerops adds the API key on the way. No key on disk. No
  50 MiB upload cap (a time limit still applies to long uploads). Always acts with the full key.
- **API key or scoped token** (`ZBOX_WORKSPACE_URL` + `ZBOX_API_KEY`, set both or neither; or
  `zbox workspace use <url> --api-key <key-or-token>`): for CI, backends and a sandbox managing its
  own workspace. On the public API URL **requests that send nothing for 60 s end with 504** (a long
  `zbox exec` fails while the command keeps running) and **uploads cap at 50 MiB**. From inside the
  project (`http://<hostname>.zerops:8080`, also over the VPN) neither limit applies.

`zbox workspace key` prints the key, which needs the login in **sudo mode** — a personal access token
cannot enter it, so this needs a browser `zbox login`. The key is the service env
`ZBOX_WORKSPACE_API_KEY`.

**The API key is total authority**, and so is a Zerops login (GUI, logged-in CLI). Give backends, CI
and sandboxes a **scoped token** instead:

```sh
zbox token create --name backend --scope sandbox          # secret printed once (zbt_...); -q prints only it
zbox token create --name ci --scope sandbox:read --scope webhook --expires 720h
zbox token list; zbox token revoke <token-id>             # revocation applies from the next request
```

- Scopes: `sandbox` (lifecycle, exec, files, shell/SSH, ports, snapshots, credentials, attachments,
  export/import; implies `sandbox:read`), `sandbox:read`, `base`, `integration`, `webhook`,
  `workspace` (policy, domains, quarantine), `admin` (everything except tokens). Sent as
  `Authorization: Bearer zbt_...`; out of scope → `403 forbidden` with the granting scopes in `meta`.
- Only the API key (or a Zerops login) manages tokens. A token cannot sign in to the console.
- **A `sandbox` token can read any workspace env var** by selecting it as a sandbox secret. Cap that
  with the workspace policy's `secrets.allowedModes` / `secrets.allowedNames` (below).
- **A `base` token equals the key**: base builds run on the workspace VM and a pull can send any env
  var to a registry. `admin` includes it.

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

Without a domain, sandbox ports have no public URL and `zbox open` has nothing to open. Project
services still reach them with the bare host (see Networking).

## The Zerops side — what each service action does to sandboxes

| Action | Running sandboxes | Parked sandboxes |
|---|---|---|
| **Reload** | keep running | untouched |
| Restart, stop+start, **resize**, node move | parked **with memory** first, within a 30 s budget | untouched |
| Delete | gone, with every base, snapshot and template | gone |

- Before the shutdown all running sandboxes sync their disks at once, then park one by one. Those the
  30 s budget does not reach come back `PARKED` **without memory**: processes gone, written files
  kept. With several large sandboxes, park them yourself first. Only reload keeps them running.
- **A workspace running since before the October 2026 Box release (enforced TTLs, export) needs one reload** (`zops service reload`, not a
  restart) to install it; until then restart, stop and resize still drop sandbox memory. After that
  reload, re-add the bases (Images, below).
- After a node move to another CPU a memory resume can fail → `FAILED`; `zbox wake` boots it from disk.
- **Every resize stops and starts the VM**, CPU and RAM included. Vertical only, never autoscales.
  **Disk only grows.** Limits: 2–24 cores, 2–48 GB RAM, 10–1024 GB disk.
- **No backups of the workspace.** Keep what matters with export (below).
- Env var edits apply **without** restart (secrets, integration credentials, registry logins),
  except `ZBOX_WORKSPACE_API_KEY`, which takes effect on the next reload. After rotation, logged-in
  GUI/CLI accesses keep sending the old key for up to an hour → `Missing or invalid Workspace API key or token`;
  rerun `zbox workspace authorize <id>`.
- `ZBOX_WORKSPACE_VOLUME_KEY` unlocks the LUKS data disk. Not editable.
- Orchestrator log: the service's runtime log, tag `zerops-zbox-orchestrator`. It never contains
  sandbox output — the main process logs to `/var/log/zbox-workload.log` inside the sandbox.
- Other services reach the API at `http://<hostname>:8080` with the key or a token as bearer. The
  console needs HTTPS: over the VPN it loads but sign-in silently fails.

## Capacity

- vCPU capacity = cores × `cpuOvercommit` (8). Memory = VM RAM − `coreReserveBytes` (512 MiB), never
  overcommitted — and no overcommit or ballooning is planned. Disk needs 1 GiB headroom.
- A **running** sandbox reserves its full memory size, not what it uses — a 4 GB workspace
  (3.3 GiB usable) runs one 2 GiB sandbox, not two, however idle it is. So does one that is creating,
  waking, restoring, parking or terminating. A **parked** or `FAILED` one reserves nothing. Base
  pulls/builds reserve 512 MiB while running. For mostly idle dev sandboxes, park them — an idle TTL
  does it automatically.
- **Disk is a cap, not a reservation.** Each sandbox sees its full `diskBytes` whatever is free; the
  headroom only stops new work. **A full workspace disk causes I/O errors in every running
  sandbox.** Deleting files inside a sandbox frees nothing (no discard); only removing it does. Watch
  `zbox workspace`.
- Out of capacity → `409 workspaceFull`, CLI exit 7. The workspace never evicts anything: park,
  remove, or resize.

## Sandbox lifecycle

```sh
zbox new app -p 8000                       # 1 vCPU / 512 MiB / 10 GiB disk unless --cpus/--memory/--disk or a template
zbox new agent --template dev --network project --idle-ttl 30m
zbox park app            # keeps memory; wake resumes processes
zbox park app --no-memory   # disk synced, guest shut down; next wake cold-boots
zbox wake app
zbox resize app --memory 2g --disk 20g     # cold boot: processes end, files stay
zbox fork app --name try-a --name try-b    # children continue running processes
zbox snapshot create app before --with-memory
zbox snapshot restore <id> --name app-2 --with-memory   # always a NEW sandbox
zbox remove -y app
```

- **The network mode is fixed at create.** Ports and the secret selection can change later.
- **Size (CPU, memory, disk) changes only with a cold boot**: `zbox resize` on a running sandbox,
  `zbox wake --cpus/--memory/--disk` on one parked without memory, or a different size on fork and
  disk restore. A memory image keeps its size → `409 resizeNeedsColdBoot`. A disk shrinks only down
  to what its files hold (`diskTooSmall`).
- **Implicit wake**: exec, process, shell, ssh, file ops and port requests wake a parked sandbox.
  Reading it, `zbox ps`, events and metrics do not.
- **TTLs are enforced** (checked every 15 s). **Idle TTL** parks a running sandbox *with memory*.
  **Absolute TTL** (from its own creation, any status) removes it → `ARCHIVED`, **disk and snapshots
  deleted**. Forks and restores inherit both. Never give a source or bootstrap sandbox an absolute
  TTL; check `zbox list --json` (`idleTtlSeconds`, `absoluteTtlSeconds`) and clear with
  `zbox set <id> --idle-ttl 0 --absolute-ttl 0`.
- **Idle activity**: boot/wake, file ops, starting a `zbox process`, an open shell or SSH, port
  requests (WebSocket only at open) — and a `zbox exec` **only when it ends**. A background process
  running on its own does not count, so a job longer than the idle TTL can be parked mid-run (which
  cuts its session). Choose an idle TTL longer than the longest job.
- **`zbox set` changes only the flags passed**; `--idle-ttl 0` / `--name ""` clears. `zbox rename`
  keeps the TTLs. **The API `PUT /sandbox/{id}` replaces the name and both TTLs** — always send all
  three, omitting only what should be cleared.
- **Removing a sandbox deletes its snapshots** (they still list, but cannot restore). To keep a
  bootstrap state beyond its sandbox, export it (below); templates come only from a base.
- Removed sandboxes stay listable for 7 days (`zbox list --status terminated,archived`), then their
  records, sessions and output are deleted.
- A disk-only snapshot of a running sandbox misses unflushed writes: `zbox exec app -- sync` first,
  or use `--with-memory`.
- A VM that dies on its own (e.g. OOM) keeps showing `RUNNING` and its reservation.
- `FAILED`: try `zbox wake`, else `zbox remove -y $(zbox list -q --status failed)`.
- Lifecycle calls are **operations**; the CLI waits by default (`--no-wait`, `--timeout`,
  `zbox operation wait <id>`). One operation per sandbox at a time → `operationInFlight`.
- API fork body: `children: [{name, cpus, memoryBytes, diskBytes}]` (each optional) — replaces
  `count`/`names`; sending both is refused. A child of another size boots cold.
- Sandboxes have no labels of their own yet; keep the mapping to your objects in the name or your DB.

## Export and import

The way to keep a bootstrap state or move a sandbox to another workspace. Only a **parked** sandbox
or a snapshot exports; for a running one export a snapshot.

```sh
zbox export create app -o app.tar.zst                  # file export: kept 24 h on the workspace disk
zbox export create --snapshot <snapshot-id> --no-memory
zbox export create app --prefix backups/ --url https://storage-prg1.zerops.io --bucket <bucket> \
  --access-key-env BACKUP_accessKeyId --secret-key-env BACKUP_secretAccessKey
zbox import --export <export-id> --name app-copy       # or --file app.tar.zst, or <bucket key> + bucket flags
```

- **Secret-bearing sandboxes and their snapshots never export** (Secrets, below) — bootstrap without
  secrets if the state must be exported.
- Bucket credentials are **names of workspace env vars**, ending in `_accessKeyId` and
  `_secretAccessKey` (e.g. `BACKUP_accessKeyId: ${storage_accessKeyId}`); the URL is the bare S3
  endpoint. The workspace never deletes bucket objects.
- Import needs the same base on the workspace (`baseNotFound` names the image). Memory resumes only
  from an archive this workspace exported, on the same Firecracker, CPU model and base build;
  otherwise it boots cold from disk. The imported sandbox has a new ID and lineage, no secret
  selection and no integration attachments.
- Limits: an import must finish within 10 min (bucket download included) or the sandbox is
  `FAILED`; a file export needs 1 GiB left free, an import its unpacked size + 1 GiB; a workspace
  restart fails running exports.
- Archives are **not encrypted** — keep files and buckets private. `--file` uploads hit the 50 MiB
  edge cap on the public API URL; use a bucket for large archives.

## Running commands

```sh
zbox exec app --json -w /workspace -- npm test   # argv, no shell, no stdin; cwd is / without -w
zbox process app -q -w /workspace -- npm run dev # background → session id
zbox session get <id>; zbox session output <id>; zbox session interrupt <id>
zbox file put app ./main.py /workspace/    # parent dir must exist
zbox file archive app /workspace -o ws.tar # file get is regular files only
```

- Everything runs as **root**. `exec` default timeout 60 s, max 10 min; stdout/stderr cut at 4 MiB
  each, silently in plain output — check `stdoutTruncated`/`stderrTruncated` under `--json`.
- `zbox exec` exit codes: the command's own; **125** = zbox itself failed; **127** = not found;
  **5** = `--timeout` hit.
- On the public API URL keep each exec well under 60 s; use `zbox process` for builds, test suites
  and servers (or call the API from inside the project).
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
- **`Authorization` and app cookies pass through** on every access mode. The router removes only its
  own credentials: `X-Zerops-Box-Authorization`, the `zbox_session` cookie, `?ticket=`/`?token=`.
  It keeps `X-Forwarded-*` from the edge.
- **A `token` port reads its token from `X-Zerops-Box-Authorization: Bearer <token>`** (or once from
  `?token=`, exchanged for a cookie). Plain `Authorization` no longer opens it.
- From a project service, use the **bare host** — no workspace domain needed, any access mode
  (non-`project` ports still want their credential):
  `curl -H "Host: 3000-<sandbox-id>" http://<ws-hostname>.zerops:8081/`. No edge limits on this path.
- **A `project` port refuses any request carrying `X-Forwarded-For`** (`403 PROJECT_ONLY`) — it
  treats it as coming from the edge. A proxy in front of such ports must not add it; other
  `X-Forwarded-*` are fine.
- Sandboxes are IPv4 only, but DNS answers AAAA: prefer IPv4 (`curl -4`,
  `NODE_OPTIONS=--dns-result-order=ipv4first`).
- `zbox ssh app` needs no key, VPN or sshd in the image, works airgapped. `zbox ssh-config --install`
  for plain `ssh`/`scp`/VS Code; host is `zbox-<sandbox-id>`. No `-R` forwards.

## Secrets and credentials

Values come from the **workspace service's env vars** (set them with `zops env set` or the GUI).
Variables starting with `ZBOX_` are never delivered.

- **Secret** (`zbox new agent --secret DATABASE_URL`): delivered as an env var; the sandbox holds the
  value. Names are exact; an unknown name is skipped silently.
- **Per-sandbox value via alias**: `--secret GUEST=WORKSPACE_VAR`, e.g.
  `zbox new pr42 --secret DATABASE_URL=DB_URL_PR42` — give each sandbox its own workspace var
  (`zops env set`, no restart) and the code sees a stable name. In policy:
  `"secrets": {"mode": "ALLOWLIST", "aliases": {"DATABASE_URL": "DB_URL_PR42"}}`. Works with
  `ALLOWLIST` and `ALL_ENVS` (`NONE` refuses aliases); an alias wins over a var of the same name.
- Secrets are delivered at create and on **every boot from disk**: wake after `park --no-memory`,
  resize, `--redeliver-secrets`, and **disk restore** (the current selection, not the old values).
  A memory wake keeps the values it had.
- **Secret-bearing** (`secretBearing`, for life): cannot be forked, snapshotted with memory, or
  **exported** (nor its snapshots). Disk snapshots work; their restores are secret-bearing too.
- **The API never returns env values.** `launchContract.envNames` (from `zbox new -e`, inherited by
  forks) and the session's `command.envNames` (from `exec -e` / `process -e`) list names only. Clients
  that read values from `launchContract.env` / `command.env` must stop. `-e` values are still not
  secrets: forks inherit them and they don't block fork/export — pass credentials with `--secret`.
- **Stale secrets**: any change to a selected var marks the sandbox stale. A parked stale sandbox
  refuses implicit wake (`secretsStale` / `503 SECRETS_STALE`); use `zbox wake --redeliver-secrets`
  (cold boot); on a running one it does the same in one operation, and so does a resize.
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
- **Template**: `zbox template create --base app --name dev --cpus 2 --memory 2g --disk 20g [-f policy.json]`.
  `--warm --warmup '<cmd>'` snapshots a booted sandbox, so creates resume instead of booting. A warm
  resume happens only at **exactly** the template's size (CPU, memory, disk) and not in `airgapped`
  mode — otherwise it cold-boots from the template's saved disk, so end the warm-up with `sync`.
  The warm-up has no network. Templates are made from a base only, not from a snapshot.
- **Bases embed the Zerops Box agent from when they were added** — re-add (`zbox base add <ref>
  --name <name>`) or rebuild them after platform updates; replace warm templates. Existing sandboxes
  stay on their old base; only new ones get the new agent.
- Default base: Ubuntu with Node.js, Python, gcc, git, `gh`, Claude Code, Codex; `/workspace`,
  `sleep infinity`. Guest kernel is fixed: no modules, no KVM, no swap. **Docker inside a sandbox
  is not supported yet.**

## Workspace policy and monitoring

- `zbox workspace policy > p.json`, edit, `zbox workspace policy -f p.json` (**replaces** the whole
  policy). Fields: `allowedNetworkModes`, `maxCpus`, `maxMemoryBytes`, `maxDiskBytes`,
  `defaultDiskBytes` (10 GiB), TTL caps, `coreReserveBytes`, `cpuOvercommit`, and the secrets
  ceiling `secrets.allowedModes` (`NONE`/`ALLOWLIST`/`ALL_ENVS`) and `secrets.allowedNames` (vars a
  sandbox may select or alias; a list refuses `ALL_ENVS`; **an empty list means no limit** — deny
  all secrets with `allowedModes: ["NONE"]`). Over a ceiling → `422 policyViolation`.
- **Set `secrets.allowedNames` before handing out a `sandbox` token.** Only the key or a
  `workspace`/`admin` token changes it.
- A sandbox policy is versioned: `PUT /sandbox/{id}/policy` takes the **whole** policy plus the
  `policyGeneration` that was read; a concurrent change → `409 policyGenerationConflict`, a missing
  generation → `invalidUserInput` "field is required". Read, modify, write back —
  `zbox policy app > p.json` prints it in that shape.
- `zbox events [--sandbox app] [--follow]`; webhooks `zbox webhook create --url … --event ready`
  (signing secret printed once; HMAC-SHA256 over `t.` + raw body; at-least-once, dedupe on
  `X-Zbox-Delivery`); hourly `zbox metrics app` (kept 30 days). Its `memoryPss*` counts the guest's
  file cache, so it reads as full after any large file I/O — check `zbox exec app -- free -m`.
- `OPERATION_FAILED` events record operations that failed but left the sandbox usable (refused park,
  failed wake or resize); an `ARCHIVED` event with `reason: absoluteTtl` explains a vanished sandbox.

## CLI contract

`--json` returns API objects; `-q` ids only; piped output is TSV. Destructive commands need `--yes`
without a TTY. Exit codes: `0` ok · `1` failed · `2` usage/invalid · `3` not found · `4` conflict ·
`5` wait timed out · `6` not authorized (incl. a token without the scope) · `7` unavailable or **workspace full** · `130` interrupted.

The API: every route under `/api/rest/`, bearer key or token (never in the query string), OpenAPI at
`<API URL>/api/rest/swagger/openapi.yml`. Capacity-consuming POSTs **require an `Idempotency-Key`**
header (export and import included, not the `--file` upload route); operations long-poll with `?waitSeconds=30`.
