# `zerops.yaml` reference

The build & run pipeline definition. Lives in the **root of the git repository**. Applied on every
build and deploy. Schema: `https://api.app-prg1.zerops.io/api/rest/public/settings/zerops-yml-json-schema.json`

## Contents

- [Structure](#structure)
- [`setup` and `extends`](#setup-and-extends)
- [`build`](#build)
- [`deploy`](#deploy)
- [`run`](#run)
- [Ports](#ports)
- [Start commands](#start-commands)
- [Health and readiness checks](#health-and-readiness-checks)
- [Cron](#cron)
- [`envReplace`](#envreplace)
- [`routing` (static services only)](#routing-static-services-only)
- [Working directories](#working-directories)
- [Gotchas](#gotchas)

## Structure

```yaml
zerops:
  - setup: app          # required — matches the service hostname
    build: {}           # optional
    deploy: {}          # optional
    run: {}             # required
```

Multiple setups in one file support monorepos — one entry per service. Which entry is used is
decided by, in order: `--setup` flag → `zeropsSetup` in import YAML → the service hostname.

## `setup` and `extends`

- **`setup`** *(string, required)* — hostname of an existing Zerops service.
- **`extends`** *(string | list, optional)* — inherit from another `setup` in the same file.
  Merging is **per section** (`build`, `run`, `deploy`); a redefined section overrides the parent's.
  With multiple parents (`extends: [base, logging]`) later parents win.

```yaml
zerops:
  - setup: base
    build: { buildCommands: [npm run build], deployFiles: ./dist }
    run: { start: npm start }
  - setup: prod
    extends: base
    run: { envVariables: { NODE_ENV: production } }
```

## `build`

| Key | Type | Notes |
|---|---|---|
| `base` | string \| list | **Required.** Build technology, e.g. `nodejs@22`. A list installs several. |
| `os` | enum | `alpine` (default) or `ubuntu`. |
| `prepareCommands` | list | Install extra tooling into the build image. Cached; runs in `/home/zerops`. |
| `buildCommands` | list | Compile/bundle. Runs in `/build/source`. |
| `deployFiles` | string \| list | **Required.** What lands in `/var/www` at runtime. |
| `cache` | string \| list \| bool | Paths preserved between builds, relative to `/build/source`. |
| `addToRunPrepare` | list | Files copied from build into the runtime-prepare container. |
| `envVariables` | map | Build-time variables only. |

**Each list item is its own shell.** Use a `|` block scalar when commands must share cwd or env:

```yaml
buildCommands:
  - |
    export TAG=$(git rev-parse --short HEAD)
    npm run build -- --tag "$TAG"
```

### `deployFiles`

Paths are preserved: `./src/assets/fonts` → `/var/www/src/assets/fonts`.

- `~` is a wildcard for one or more path segments: `./path/~/to/file.txt`.
- `~` prefixed to a segment flattens the path: `./src/assets/~fonts` → `/var/www/fonts`.
- A `.deployignore` file in the repo root excludes paths, using `.gitignore` pattern syntax
  (leading `/` anchors to root; without it the pattern matches at any depth). It also applies to
  `zcli service deploy`.

### `cache`

- `cache: node_modules` or `cache: [node_modules, .next]` — path-specific, recommended.
- `cache: true` — preserves the whole build container state (needed when the package manager
  installs outside `/build/source`: Go modules, pip, Maven `.m2`, NuGet).
- `cache: false` — only disables caching *within* `/build/source`; global caches persist anyway.

Restore is **no-clobber — repository files win** over cached files of the same path.

Changing `build.os`, `build.base`, `build.prepareCommands` or `build.cache` invalidates **both**
cache layers (base + build). See `pipeline.md`.

## `deploy`

| Key | Type | Default | Notes |
|---|---|---|---|
| `temporaryShutdown` | bool | `false` | `false` = new containers start before old are removed (zero downtime). `true` = old stop first (downtime); use only when two versions cannot coexist. |
| `readinessCheck` | object | — | Gates traffic to a new container during deploy. See below. |

## `run`

| Key | Type | Notes |
|---|---|---|
| `base` | string | Runtime technology. If omitted, the current version is kept. |
| `os` | enum | `alpine` (default) or `ubuntu`. Must be compatible with `base`. |
| `ports` | list | Internal ports the app listens on. |
| `prepareCommands` | list | Builds a **custom runtime image**. Cached; runs in `/home/zerops`. Deploy files are NOT available here. |
| `initCommands` | list | Runs on **every** container start/restart, in `/var/www`, before `start`. Deploy-gating. |
| `start` | string | The foreground process. Required unless `startCommands` is used. |
| `startCommands` | list | Multiple named parallel processes. Mutually exclusive with `start`. |
| `envVariables` | map | Runtime variables; baked into the app version (change ⇒ redeploy). |
| `envReplace` | object | Placeholder substitution inside deployed files. |
| `healthCheck` | object | Continuous liveness monitoring. |
| `crontab` | list | Scheduled commands inside the container. |
| `documentRoot` | string | Web root — webserver runtimes only (`php-apache`, `php-nginx`, `nginx`). |
| `siteConfigPath` | string | Custom webserver config — webserver runtimes only. |
| `routing` | object | Redirects/headers/CORS — **static services only**. |

### `initCommands` vs `prepareCommands`

| | `run.initCommands` | `run.prepareCommands` |
|---|---|---|
| When | Every container start/restart/scale | Only when the runtime image is (re)built |
| Cached | Never | Yes |
| Deploy files present | Yes (`/var/www`) | **No** |
| Use for | Migrations, cache warming, cleanup | OS packages, system libraries |

A non-zero exit from `initCommands` aborts the deploy: the appVersion goes to `DEPLOY_FAILED`,
is never activated, and the previous version keeps serving. The *service* status still reads
`ACTIVE` — diagnose via `appVersion.status` and a null `activationDate`, not service status.

Do not put application code in the runtime-prepare image; deploy files arrive separately.
Shared-storage mounts are not available during the prepare phase.

## Ports

```yaml
run:
  ports:
    - port: 3000
      protocol: TCP      # TCP (default) | UDP
      httpSupport: true  # true if a web server listens here; TCP only
```

- `port` must be **10–65435**; outside that range is reserved by Zerops.
- `httpSupport: true` is what makes public subdomain/domain routing possible for that port.
- Each HTTP port gets its own `.zerops.app` subdomain when subdomain access is enabled.

## Start commands

Single process:

```yaml
run:
  start: node dist/server.js
```

Multiple parallel processes — **do not combine with `start`**:

```yaml
run:
  startCommands:
    - command: npm run start:prod
      name: server
    - command: litestream replicate -config=litestream.yaml
      name: replication
      workingDir: /var/www
      initCommands:
        - litestream restore -if-replica-exists -if-db-not-exists -config=litestream.yaml $DB_NAME
```

Only `command` is required per entry; `name` labels the process in logs.

For a service with no natural foreground process (a container you only SSH into, or a worker
started elsewhere), use `start: zsc noop --silent` to keep the container alive.

## Health and readiness checks

Two different mechanisms, routinely confused.

| | `deploy.readinessCheck` | `run.healthCheck` |
|---|---|---|
| Runs | **Only during a deploy** | **Continuously while live** |
| Purpose | Gate traffic to the new container | Pull a degraded container from the balancer |
| On failure | Deploy fails, old version keeps serving | Container disconnected → restarted → reconnected on recovery |

Both accept `httpGet` **or** `exec` — never both in the same block.

```yaml
deploy:
  readinessCheck:
    httpGet: { port: 3000, path: /health }
    failureTimeout: 60   # seconds until the container is marked failed
    retryPeriod: 10      # seconds between attempts

run:
  healthCheck:
    httpGet: { port: 3000, path: /health, host: my-host.zerops, scheme: https }
    failureTimeout: 30     # consecutive-failure seconds before restart (reset by success)
    disconnectTimeout: 30  # seconds before removal from the load balancer
    recoveryTimeout: 30    # seconds of success before traffic returns
    execPeriod: 10         # seconds between attempts
```

- **`httpGet`** — GET to `localhost:{port}{path}` from inside the container. Success = HTTP `2xx`
  (follows `3xx`). 5-second per-request timeout. `host` sets a Host header; `scheme: https` only if
  the app itself demands TLS internally (default plain HTTP — the balancer terminates SSL upstream).
- **`exec`** — `command` string, success = exit `0`, 5-second timeout, full env access. Use a `|`
  block for multiple steps.

```yaml
run:
  healthCheck:
    exec:
      command: |
        curl -sf http://localhost:8080/status > /tmp/status
        grep -q "OK" /tmp/status
```

Readiness retries for up to 5 minutes; then the container is deleted, recreated, and the deploy
retried. Set `failureTimeout`/`retryPeriod` explicitly — do not rely on schema defaults.

Production services should use **both**. Dev services driven interactively should use neither
(a health check restarts the container mid-iteration).

## Cron

```yaml
run:
  crontab:
    - command: "php artisan schedule:run"
      timing: "* * * * *"
      allContainers: false
      workingDir: /var/www/html
```

- `command` — required, any shell command; full env var access.
- `timing` — required, standard 5-field cron (`min hour dom mon dow`). Minimum granularity 1 minute.
- `allContainers` — `false` runs on one container (correct for DB jobs), `true` on all
  (cache clearing, log rotation).
- `workingDir` — defaults to `/var/www`.

`zsc crontab list` / `zsc crontab run` inspect and trigger these from inside a container.

## `envReplace`

Substitutes placeholders inside **deployed files at deploy time** (not at runtime).

```yaml
run:
  envReplace:
    delimiter: "%%"           # string or list; "%%" means %%VAR_NAME%%
    target:
      - ./config/
      - ./templates/settings.json
```

A file containing `%%JWT_PUBLIC_KEY%%` gets the env var's value written in. Useful for PEM keys and
config files that cannot read env vars.

**Directory targets do not recurse.** `./config/` processes only files directly in `config/`, not
`config/jwt/`. List each subdirectory explicitly.

## `routing` (static services only)

```yaml
run:
  routing:
    root: /custom/root
    cors: "'*' always"
    redirects:
      - from: /old-page
        to: /new-page
        status: 301
      - from: /blog/*
        to: /articles/
        preservePath: true
        preserveQuery: true
        status: 302
    headers:
      - for: "/*"
        values:
          X-Frame-Options: "'DENY'"
          Content-Security-Policy: '"default-src ''self''"'
```

- `cors` sets `Access-Control-Allow-Origin/Methods/Headers/Expose-Headers`; `"*"` is converted to `'*'`.
- `redirects[]`: `from` (required, `*` wildcard), `to` (required), `status` (required for absolute
  URLs), `preservePath`, `preserveQuery`.
- `headers[]`: `for` (path pattern, required), `values` (map, required).

Silently ignored on non-static services.

## Working directories

| Phase | cwd |
|---|---|
| `build.prepareCommands` | `/home/zerops` |
| `build.buildCommands` | `/build/source` |
| `run.prepareCommands` | `/home/zerops` |
| `run.initCommands` | `/var/www` |
| `run.crontab` | `/var/www` unless `workingDir` is set |
| Deployed files land in | `/var/www` |
| Build cache stored at | `/build/cache` |

## Gotchas

1. `run` is required; `build` and `deploy` are optional (a service can be deploy-only).
2. There is **no `mount` key in `zerops.yaml`** — shared storage is attached via the `mount:` field
   in the *import* YAML or in the GUI. A `run.mount` is silently ignored.
3. `envVariables` under `run` are baked into the app version — changing them needs a **redeploy**,
   not a restart. Secrets (import YAML / GUI) need only a restart.
4. A key declared in `run.envVariables` cannot also exist as a secret — the platform rejects the
   secret with `userDataDuplicateKey`. The YAML owns the key.
5. PHP uses different build and run bases: build `php@8.4`, run `php-nginx@8.4` or `php-apache@8.4`.
6. Deno has no Alpine build — it requires `os: ubuntu`.
7. Static sites typically build on `nodejs@latest` and run on `static`.
