# Operations — scaling, storage, observability, production

## Contents

- [Project core](#project-core)
- [Autoscaling](#autoscaling)
- [Vertical autoscaling](#vertical-autoscaling)
- [Horizontal scaling](#horizontal-scaling)
- [Persistence](#persistence)
- [Object storage](#object-storage)
- [Shared storage](#shared-storage)
- [Backups](#backups)
- [Logging](#logging)
- [Metrics](#metrics)
- [Production checklist](#production-checklist)

## Project core

Every project runs a core: logger, statistics, HTTP routing with automatic SSL, IP routing with
firewall.

| | Lightweight | Serious |
|---|---|---|
| Infrastructure | single container | multi-container, highly available |
| Build time included | 15 hours | 150 hours |
| Backup space | 5 GB | 25 GB |
| Egress | 100 GB | 3 TB |
| Failover | limited | comprehensive |
| SSL, certificates, balancer, IPv6 | yes | yes |

`corePackage: LIGHT` (default) or `SERIOUS` in the import YAML.

The upgrade LIGHT → SERIOUS is **one-way and partially destructive**: all project logs and
statistics are lost (forwarded ones are not), services are network-unavailable for ~35 s on
average, a $10 core fee is charged, and free resource allowances reset to the Serious limits. IP
addresses are unchanged. Choose deliberately at creation time.

## Autoscaling

| Service type | Vertical | Horizontal |
|---|---|---|
| Runtimes (Node.js, Go, PHP, Python, Java, …) | yes | yes, 1–10 containers |
| Linux containers (Alpine, Ubuntu) | yes | yes, 1–10 containers |
| Managed DB (PostgreSQL, MariaDB, ClickHouse) | yes | no — fixed by `:single` (1) / `:ha` (3) |
| Managed cache (Valkey, KeyDB) | yes | no — fixed by the variant |
| Shared storage | yes | no — fixed by the variant |
| Object storage | no | no — fixed quota, changeable in the GUI |
| Docker | no (manual, restarts the VM) | manual only, restarts the VM |

Pick the axis by symptom: CPU/memory pressure → vertical; request volume on a stateless service →
horizontal; disk filling → vertical disk; latency-sensitive on SHARED CPU → switch to DEDICATED.

## Vertical autoscaling

### CPU modes

| Mode | Behavior | For |
|---|---|---|
| `SHARED` | physical core shared with up to 10 tenants; throughput varies 1/10–10/10 | dev, staging, low-traffic production |
| `DEDICATED` | exclusive full physical cores | production, CPU-bound work |

CPU mode can be changed **once per hour**. `startCpuCoreCount` (default 2) is what a container gets
at start — raise it for heavy initialization.

### Thresholds

- `minFreeCpuCores` — 0.0–1.0, default 0.1. DEDICATED only. Scale up when free capacity on a single
  core drops below this.
- `minFreeCpuPercent` — 0–100, default 0 (disabled). Total free capacity across all cores.
- `minFreeRamGB` — default 0.0625 (64 MB).
- `minFreeRamPercent` — default 0 (disabled).

RAM uses **two independent thresholds and the one yielding more free memory wins**. With 12 GB
granted, `minFreeRamGB: 0.5` (500 MB) and `minFreeRamPercent: 5` (600 MB) → the 600 MB threshold
applies, and it grows automatically as RAM grows.

**Do not set `minFreeRamGB: 0` and `minFreeRamPercent: 0` together** — the API rejects it with
"Invalid custom autoscaling value".

### Limits and timing

| Resource | Min | Max |
|---|---|---|
| CPU cores | 1 | 8 |
| RAM | 0.125 GB | 48 GB |
| Disk | 1 GB | 250 GB |

PostgreSQL and MariaDB raise the RAM minimum to 0.25 GB.

| | CPU | RAM | Disk |
|---|---|---|---|
| Collection interval | 10 s | 10 s | 10 s |
| Scale-up window | 20 s | 10 s | 10 s |
| Scale-down window | 60 s | 120 s | 300 s |
| Minimum step | 0.1 core | 0.125 GB | 0.5 GB |
| Maximum step | 40 | 32 GB | 128 GB |

RAM and disk scale up on a single measurement; CPU needs two consecutive ones (~20 s) to ignore
spikes. Scale-down is deliberately slow to prevent flapping. Growth is exponential — small steps
first, larger under sustained load.

**Disk only grows, never shrinks.** A high `minDisk` is permanent for that container's lifetime.

### Spike protection

Autoscaling reacts in 10–20 s. `npm install`, `go build` and `cargo build` spike faster than that.
Set `minRam` high enough to absorb the first spike rather than relying on autoscaling — thresholds
handle gradual growth, not sub-10-second spikes. Services running pre-built artifacts only need
`minRam` to cover the startup peak (JVM heap, SSR warm-up).

### Disabling autoscaling

Set min = max for the resource: `minRam: 2, maxRam: 2`.

### Presets

```yaml
# Development
minContainers: 1
maxContainers: 1
verticalAutoscaling: { cpuMode: SHARED, minCpu: 1, maxCpu: 2, minRam: 0.25, maxRam: 1 }

# Production
minContainers: 2
maxContainers: 6
verticalAutoscaling: { cpuMode: DEDICATED, minCpu: 2, maxCpu: 8, minRam: 2, maxRam: 8 }

# Burst
minContainers: 1
maxContainers: 10
verticalAutoscaling: { cpuMode: SHARED, minCpu: 1, maxCpu: 8, minRam: 1, maxRam: 16 }
```

Temporary manual override from inside a container: `zsc scale` (see [`cli.md`](cli.md#zsc-scale-cpuram-value-durationauto)).

## Horizontal scaling

`minContainers` / `maxContainers`, 1–10, runtimes and Linux containers only. New containers are
added once vertical scaling reaches its maximum. Set min = max to disable.

**Your application must be stateless**: no file-based sessions, no local uploads, no in-memory
state that matters. Otherwise scaling silently breaks behavior.

Managed services scale by the `:single` / `:ha` type variant only, immutable after creation. HA
recovery disconnects the failed container, creates a replacement on different hardware, syncs data
from healthy copies, and removes the failed one. PostgreSQL HA also exposes read replicas on 5433.

Docker services run in **VMs**: no autoscaling, resource or VM-count changes restart the VM, disk
can only grow. Always pin image tags — `:latest` is cached and will not re-pull.

## Persistence

**The container filesystem is replaced on every deploy.** Files survive reload, restart and
stop/start; they are lost on deploy and on container replacement (scale-up/down, failover).

| Data | Where |
|---|---|
| User uploads, media | Object storage |
| Sessions, cache | Valkey |
| Database dumps | Object storage |
| Temporary files | Container disk is fine |
| Build artifacts | `deployFiles`, not storage |
| Shared POSIX files across containers | Shared storage |

## Object storage

S3-compatible (MinIO). One bucket per service, auto-named, immutable. Configuration and generated
variables in [`service-catalog.md`](service-catalog.md#object-storage). Key points:

- **Path-style addressing is mandatory** — `AWS_USE_PATH_STYLE_ENDPOINT: "true"` or the SDK's
  equivalent.
- Use `${storage_apiUrl}` (full `https://`) as the endpoint. Never `http://`.
- Region is required by SDKs, ignored by MinIO — use `us-east-1`.
- Runs on infrastructure separate from the rest of the project; reachable from Zerops and from the
  internet.
- **Not covered by Zerops backups.**

## Shared storage

```yaml
services:
  - hostname: files
    type: shared-storage:ha
```

- Mounted at `/mnt/<storage-hostname>` in **runtime containers only** — not build, not
  runtime-prepare.
- Content is shared across all containers of every connected service.
- Multiple storages can mount into one service.
- The mount point is owned by the `zerops` user — no sudo needed.
- Mounting **removes existing content** of the mount directory.
- Connecting/disconnecting is applied live without restarting containers.
- Mount output is logged as `zerops-mount-<hostname>`; individual file operations are not.
- `df` reports misleading numbers for these mounts — trust the GUI.
- Disconnect from all services before stopping or deleting the storage service.

Connect in the GUI (*Shared storage connections*), via `mount:` in the import YAML (requires
`buildFromGit`), or with `zsc shared-storage mount|unmount|wait <name>`.

## Backups

- Managed databases support scheduled backups; enable them for production.
- Backup space is included in the core package (5 GB Lightweight, 25 GB Serious).
- Trigger manually from a container with `zsc backup-create <stackName>`.
- Object storage is **not** backed up by Zerops — use `zsc object-storage backup` on a cron, or
  your own tooling.

## Logging

Three log types: **build**, **runtime prepare**, and **runtime/database** (stdout/stderr).

```sh
zcli service log -S <service-id>
zcli service log -S <service-id> --show-build-logs
zcli service log -S <service-id> --follow --format JSON
```

Plain stdout/stderr is recorded at "info" level. **Emit syslog format if you need severity
filtering.**

Forwarding is available to Better Stack, Papertrail, and self-hosted ELK. Zerops forwards over
**UDP syslog** — a self-hosted Logstash must listen on UDP. In a custom `syslog-ng` config use the
source name `s_src` (not `s_sys`); system certificates live at `/etc/ssl/certs`.

## Metrics

Managed services export Prometheus-compatible metrics on the port in `ZEROPS_PROMETHEUS_PORT`
(e.g. `db:9121`). Project statistics are visible in the GUI; forwarded statistics survive a core
upgrade, in-project ones do not.

## Production checklist

**Databases**

| | Dev | Production |
|---|---|---|
| Variant | `postgresql:single@18` | `postgresql:ha@18` — **must recreate** |
| Profile | `oltp-hobby` | `oltp-staging`, escalate only on clear load |
| Backups | optional | enabled |
| Reads | single primary | primary + replicas on 5433 |

**Application services**

- `minContainers: 2+` for throughput and crash tolerance. (Rolling deploys are already
  zero-downtime at any count — don't conflate the two.)
- `deploy.readinessCheck` **and** `run.healthCheck` configured.
- `cpuMode: DEDICATED`.
- Structured logging, debug mode off.
- Separate projects for dev / staging / production.
- Serious Core.

**Remove the dev scaffolding**

- Mailpit (`type: alpine@3.20` + `buildFromGit: …/recipe-mailpit`) → a real SMTP provider.
  Non-secret settings in `run.envVariables`, the key in `envSecrets`.
- Adminer → delete it, or at minimum turn off `enableSubdomainAccess` and reach it over the VPN.

**Stateless design**

- Uploads in object storage, sessions in Valkey, no local state.

**Framework specifics**

| Stack | Settings |
|---|---|
| Laravel | `APP_ENV: production`, `APP_DEBUG: "false"`, `TRUSTED_PROXIES: 127.0.0.1,10.0.0.0/8`, Redis sessions, `config:cache` + `route:cache` + `view:cache` |
| Symfony | `APP_ENV: prod`, trusted proxies as above, Monolog `SyslogHandler` |
| Django | `DEBUG: "false"`, `ALLOWED_HOSTS: .zerops.app,your-domain.com`, `CSRF_TRUSTED_ORIGINS`, `collectstatic` |
| Node.js | `NODE_ENV: production`, `HOST: 0.0.0.0`, health endpoint |
| Spring | `server.address: 0.0.0.0` (**required** — the default binds localhost), Actuator health, `-Xmx` matching the container |
| Phoenix | `PHX_SERVER: "true"`, `SECRET_KEY_BASE` from the preprocessor, `PHX_HOST` set to the domain |

**Recurring mistakes**

1. HA is immutable — plan it before creating the service.
2. Container filesystem is replaced on deploy.
3. File-based sessions break the moment there is a second container.
4. Mailpit is not an SMTP provider.
5. Debug mode leaks secrets.
6. Without health checks the balancer cannot route around an unhealthy container.
