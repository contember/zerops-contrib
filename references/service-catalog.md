# Service catalog

Which service types exist, which version string to write where, and what each one hands you as
environment variables.

## Contents

- [Two different version strings](#two-different-version-strings)
- [Choosing a service](#choosing-a-service)
- [HA variants and profiles](#ha-variants-and-profiles)
- [Generated environment variables](#generated-environment-variables)
  - [PostgreSQL](#postgresql) · [MariaDB](#mariadb) · [Valkey](#valkey) · [KeyDB](#keydb-legacy)
  - [Object storage](#object-storage) · [Search engines](#search-engines)
  - [Administering a database](#administering-a-database) · [Platform variables](#platform-variables)
- [Version tables](#version-tables)

## Two different version strings

- **`type:` in import YAML** — provisions the service. Includes the deployment variant:
  `postgresql:ha@18`, `shared-storage:single`, `php-nginx@8.4`.
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
| Files that outlive a deploy | Object storage (S3/MinIO) | Container disk is replaced on deploy. Not covered by Zerops backups |
| Shared POSIX filesystem | Shared storage | Mounted at `/mnt/<hostname>` across containers |
| Static site | `static` | Build on `nodejs@latest`, run on `static` |
| Reverse proxy / custom webserver | `nginx` | |
| Pre-built container image | `docker` | Runs in a **VM**; no autoscaling; needs `--network=host` |
| Plain Linux box | `alpine` / `ubuntu` | Full autoscaling, same as runtimes |

### Runtime base OS

Default to **Alpine**. Switch to Ubuntu only for glibc needs: CGO-enabled Go, glibc-built Python
C-extension wheels, or **Deno** (no Alpine build exists). Needing a package is *not* a reason —
both install packages (`sudo apk add` / `sudo apt-get install`).

**A bare version string is expanded to an OS-qualified one, and build and run need not agree.**
Verified live: `type: bun@1.3.9` produced a service reporting
`serviceStackTypeVersionName: ubuntu/bun@1.3.9`, while the same string as `base:` resolved the build
to `alpine/bun@1.3.9` (visible as the appVersion's `base`). Two consequences:

- Anything comparing a declared `type` against the live one must treat a declaration with no OS
  prefix as matching any prefix, or it reports drift on a service it just created from that file.
- If your app cares which libc it runs on, name the OS explicitly on both sides rather than assuming
  one bare string gives you one distribution.

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
| PostgreSQL, MariaDB, ClickHouse, Valkey, shared storage, SeaweedFS | `:single` / `:ha` type variant |
| Elasticsearch, Typesense, Kafka | `mode: HA` — **not** deprecated here, no variant exists |
| Meilisearch, Qdrant, object storage | single node only |

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

## Version tables

Regenerate with `scripts/sync-docs.sh`. Everything between the markers is machine-written.

<!-- BEGIN GENERATED: versions -->
<!-- Generated by scripts/sync-docs.sh from zeropsio/docs@d65d24945926 on 2026-07-31. Do not edit by hand. -->

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
| Ubuntu | `ubuntu@24.04`<br>`ubuntu@22.04` / `ubuntu@latest` |

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
| Ubuntu | `ubuntu@24.04`<br>`ubuntu@22.04` |
| Docker | `docker@26.1.5` |

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
| Shared storage | `shared-storage:single` / `shared-storage:ha` |
| SeaweedFS | `seaweedfs:single@3` / `seaweedfs:ha@3` |

<!-- END GENERATED: versions -->
