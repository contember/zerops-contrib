# Service catalog

Which service types exist, which version string to write where, and what each one hands you as
environment variables.

## Contents

- [Two different version strings](#two-different-version-strings)
- [Choosing a service](#choosing-a-service)
- [HA variants and profiles](#ha-variants-and-profiles)
- [Generated environment variables](#generated-environment-variables)
  - [PostgreSQL](#postgresql) · [MariaDB](#mariadb) · [Valkey](#valkey) · [KeyDB](#keydb-legacy)
  - [Object storage](#object-storage) · [Local storage](#local-storage) · [SeaweedFS](#seaweedfs)
  - [Search engines](#search-engines)
  - [Administering a database](#administering-a-database) · [Platform variables](#platform-variables)
- [Swarm — pools of containers you drive over HTTP](#swarm--pools-of-containers-you-drive-over-http)
- [Version tables](#version-tables)

## Two different version strings

- **`type:` in import YAML** — provisions the service. Includes the deployment variant:
  `postgresql:ha@18`, `seaweedfs:ha@3.85`, `php-nginx@8.4`.
- **`base:` in `zerops.yaml`** — selects the build/run toolchain: `nodejs@22`, `php@8.4`
  (build) vs `php-nginx@8.4` (run).

They overlap but are not the same list. Managed services have no `base:`; you never write a
`zerops.yaml` for a database.

`@latest` resolves to the newest stable version. Aliases on the same row of the tables below are
the same underlying version.

## Choosing a service

| Need | Use | Why |
|---|---|---|
| Relational database | **PostgreSQL** | Best-supported: HA, read replicas, pgBouncer, tuning profiles |
| MySQL compatibility | MariaDB | MaxScale routing, async replication |
| Analytics / OLAP | ClickHouse | Columnar, ReplicatedMergeTree |
| Cache / sessions | **Valkey** | Redis-compatible, active development. KeyDB is effectively deprecated |
| Messaging | **NATS** | Simple, fast; JetStream when durability is needed |
| Event streaming at scale | Kafka | SASL, 3-broker HA, unlimited retention, strong ordering |
| Full-text search | **Meilisearch** | Instant setup, typo-tolerant, frontend-safe keys. Single node only |
| Advanced / HA search | Elasticsearch | Multi-node, plugins, JVM tuning |
| Autocomplete with HA | Typesense | 3-node Raft, CORS built in |
| Vector / similarity | Qdrant | HTTP + gRPC, cluster replication, internal-only |
| Uploads, media, backups — files that outlive a deploy | **Object storage** (S3/MinIO) | Container disk is replaced on deploy. Not covered by Zerops backups |
| A real filesystem: SQLite, Prometheus, Gitea, certs shared between services | **Local storage** | Single-kernel POSIX — locking, mmap, inotify correct across containers. Not HA; pins every connected service to one machine |
| HA network filesystem shared between services | SeaweedFS | You mount it yourself (`weed mount`). Per-mount locks — **never a database on it** |
| Shared POSIX filesystem | ~~Shared storage~~ | **Deprecated** — every one was converted to SeaweedFS; see [SeaweedFS](#seaweedfs) |
| Static site | `static` | Build on `nodejs@latest`, run on `static` |
| Reverse proxy / custom webserver | `nginx` | |
| Pre-built container image | `docker` | Runs in a **VM**; no autoscaling; needs `--network=host` |
| Plain Linux box | `alpine` / `ubuntu` | Full autoscaling, same as runtimes |
| Sandboxes for AI agents | Box Workspace (`zbox@1`) | One VM hosting Firecracker microVMs; managed via `zbox`, not `zerops.yaml`. See [`zbox.md`](zbox.md) |
| Pool of containers or VMs your code creates, leases, `exec`s into and removes (CI jobs, per-task workspaces) | Swarm (`swarm@1` / `swarm-vm@1`) | Synchronous HTTP API inside the project, no Zerops API round trip. **Not Docker Swarm.** See [Swarm](#swarm--pools-of-containers-you-drive-over-http) |

### Runtime base OS

Prefer **Alpine**. Switch to Ubuntu (26.04 LTS; 24.04 and 22.04 also available) only for glibc
needs: CGO-enabled Go, glibc-built Python C-extension wheels, or **Deno** (Ubuntu image only).
Needing a package is *not* a reason — both install packages (`sudo apk add` / `sudo apt-get install`).

**The OS is part of the base identifier — always write it**: `alpine/<tech>@<ver>` or
`ubuntu/<tech>@<ver>`, the same value in the import `type` and in both `build.base` and `run.base`.
A bare `<tech>@<ver>` is legacy and resolves differently per file: import → Ubuntu,
`zerops.yaml` → Alpine. And `run.base` **rewrites the service's OS on every deploy**.

Verified live: `type: bun@1.3.9` produced a service reporting
`serviceStackTypeVersionName: ubuntu/bun@1.3.9`, while the same string as `base:` resolved the build
to `alpine/bun@1.3.9` (visible as the appVersion's `base`). So anything comparing a declared `type`
against the live one must treat a declaration with no OS prefix as matching any prefix, or it reports
drift on a service it just created from that file.

## HA variants and profiles

Container count for managed services is fixed by the **type variant**, set at creation and
**immutable**:

| Variant | Containers | Use |
|---|---|---|
| `:single` | 1 | Development, non-critical |
| `:ha` | 3, on separate physical machines | Production, automatic failover |

Switching is a data migration, not an edit — see
[`operations.md`](operations.md#moving-a-managed-database-to-ha).

**Only some services have a variant.** Where one exists it is the current spelling and the legacy
`type: X@ver` + `mode: HA` form is deprecated (still remapped, ignored by validation). Where none
exists, `mode:` remains the documented and only way to get HA.

| Service | HA mechanism |
|---|---|
| PostgreSQL, MariaDB, ClickHouse, Valkey | `:single` / `:ha` type variant |
| SeaweedFS | `:single` / `:ha` variant, but `:ha` is **2** containers (1:1 replication) |
| Elasticsearch, Typesense, Kafka | `mode: HA` — **not** deprecated here, no variant exists |
| Meilisearch, Qdrant, object storage | single node only |
| Local storage | `local-storage:single@1` only — no HA mode yet |

The generated version tables below come from the docs site's `data.json`, which still lists the
variant-capable services in their bare form (`mariadb@10.6`, `valkey@7.2`, `clickhouse@25.3`).
Write the variant anyway: `mariadb:single@10.6`, `valkey:ha@7.2`, `clickhouse:single@25.3`.

### PostgreSQL `profile`

Sets both the autoscaling envelope and the PostgreSQL tuning preset.

| Workload | `:single` | `:ha` |
|---|---|---|
| dev / prototype — cheapest | `oltp-hobby` | — (no hobby tier) |
| staging / early-stage | `oltp-staging` *(single default)* | `oltp-staging` |
| business-critical transactional | `oltp-production` | `oltp-production` *(HA default)* |
| high-throughput OLTP | — | `oltp-enterprise` |
| analytics / warehouse | `olap-production` | `olap-production` |
| write-heavy ingestion | `writeheavy-production` | `writeheavy-production` |

Set `profile` explicitly. Omitting it on `:ha` applies `oltp-production` — dedicated CPU and high
minima, which over-provisions most projects. `profileOverrides` (individual params like `work_mem`,
`max_wal_size`, `autovacuum_*`) requires `profile: custom`; `verticalAutoscaling` tightens the
envelope on top of any profile without needing `custom`.

### Valkey `profile`

`hobby` / `staging` *(default)* / `production`. Use `hobby` for dev.

MariaDB and ClickHouse have no `profile` — size them with `verticalAutoscaling`.

## Generated environment variables

Zerops creates connection variables on each managed service. Reference them from another service
as `${<hostname>_<variable>}` — under the default `envIsolation: service` they are **not**
auto-injected. Examples below assume the service hostname `db` / `storage`.

### PostgreSQL

| Variable | Value |
|---|---|
| `hostname` | service hostname |
| `port` | `5432` — primary, read/write, **plaintext only** |
| `portReplicas` | `5433` — read-only replicas, HA only, plaintext only |
| `portTls` | `6432` — pgBouncer pooler, **TLS required** |
| `user` | `db` by default |
| `password` | generated |
| `dbName` | `db` by default |
| `superUser` / `superUserPassword` | the `postgres` superuser — needed for `CREATE EXTENSION` (`pg_stat_statements`, `vector`, `postgis`) |
| `connectionString` | `postgresql://${user}:${password}@${hostname}:5432` — see the note below |
| `connectionTlsString` | same, via `6432` |
| `connectionStringReplicas` | `…@${hostname}:5433` (HA only) |

- **`connectionString` does NOT include the database path** — verified live on `postgresql:single@18`
  it is exactly `postgresql://db:<password>@db:5432`, no trailing `/db`. (Upstream is contested: the
  PostgreSQL reference page shows it with the path, the newer guide without — the guide is right.)
  So append `/${db_dbName}` yourself if your driver needs the database in the URL; appending when the
  value already had it would give `…/db/db`, but it does not. From a sibling service the database
  name is `${db_dbName}`, never a bare `${dbName}` (which would not resolve). If unsure on another
  version, read it: `zcli project env --service db | grep connectionString`.
- `5432`/`5433` do not support TLS — connect with `sslmode=disable`. Requesting TLS fails the
  handshake. Security comes from the private network / VPN tunnel.
- `6432` **requires** TLS (`sslmode=require` is enough; `verify-full` needs the Zerops CA). Prefer
  it for high connection churn (PHP-FPM, serverless). Transaction pooling means session-scoped
  features (session `SET`, cross-statement advisory locks, `LISTEN`/`NOTIFY`) misbehave — use
  `5432` for those.
- Zerops uses the `postgresql://` scheme. If your library demands `postgres://`, create your own
  variable.
- A system user `zps` exists for maintenance — do not delete it or change its privileges.
- Changing the password in the database does **not** update the env var. Update both.
- **`max_connections` follows RAM and cannot be overridden**: 50 per GiB (20–500) for OLTP and
  WriteHeavy profiles, 25 per GiB (10–200) for OLAP, counted in memory steps (7 GB RAM still gets
  the 4 GiB limit of 200). 3 are reserved for superusers and Zerops uses up to 4 more. pgBouncer
  (`6432`) accepts `20 × (max_connections − 4)` clients (≥ 100) but pools into at most
  `2 × vCPU + 1` server connections per user/database pair; excess transactions queue. Out of
  connections → use `6432`, or raise minimum RAM to the next step.
- HA: limits are per node; `5433` balances across both replicas. The two proxies each run a
  pgBouncer with the full client limit into the same primary, and close connections on
  `5432`/`5433` idle for 60 minutes.

### MariaDB

| Variable | Value |
|---|---|
| `hostname`, `user`, `password`, `dbName` | as above |
| `port` | `3306` (fixed) |
| `connectionString` | `mysql://${user}:${password}@${hostname}:3306` — no database path |

`connectionString` auto-updates when `user`/`password` change.

### Valkey

| Variable | Value |
|---|---|
| `port` | `6379` plaintext |
| `portTls` | `6380` TLS |
| `password` | generated, sensitive |
| `connectionString` | `redis://default:<password>@<hostname>.zerops:6379` |
| `connectionTlsString` | `rediss://default:<password>@<hostname>.zerops:6380` |
| `portReplicas` / `portTlsReplicas` | `7000` / `7001` (HA, read-only) |
| `connectionStringReplicas` / `connectionTlsStringReplicas` | read-only URLs |

Username is always `default`. **Auth is mandatory** — a bare `redis://<hostname>:6379` fails with
`NOAUTH Authentication required`. There is no `user` variable. Replica reads lag slightly.

### KeyDB (legacy)

`hostname`, `port` `6379`, `connectionString` `redis://<hostname>:6379`, password in the GUI.
No TLS; cannot be exposed publicly. Prefer Valkey for new projects.

### Object storage

| Variable | Value |
|---|---|
| `apiUrl` | full `https://…` S3 endpoint — use this for any SDK's `endpoint` option |
| `apiHost` | host only, no scheme |
| `accessKeyId` / `secretAccessKey` | S3 credentials |
| `bucketName` | `<prefix>-<hostname>`, immutable (e.g. `4gl2o-storage`) — the random prefix comes **first**; never compose it from the hostname, read `${storage_bucketName}` |
| `quotaGBytes` | bucket quota |
| `projectId`, `serviceId`, `hostname` | identifiers |

```yaml
run:
  envVariables:
    S3_ENDPOINT: ${storage_apiUrl}
    S3_ACCESS_KEY: ${storage_accessKeyId}
    S3_SECRET_KEY: ${storage_secretAccessKey}
    S3_BUCKET: ${storage_bucketName}
    S3_REGION: us-east-1
    AWS_USE_PATH_STYLE_ENDPOINT: "true"
```

- **Path-style addressing is mandatory** (MinIO): `forcePathStyle` / `use_path_style_endpoint` /
  `addressing_style: path` / `pathStyleAccessEnabled`, depending on the SDK. Virtual-hosted style
  fails.
- Never `http://` — the gateway 301-redirects to HTTPS and most SDKs do not follow it. The symptom
  is `UnknownError` or connection refused on the first bucket call.
- `S3_REGION` is required by SDKs and ignored by MinIO; `us-east-1` is fine.
- Public URL format: `{apiUrl}/{bucketName}/path/to/file`.

### Local storage

`type: local-storage:single@1`. A persistent volume local to **one physical machine**, mounted into
runtime containers through `run.volume` in `zerops.yaml` — not through env vars or import:

```yaml
run:
  volume:
    hostname: vol          # required; must be a Local Storage service in the project
    mountPath: /srv/data   # optional, default /mnt/<hostname>; /etc, /var, /var/www, /tmp rejected (subdirs allowed)
    readOnly: false        # optional
```

- **Every container of every connected service is scheduled onto the volume's machine.** That ties
  the runtime services themselves to one host: a hardware failure takes them all down together, and
  horizontal scaling is capped by that host's free capacity. On failure or maintenance Zerops moves
  the volume (stop, move, start) and **recovery of the data is not guaranteed** — keep backups on.
- Real local kernel mount, no FUSE: `flock`/`fcntl` locks, mmap (SQLite WAL), inotify and atomic
  rename work across containers and services. Still single-writer for SQLite — write from one
  service, mount `readOnly: true` everywhere else.
- One volume per runtime service; many services may mount the same one. Runtime containers only —
  **not in build or prepare**. Applied by a deploy: change or drop `volume` and deploy again.
- Capacity = the service's max disk in `verticalAutoscaling`. The service's own container has the
  volume at `/data` (SSH / web shell). A Local Storage service cannot be deleted while a runtime
  still mounts it.
- Daily backups are `.tar.gz` of the **live** volume, so database files can be caught mid-write.
  For SQLite, run a `run.crontab` job (`allContainers: false`) that writes
  `sqlite3 <db> ".backup /mnt/vol/backup.db"` and let the archive pick that copy up.

### SeaweedFS

`type: seaweedfs:single@3.85` / `seaweedfs:ha@3.85`. Zerops runs the cluster; **mounting is your
job**. Generated variables: `hostname`, `port` (`8888`).

| Endpoint | Address |
|---|---|
| Filer HTTP API + Filer UI | `http://<hostname>.zerops:8888` |
| Filer gRPC (used by `weed mount`) | `<hostname>.zerops:18888` |
| One container's filer (`n` = 1 or 2) | `node-stable-<n>.db.<hostname>.zerops:8888` |

No authentication; private network and VPN only, cannot be routed publicly.

```yaml
run:
  startCommands:
    - name: app
      command: npm start
    - name: storage                      # supervised: restarted if it exits
      initCommands:
        - sudo mkdir -p /mnt/storage
        - sudo chown zerops:zerops /mnt/storage
      command: sudo /opt/zerops/bin/weed-3-85 mount -filer=node-stable-1.db.storage.zerops:8888 -dir=/mnt/storage
```

- Shortcut: `zsc shared-storage mount <hostname>` mounts `/mnt/<hostname>` with RAM-lean tuning
  (~100–150 MB). A bare `weed mount` caches aggressively and can grow to hundreds of MB. When an
  `initCommand` needs the files, mount there with `sudo zsc shared-storage mount <hostname> --background`
  — but **nothing restarts a background mount** if it dies, and a lost mount does not fail the health
  check.
- **Per-mount locks and an append-only store: never SQLite, Prometheus or any file-based database**
  (corruption once two containers touch it). Small in-place modifications cause heavy write
  amplification.
- **Data capped at 60 GB** regardless of the disk setting. HTTP API uploads cap at 64 MB per file
  (mounts have no such limit). `df` inside a mount lies; read usage in the GUI.
- Not mounted during build or runtime prepare.
- In `:ha`, replacing the master container makes the cluster unavailable for ~30 s.

**Shared Storage is gone.** Every Shared Storage service was converted in place into SeaweedFS
(same hostname and data). `shared-storage:single` / `:ha` in an import still works and creates
SeaweedFS. The import `mount:` field and the GUI connections page are removed — `mount:` fails with
`yamlMountDeprecated`. Old mounts survive best-effort through the `zeropsSharedStorageMounts` env
(`|`-separated hostnames, mounted at `/mnt/<hostname>` on start, deprecation warning in the runtime
log). Migrate: add the mount start command above, delete that env, deploy. For anything that needs
real locking, move the data to Local Storage instead.

### Search engines

| Service | Keys |
|---|---|
| Meilisearch | `masterKey` (admin), `defaultSearchKey` (frontend-safe), `defaultAdminKey` (backend) |
| Typesense | `apiKey` — immutable once generated; data at `/var/lib/typesense` |
| Qdrant | `apiKey` (full), `readOnlyApiKey` (search only) |
| Elasticsearch | `PLUGINS` (comma-separated) and `HEAP_PERCENT` (default 50) — set in `envSecrets` |

### Administering a database

Databases are **not SSH-able**. Reach them over the VPN with an ordinary client:

```sh
zcli vpn up <project-id>
PGPASSWORD=<password> psql -h db -U db -d db      # try db.zerops if the name does not resolve
mysql -h db -u db -p                              # MariaDB
redis-cli -h cache -p 6379 -a "$cache_password"   # Valkey
```

Environment variables are not available over the VPN — copy connection details from the service
detail page (**Peek access details**).

Desktop clients (pgAdmin, DBeaver, DataGrip, TablePlus) work the same way. Connect **without**
TLS on `5432`/`5433`; the tunnel already encrypts.

For a browser-based tool, deploy the Adminer recipe into the project and reach it over the VPN at
`http://adminer` (never `https`):

```yaml
services:
  - hostname: adminer
    type: php-apache@8.5
    maxContainers: 1
    buildFromGit: https://github.com/zeropsio/recipe-adminer
```

Leave `enableSubdomainAccess` off and remove it before production.

Export and import:

```sh
pg_dump db > dump.sql          &&  psql -d db < dump.sql
pg_dump -Fc db > dump.dump     &&  pg_restore -d db dump.dump
mysqldump -h db -u db -p db > dump.sql
```

### Platform variables

`hostname` and `PATH` exist on every service. `PATH` is hard-reserved — setting it returns
`userDataUseOfSystemKey`. Overridable platform variables include `envIsolation`, `sshIsolation`,
`zeropsSubdomainHost` and the CDN URLs.

Inside containers: `ZEROPS_StackName` (service name), `ZEROPS_appVersionId` (current app version —
a good `zsc execOnce` key), `ZEROPS_PROMETHEUS_PORT` (metrics port on managed services).

## Swarm — pools of containers you drive over HTTP

`swarm@1` (Ubuntu 26.04 containers) or `swarm-vm@1` (Docker VMs, for an own kernel or running
Docker). **Zerops Swarm is not Docker Swarm.** Type and hostname are fixed after creation. Compare
Box Workspace (`zbox@1`, [`zbox.md`](zbox.md)): Swarm containers are ordinary Zerops containers in
the project, sharing the host kernel unless you pick the VM type.

```yaml
services:
  - hostname: sandbox
    type: swarm@1
    startWithoutCode: true   # usable without a first deploy
    minContainers: 0         # kept by Zerops; API refuses removals below it
    maxContainers: 10        # API refuses creates above it; stopped containers count
```

`swarm-vm@1` takes fixed `verticalAutoscaling: {cpu, ram, disk}` (default 1 / 1 GB / 5 GB);
changing them restarts the VM.

- **No load-based horizontal scaling** — `minContainers`/`maxContainers` are limits for your API
  calls. An orchestrator container serves the API, a web UI and `/swagger` at
  `http://orch.<hostname>.zerops` (no public address). Create, start, stop, restore and fork are
  synchronous — give the HTTP client a timeout of minutes for a VM pool.
- **Auth**: `Authorization: Bearer ${<hostname>_API_TOKEN}` from services; **not needed from the
  VPN**. `ADMIN_TOKEN` (`X-Swarm-Admin-Token`) only to `force` a container away from its holder.
  An empty `API_TOKEN` opens the API to the whole private network. Pool containers never see either
  token. Token edits take effect on **reload** (leaves pool containers alone); restart restarts
  them all.
- **Leases**: `POST /container/acquire` → container + `lease`; pass `?lease=` to `exec` and
  `release`. Set `leaseTtlSeconds`, or a crashed consumer holds its container until an admin forces
  it. `acquire` errors `containers-preparing` and `all-reserved` are retryable.
  `POST /container/run` picks or creates one, runs a command, cleans up.
- `exec` streams NDJSON (`stdout`/`stderr` base64, final `exit` with `exitCode`; a `reason` means
  something other than the command ended it). One command per container; closing the connection
  cancels it.
- **Dirty vs clean**: any command dirties a container; only a reset to the primary snapshot
  (`release?reset=true`, acquire with `"clean": true`, or empty-body restore) cleans it. Containers
  Zerops creates to fill `minContainers` have **no primary snapshot, so resetting them fails** — keep
  the minimum at 0 and create warm containers with `POST /container` if you rely on resets.
- Snapshots: at most 5 per container; **restoring deletes every newer snapshot**.
- **Image**: deploy a `zerops.yaml` (`setup: <hostname>`) to it; `prepareCommands` build the image,
  `run.start` runs in every pool container if set. A deploy **never touches existing containers** —
  they keep the old image (`current: false`) until `POST /container/rollout`, which cannot run when
  `minContainers == maxContainers` (`pool-fixed-size`). `swarm-vm@1` accepts only VM bases
  (`docker@26.1`).
- SSH from the VPN works; from other services only via `sshIsolation: "vpn service@<name>"` on the
  Swarm service — and SSH ignores leases.
- Errors: HTTP 400, read `meta[].metadata.reason` and `retryable`.

## Version tables

Regenerate with `scripts/sync-docs.sh` at the repository root. Everything between the markers is
machine-written.

<!-- BEGIN GENERATED: versions -->
<!-- Generated by scripts/sync-docs.sh from zeropsio/docs@71813fa2a7ed on 2026-10-30. Do not edit by hand. -->

### `base:` for `zerops.yaml`

Values for `build.base` and `run.base`.

### Runtimes — build and run

| Service type | Versions (newest first, aliases share a row) |
|---|---|
| Bun | `bun@1.3.9` / `bun@1.3` / `bun@latest`<br>`bun@1.2.2` / `bun@1.2`<br>`bun@nightly`<br>`bun@canary`<br>`bun@1.1.34` / `bun@1.1 (Ubuntu only)` |
| Deno | `deno@2.0.0` / `deno@2` / `deno@latest`<br>`deno@1.45.5` / `deno@1` |
| .NET | `dotnet@10` / `dotnet@latest`<br>`dotnet@9`<br>`dotnet@8`<br>`dotnet@7`<br>`dotnet@6` |
| Elixir | `elixir@1.16` / `elixir@1` / `elixir@latest` |
| Gleam | `gleam@1.5` / `gleam@1` / `gleam@latest` |
| Go | `go@1.22` / `go@1` / `golang@1` / `go@latest` / `golang@latest` |
| Java | `java@21` / `java@latest`<br>`java@17` |
| Node.js | `nodejs@24` / `nodejs@latest`<br>`nodejs@22`<br>`nodejs@20`<br>`nodejs@18` |
| Python | `python@3.14 (Ubuntu only)` / `python@latest`<br>`python@3.12`<br>`python@3.11` |
| Ruby | `alpine/ruby@4.0` / `ubuntu/ruby@4.0` / `alpine/ruby@latest` / `ubuntu/ruby@latest`<br>`alpine/ruby@3.4` / `ubuntu/ruby@3.4`<br>`alpine/ruby@3.3` / `ubuntu/ruby@3.3` |
| Rust | `rust@1` / `rust@latest` / `rust@stable`<br>`rust@1.86`<br>`rust@1.80`<br>`rust@1.78`<br>`rust@nightly` |

### PHP, static and containers — build vs run differ

| Service type | Versions (newest first, aliases share a row) |
|---|---|
| PHP (build) | `php@8.5` / `php@latest`<br>`php@8.4`<br>`php@8.3`<br>`php@8.1` |
| PHP + Apache (run) | `php-apache@8.5` / `php-apache@latest`<br>`php-apache@8.4`<br>`php-apache@8.3`<br>`php-apache@8.1` |
| PHP + nginx (run) | `php-nginx@8.5` / `php-nginx@latest`<br>`php-nginx@8.4`<br>`php-nginx@8.3`<br>`php-nginx@8.1` |
| nginx (run) | `nginx@1.22` / `nginx@latest` |
| static (run) | `static` / `static@1.0` / `static@latest` |
| Docker (run) | `docker@26.1` / `docker@latest` |
| Alpine | `alpine@3.23` / `alpine@latest`<br>`alpine@3.22`<br>`alpine@3.21`<br>`alpine@3.20`<br>`alpine@3.19`<br>`alpine@3.18`<br>`alpine@3.17` |
| Ubuntu | `ubuntu@26.04`<br>`ubuntu@24.04`<br>`ubuntu@22.04` / `ubuntu@latest` |

### `type:` for the import YAML

Managed services take a `:single` / `:ha` deployment variant where listed. The legacy `mode: NON_HA|HA` field is deprecated.

### Runtimes

| Service type | Versions (newest first, aliases share a row) |
|---|---|
| Bun | `bun@1.3.9` / `bun@1.3` / `bun@latest`<br>`bun@1.2.2` / `bun@1.2`<br>`bun@nightly`<br>`bun@canary`<br>`bun@1.1.34` / `bun@1.1 (Ubuntu only)` |
| Deno | `deno@2.0.0` / `deno@2` / `deno@latest`<br>`deno@1.45.5` / `deno@1` |
| .NET | `dotnet@10`<br>`dotnet@9`<br>`dotnet@8`<br>`dotnet@7`<br>`dotnet@6` |
| Elixir | `elixir@1` / `elixir@1.16` / `elixir@1.16.2` |
| Gleam | `gleam@1` / `gleam@1.5` / `gleam@1.5.1` |
| Go | `go@1.22` / `go@1` / `golang@1` / `golang@1.22` |
| Java | `java@21`<br>`java` / `java@17` / `java@latest` |
| Node.js | `nodejs@24`<br>`nodejs@22`<br>`nodejs@20`<br>`nodejs@18` |
| PHP + Apache | `php-apache@8.5+2.4` / `php-apache@8.5`<br>`php-apache@8.4+2.4` / `php-apache@8.4`<br>`php-apache@8.3+2.4` / `php-apache@8.3`<br>`php-apache@8.1+2.4` / `php-apache@8.1` |
| PHP + nginx | `php-nginx@8.5+1.28` / `php-nginx@8.5`<br>`php-nginx@8.4+1.22` / `php-nginx@8.4`<br>`php-nginx@8.3+1.22` / `php-nginx@8.3`<br>`php-nginx@8.1+1.22` / `php-nginx@8.1` |
| Python | `python@3.14 (Ubuntu only)`<br>`python@3.12`<br>`python@3.11` |
| Ruby | `alpine/ruby@4.0` / `ubuntu/ruby@4.0`<br>`alpine/ruby@3.4` / `ubuntu/ruby@3.4`<br>`alpine/ruby@3.3` / `ubuntu/ruby@3.3` |
| Rust | `rust@1.86` / `rust@1` / `rust@stable`<br>`rust@1.80`<br>`rust@1.78`<br>`rust@nightly` |

### Static, containers and VMs

| Service type | Versions (newest first, aliases share a row) |
|---|---|
| nginx | `nginx@1.22` / `nginx@latest` |
| static | `static` / `static@1.0` / `static@latest` |
| Alpine | `alpine@3.23`<br>`alpine@3.22`<br>`alpine@3.21`<br>`alpine@3.20`<br>`alpine@3.19`<br>`alpine@3.18`<br>`alpine@3.17` |
| Ubuntu | `ubuntu@26.04`<br>`ubuntu@24.04`<br>`ubuntu@22.04` |
| Docker | `docker@26.1.5` |
| Swarm | `swarm@1`<br>`swarm-vm@1` |
| Box Workspace | `zbox@1` / `zbox@latest` |

### Databases

| Database | Versions (newest first, aliases share a row) |
|---|---|
| PostgreSQL | `postgresql:single@18` / `postgresql:ha@18`<br>`postgresql:single@17` / `postgresql:ha@17`<br>`postgresql:single@16` / `postgresql:ha@16`<br>`postgresql:single@14` / `postgresql:ha@14` |
| MariaDB | `mariadb@10.6` |
| ClickHouse | `clickhouse@25.3` |
| Valkey | `valkey@7.2` |
| KeyDB (legacy) | `keydb@6` |
| Qdrant | `qdrant@1.12`<br>`qdrant@1.10` |

### Search engines

| Search engine | Versions (newest first, aliases share a row) |
|---|---|
| Elasticsearch | `elasticsearch@9.2`<br>`elasticsearch@8.16` |
| Meilisearch | `meilisearch@1.20`<br>`meilisearch@1.10` |
| Typesense | `typesense@27.1` |

### Message brokers

| Broker | Versions (newest first, aliases share a row) |
|---|---|
| Kafka | `kafka@3.9`<br>`kafka@3.8` |
| NATS | `nats@2.12`<br>`nats@2.10` |
| RabbitMQ | `rabbitmq@3.9` |

### Storage

| Storage | Versions (newest first, aliases share a row) |
|---|---|
| Object storage | `object-storage` |
| Local storage | `local-storage:single@1` |
| SeaweedFS | `seaweedfs:single@3.85` / `seaweedfs:ha@3.85` |

<!-- END GENERATED: versions -->
