# Operations — scaling, storage, observability, production

## Contents

- [Project core](#project-core)
- [Autoscaling](#autoscaling)
- [Vertical autoscaling](#vertical-autoscaling)
  - [Changing scaling on a live service](#changing-scaling-on-a-live-service)
- [Horizontal scaling](#horizontal-scaling)
  - [Moving a managed database to HA](#moving-a-managed-database-to-ha)
- [Persistence](#persistence)
- [Object storage](#object-storage)
- [Shared storage](#shared-storage)
- [Backups](#backups)
  - [Coverage](#coverage)
  - [Schedule, tags, retention](#schedule-tags-retention)
  - [Restoring](#restoring)
- [Logging](#logging)
- [Metrics and observability](#metrics-and-observability)
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

Fields for a `services:` entry in the import YAML:

```yaml
services:
  - hostname: app
    type: nodejs@22
    # Development — cheapest
    minContainers: 1
    maxContainers: 1
    verticalAutoscaling: { cpuMode: SHARED, minCpu: 1, maxCpu: 2, minRam: 0.25, maxRam: 1 }
```

Production, same shape: `minContainers: 2`, `maxContainers: 6`,
`verticalAutoscaling: { cpuMode: DEDICATED, minCpu: 2, maxCpu: 8, minRam: 2, maxRam: 8 }`.
Burst: `minContainers: 1`, `maxContainers: 10`,
`verticalAutoscaling: { cpuMode: SHARED, minCpu: 1, maxCpu: 8, minRam: 1, maxRam: 16 }`.

### Changing scaling on a live service

`verticalAutoscaling` and `minContainers`/`maxContainers` in the import YAML apply **at creation**.
Re-importing does not update a running service: `service-import` on an existing hostname is not an
update path, and `override: true` works only for runtime services, where it *replaces* the service
and forces a redeploy.

To change CPU mode, min/max CPU/RAM/disk, thresholds or container count on an existing service:
**GUI → service → Automatic scaling configuration**, or the REST API. Everything except the
`:single`/`:ha` variant can be changed there. PostgreSQL's `profile` can also be changed at any
time.

Decide from evidence: **GUI → Service containers & Overview** shows CPU, RAM and disk over time,
container-count changes, and past scaling events.

`zsc scale` is a *temporary* override inside the configured min/max — it cannot exceed the
configured maximum and silently clamps, so it is not a way to apply a config change. See
[`cli.md`](cli.md#zsc-scale-cpuram-value-durationauto).

**PostgreSQL restarts on some scaling changes.** Zerops regenerates the config and applies it with a
reload; if the granted RAM crosses a memory step — `256 MiB`, `512 MiB`, `1 GiB`, `2 GiB`, `4 GiB`,
then multiples of `8 GiB` — it restarts instead (rolling in HA, a short outage in single). Keep
`minRam` and `maxRam` within one step to rule restarts out.

## Horizontal scaling

`minContainers` / `maxContainers`, 1–10, runtimes and Linux containers only. New containers are
added once vertical scaling reaches its maximum. Set min = max to disable.

**Your application must be stateless**: no file-based sessions, no local uploads, no in-memory
state that matters. Otherwise scaling silently breaks behavior.

Managed services scale by the `:single` / `:ha` type variant only, immutable after creation. HA
recovery disconnects the failed container, creates a replacement on different hardware, syncs data
from healthy copies, and removes the failed one. PostgreSQL HA also exposes read replicas on 5433.

### Moving a managed database to HA

`:single` → `:ha` is a **new service**, not an edit, and hostnames are unique within a project — so
this is a data migration, not a toggle. Do not start by deleting anything.

1. **Back up, then protect the tag in the GUI.** `zsc backup-create db` from any container creates
   it; tagging is not available headlessly, so add `protected` in **Backups List & Configuration**
   before continuing — an untagged manual backup is prunable.
2. **Create the new service** under a different hostname (`dbha`), with the `:ha` variant. Set
   `profile` explicitly — HA defaults to `oltp-production`, which over-provisions.
3. **Move the data** over the VPN: `pg_dump`/`pg_restore` from old to new, or restore the downloaded
   backup schema by schema.
4. **Repoint every `${db_*}` reference** in `zerops.yaml` to the new hostname, redeploy, and verify
   the app actually talks to the new database.
5. **Delete the old service last.** Its backups survive 7 days.

If the hostname must stay `db`, that is a second migration: rename by repeating the process back
onto a freshly created `db` after the old one is gone.

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
- Connecting registers the link immediately, but **the FUSE mount only materialises on the next
  fresh deploy** (new container creation) — a plain restart does not bring it up. Redeploy after
  connecting.
- A runtime that was not yet deployed at import time does not pick up the import `mount:`; connect
  it explicitly once it is active.
- HA storage replicates 1:1 with automatic failover; the mount is briefly unavailable (~30 s)
  during a master failover.
- A shared-storage service holds at most **60 GB of data** regardless of disk scaling. For user
  uploads and high-write churn prefer object storage — shared storage is POSIX/NFS-style and not
  built for throughput.
- Mount output is logged as `zerops-mount-<hostname>`; individual file operations are not.
- `df` reports misleading numbers for these mounts — trust the GUI.
- Disconnect from all services before stopping or deleting the storage service.

Connect in the GUI (*Shared storage connections*), via `mount:` in the import YAML (requires
`buildFromGit`), or with `zsc shared-storage mount|unmount|wait <name>`.

## Backups

**Backups run automatically every day between 00:00 and 01:00 UTC by default** — there is nothing
to switch on. Manage them at GUI → service → **Backups List & Configuration**.

### Coverage

| Covered | Not covered |
|---|---|
| PostgreSQL, MariaDB, Qdrant, Elasticsearch, NATS, Meilisearch, **Shared Storage** | Runtimes, **Object Storage**, **Valkey / KeyDB** (in-memory) |

**ClickHouse** is not on the automatic path — use the native `BACKUP ALL …` SQL command as
superuser, which produces a `.tar.gz`.
**Object storage** needs its own scheme: S3 lifecycle policies, or `zsc object-storage backup` on a
cron (see [`cli.md`](cli.md#zsc-object-storage)).

### Schedule, tags, retention

Schedules: none / daily (default) / weekly / monthly / custom CRON (`min hour dom mon dow`).

Tags drive retention:

- **Automatic**: `daily` on every automatic backup, `weekly` on the first of each week (Monday UTC),
  `monthly` on the first of each month.
- **User tags**: up to 24 chars, `[A-Za-z0-9:-_]`.
- **Protected tags**: named in the retention config; those backups are exempt from automatic
  deletion.

**Manual backups get no automatic time tag, so without a protected tag they can be pruned.** Always
tag a pre-migration backup.

Retention defaults: at least 7 daily + 4 weekly + 3 monthly, max 50 backups per service. Storage:
5 GB included on Lightweight, 25 GB on Serious, 1 TiB technical maximum per project; beyond the
included tier it is billed. A backup that would exceed the storage limit is simply not stored.

Backups are encrypted end-to-end with a per-project X25519 key and decrypted only on download.
After a service or project is deleted, backups survive a **7-day grace period** — then the key is
destroyed and the data is unrecoverable.

### Taking one before a risky change

**There is no `zcli backup` command** — `features/backup.mdx` documents `zcli backup create … --tags`
but it does not exist in v1.1.0, the current release. The headless path is from inside any container
in the project:

```sh
zsc backup-create db
```

It takes a service name and nothing else. **It cannot set tags**, so a headless backup is untagged —
and per the retention rules above, an untagged manual backup gets no automatic time tag and can be
pruned. To take a genuinely protected pre-migration backup, tag it in the GUI (**Backups List &
Configuration**) right after creating it, or create it there in the first place. Listing, deletion,
retention and download are GUI-only regardless.

### Restoring

Zerops creates and stores backups; **restore is service-specific and manual**. Download the backup
from the GUI, then:

| Service | Format | Restore |
|---|---|---|
| PostgreSQL | `.zip` of per-schema `pg_dump -Fc` dumps | `pg_restore -d db <schema>.dump` per schema. Plain `psql` cannot read these — convert first with `pg_restore -f schema.sql <schema>.dump` if you need SQL |
| MariaDB | `.xb.gz` (`mariabackup`, xbstream + gzip) | mariabackup restore — **not** a `mysqldump` file |
| Shared storage | `.tar.gz` | `tar -xzf backup.tar.gz -C /mnt/<hostname>` from a runtime container that has it mounted. Not through the Filer UI, which caps uploads at 64 MB |
| Elasticsearch | `.gz` (elasticdump) | elasticdump |
| Meilisearch | `.dump` | Meilisearch import |
| Qdrant | `.snapshot` | Qdrant snapshot restore |
| NATS | `.tar.gz` | extract |

Reach the database over the VPN to run these. **Test a restore periodically in a non-production
project** — an untested backup is a guess.

### When a backup fails

Check the service log around the scheduled time, verify the service is healthy and has resources,
check `status.zerops.io` for platform incidents, then contact support with the service name, the
failure time and the logs.

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

## Metrics and observability

Built-in: **GUI → Service containers & Overview** for CPU/RAM/disk history, container count and
past scaling events. That is the first place to look for a resource question. Project statistics are
lost on a core upgrade; forwarded ones are not.

### Advanced Observability

A one-click GUI integration that deploys a self-hosted stack, either into the project (**local**) or
into a dedicated project (**global**):

- **ELK** — Elasticsearch as `elkstorage`, Kibana as `kibana`, plus `apmserver` for tracing and
  `logstash` for log collection.
- **Prometheus + Grafana** — `prometheus`, `grafana`, `grafanadb` (Postgres), `prometheusbackups`
  (S3, since Prometheus is single-instance filesystem-only). A `prometheuslight` forwarder service
  in a source project remote-writes into a central one.

Credentials for Kibana / Grafana are in the project's **Advanced Observability** section in the GUI.
Out-of-the-box dashboards cover service scaling and resources, PostgreSQL (with HAProxy metrics in
HA), MariaDB and Valkey.

### Exposing your own metrics

`ZEROPS_PROMETHEUS_PORT` is a variable **you set on your own service**, not a platform-provided
value:

1. Expose an HTTP `/metrics` endpoint on any port. Only the `/metrics` path is scraped and the path
   is not configurable.
2. Set `ZEROPS_PROMETHEUS_PORT` on the service — `9090`, or `9090,9091` for several ports.

Managed services expose their own exporters on this variable too (e.g. Valkey at `db:9121`).

Some PostgreSQL dashboards need `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` as superuser
followed by a service restart.

### Tracing

APM through the ELK stack: set `ELASTIC_APM_ACTIVE=true` (it defaults to `false` on Zerops),
`ELASTIC_APM_SERVICE_NAME`, `ELASTIC_APM_SERVER_URL` and `ELASTIC_APM_SECRET_TOKEN` from the GUI,
then restart the service. Traces appear in Kibana under *Applications → Traces*.

## Production checklist

**Databases**

| | Dev | Production |
|---|---|---|
| Variant | `postgresql:single@18` | `postgresql:ha@18` — [data migration, not a toggle](#moving-a-managed-database-to-ha) |
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
