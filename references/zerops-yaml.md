# `zerops.yaml` reference

The build & run pipeline definition. Lives in the **root of the git repository**. Applied on every
build and deploy. Schema: `https://api.app-prg1.zerops.io/api/rest/public/settings/zerops-yml-json-schema.json`

## Contents

- [Structure](#structure)
- [Two runtime shapes](#two-runtime-shapes)
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
- [PHP runtime tuning](#php-runtime-tuning)
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

**One push deploys one setup.** `zcli push` targets a single service, so a monorepo needs one push
per service:

```sh
zcli push -S <api-service-id> --setup api
zcli push -S <worker-service-id> --setup worker
```

## Two runtime shapes

Which keys are legal in `run` depends on the service type. Getting this wrong blocks the deploy.

| | Process runtimes | Webserver runtimes |
|---|---|---|
| Types | `nodejs`, `bun`, `deno`, `go`, `python`, `rust`, `java`, `dotnet`, `elixir`, `gleam`, `alpine`, `ubuntu` | `php-apache`, `php-nginx`, `nginx`, `static` |
| `start` / `startCommands` | **Required** — you launch the process | **Do not set** — the platform starts the server |
| `ports` | **Required** to be reachable | **Do not set** — the HTTP port is implicit |
| Specific keys | — | `documentRoot`, `siteConfigPath`, `routing` (static only) |

A webserver runtime with subdomain access enabled gets its subdomain automatically; there is no
port to declare. A minimal static service is:

```yaml
zerops:
  - setup: web
    build:
      base: nodejs@22
      buildCommands: [npm ci, npm run build]
      deployFiles: dist/~        # note the ~ — see deployFiles below
    run:
      base: static
```

And a PHP service:

```yaml
zerops:
  - setup: app
    build:
      base: php@8.4             # build base differs from run base
      buildCommands: [composer install --no-dev]
      deployFiles: [vendor, public, src, composer.json]
      cache: [vendor, composer.lock]
    run:
      base: php-nginx@8.4
      documentRoot: public      # relative to /var/www — not an absolute path
```

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

**A `: ` inside an unquoted command makes YAML read the item as a mapping**, and validation then
reports `cannot unmarshal !!map into string` — against a line number in the API's *reserialized*
document, which does not match your file:

```yaml
buildCommands:
  - echo "PROBE: starting"      # WRONG — parsed as a mapping
  - 'echo "PROBE: starting"'    # right
```

The same applies to any command containing `: ` — `git commit -m "x: y"`, `sed 's/a: b/…/'`. Quote
the whole scalar, or use a `|` block.

### `deployFiles`

**This is the entire runtime filesystem, not a list of build artifacts.** The runtime container
runs no install step. Whatever the app needs at runtime must either be listed here or bundled into
the build output:

| Runtime | Typical `deployFiles` |
|---|---|
| Node.js / Bun | `[dist, package.json, node_modules]` — drop `node_modules` only if the bundler inlines dependencies |
| PHP | `[vendor, public, src, composer.json]` |
| Python | the app plus its virtualenv, or install into the runtime image via `run.prepareCommands` |
| Go / Rust | just the compiled binary |
| Static | `dist/~` |

Paths are preserved: `./src/assets/fonts` → `/var/www/src/assets/fonts`.

- `~` is a wildcard for one or more path segments: `./path/~/to/file.txt`.
- `~` prefixed to a segment flattens the path: `./src/assets/~fonts` → `/var/www/fonts`.
- **`dist/~` deploys the *contents* of `dist/` to `/var/www`.** This is what static and webserver
  services need — plain `deployFiles: ./dist` puts the site at `/var/www/dist` and every route 404s.

#### `.deployignore`

A `.deployignore` file in the repo root excludes paths, using `.gitignore` pattern syntax (leading
`/` anchors to root; without it the pattern matches at any depth). It also applies to
`zcli service deploy`.

**Do not mirror `.gitignore` into it blindly — this contradicts upstream, deliberately.** Every
per-language build-pipeline page says *"For consistency, it's recommended to configure both your
`.gitignore` and `.deployignore` files with the same patterns."* Followed literally that advice
breaks unbundled apps: `.gitignore` excludes `node_modules` and `vendor` — exactly the directories
`deployFiles` must ship, because nothing reinstalls dependencies at runtime. The app deploys
cleanly, then dies on a missing module with nothing in the build log.

The two files answer different questions — *what does not belong in version control* vs *what does
not belong in the runtime filesystem* — and only overlap by accident. If you do keep them similar,
re-add the dependency directories in `.deployignore` with a `!` negation, or list them explicitly,
and verify they arrived (`ls /var/www` over SSH or the web terminal).

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
| `documentRoot` | string | Web root, **relative to `/var/www`** — write `public`, not `/var/www/public`. Webserver runtimes only. |
| `siteConfigPath` | string | Custom webserver config, path relative to `/var/www`; the file must be in `deployFiles`. Webserver runtimes only. |
| `routing` | object | Redirects/headers/CORS — **static services only**. |

### `initCommands` vs `prepareCommands`

| | `run.initCommands` | `run.prepareCommands` |
|---|---|---|
| When | Every container start/restart/scale | Only when the runtime image is (re)built |
| Cached | Never | Yes |
| Deploy files present | Yes (`/var/www`) | **No** |
| Use for | Migrations (see below), cache warming, cleanup | OS packages, system libraries |

**`initCommands` run on every container, in parallel.** Containers deploy simultaneously, so a bare
migration command races across replicas. Gate anything that must happen once per version:

```yaml
run:
  initCommands:
    - zsc execOnce ${ZEROPS_appVersionId} -- npm run db:migrate
```

`zsc execOnce <key> -- <cmd>` runs the command on exactly one container of the service and makes the
others wait for its result. See `cli.md`.

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
    failureTimeout: 60s   # until the container is marked failed
    retryPeriod: 10s      # between attempts

run:
  healthCheck:
    httpGet: { port: 3000, path: /health, host: my-host.zerops, scheme: https }
    failureTimeout: 30s     # consecutive-failure time before restart (reset by success)
    disconnectTimeout: 30s  # before removal from the load balancer
    recoveryTimeout: 30s    # of success before traffic returns
    execPeriod: 10s         # between attempts
```

**Every timeout here is a Go duration and must carry a unit.** A bare integer is
rejected by validation — `cannot unmarshal !!int \`60\` into time.Duration` —
and `zz validate -S <svc> --verbose` is the only place that message is visible.
Verified live on `bun@1.3.9`.

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

When readiness never passes: after `failureTimeout` the container is deleted and **the deploy
fails** — the previously active appVersion keeps serving. (The older `features/pipeline` page
describes a recreate-and-retry loop instead; the newer guide is authoritative and is what this
skill follows.) Set `failureTimeout`/`retryPeriod` explicitly — do not rely on schema defaults.

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

- `command` — **required**, any shell command; full env var access.
- `timing` — **required**, standard 5-field cron (`min hour dom mon dow`). Minimum granularity 1 minute.
- `allContainers` — **required by the schema.** `false` runs on one container (correct for DB jobs),
  `true` on all (cache clearing, log rotation).
- `workingDir` — optional, defaults to `/var/www`.

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

**SPA routing needs no configuration.** A static service already falls back through `$uri` →
`$uri.html` → `$uri/index.html` → `/index.html` → 404, and upstream states plainly that SPAs work
out of the box and *"you don't need to add any custom redirects for client-side routing to work."*

A catch-all `/*` → `/index.html` **redirect** is therefore at best redundant. It is also risky:
`redirects` emit an HTTP 3xx rather than serving the fallback internally, so a rule broad enough to
match every path also matches `/assets/app.js`. Upstream does not document this failure mode — but
the fallback above already does the job, so there is no reason to find out. Use `routing` only for
genuine redirects, headers and CORS.

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

## PHP runtime tuning

`php-nginx` / `php-apache` are configured with environment variables, not an ini file you ship:
`PHP_INI_<directive>` for php.ini, `PHP_FPM_<setting>` for the FPM pool. Set them in
`run.envVariables`.

```yaml
run:
  base: php-nginx@8.4
  envVariables:
    PHP_INI_upload_max_filesize: 10M
    PHP_INI_post_max_size: 12M
    PHP_INI_memory_limit: 256M
    PHP_INI_max_execution_time: 60
    PHP_FPM_PM_MAX_CHILDREN: 50
    PHP_FPM_PM_START_SERVERS: 10
```

Zerops overrides several stock defaults: `upload_max_filesize` and `post_max_size` **1024M** (vs 2M
/ 8M), `display_errors` off, `log_errors` on, `error_reporting` 22527, `output_buffering` 4096,
`date.timezone` UTC, `sendmail_path` wired to the system sendmail.

FPM defaults to `dynamic` with `MAX_CHILDREN` 20, `START_SERVERS` 2, `MIN_SPARE_SERVERS` 1,
`MAX_SPARE_SERVERS` 3, `MAX_SPAWN_RATE` 32, `MAX_REQUESTS` 500. `PHP_FPM_PM: ondemand` spawns
workers only on demand (`PHP_FPM_PM_PROCESS_IDLE_TIMEOUT`, default `60s`) and suits low-traffic
sites. Config is written to `/etc/php*/php-fpm.d/www.conf` at container start.

**Applying a change depends on where the value lives** — see
[`env-variables.md`](env-variables.md#when-changes-take-effect). A value in `run.envVariables` is
baked into the app version, so it needs a **redeploy**; a value set as a service secret or in the GUI
needs a **restart**. A reload rewrites the config files but never signals FPM to re-read them, so
reload alone applies nothing.

### Uploads pass three limits

All three must allow the size, and PHP is usually not the one blocking:

1. **L7 balancer** — `client_max_body_size`: **50 MB fixed on a `.zerops.app` subdomain** (not
   configurable), 512 MB default on a custom domain, adjustable to 2048 MB.
2. `upload_max_filesize` — 1024M by default.
3. `post_max_size` — 1024M by default. **Must be ≥ `upload_max_filesize`**, or PHP silently drops
   the POST body even when the file itself is under the upload limit.

### Extensions

Build and runtime are separate containers with separate images. The build base (`php@X`) is
Alpine-minimal; the runtime bases bundle more, but not everything. Install with a version prefix
matching PHP major+minor, under `sudo` (containers run as the `zerops` user):

```yaml
build:
  base: php@8.4
  prepareCommands:
    - sudo apk add --no-cache php84-pcntl php84-posix
run:
  base: php-nginx@8.4
  prepareCommands:
    - sudo apk add --no-cache php84-pcntl php84-posix
```

Install in `build.prepareCommands` so Composer validates platform requirements properly, and again in
`run.prepareCommands` if the extension is also needed at runtime. **Never reach for
`--ignore-platform-reqs`** — it suppresses every platform check and turns a build error into a
runtime crash. Commonly missing from the build base: `ext-pcntl`, `ext-posix` (Laravel Horizon),
`ext-gd`, `ext-intl`.

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
   in the *import* YAML, in the GUI, or with `zsc shared-storage mount`. Upstream documents `mount:`
   only for the import YAML and never lists it under `run`. **Verified live: a stray `run.mount`
   (even pointing at a nonexistent storage) is silently accepted — the deploy goes `ACTIVE`, no
   mount, no warning.** More broadly, **unknown keys under `run` are not rejected** (a bogus
   `thisKeyDoesNotExist: true` also deploys clean), so a typo'd key never announces itself. Rely on
   schema validation in the editor, not on the deploy to catch it.
3. PHP uses different build and run bases: build `php@8.4`, run `php-nginx@8.4` or `php-apache@8.4`.
4. Deno has no Alpine build — it requires `os: ubuntu`.

Variable timing (`run.envVariables` ⇒ redeploy, secrets ⇒ restart) and the
`userDataDuplicateKey` collision are in [`env-variables.md`](env-variables.md#when-changes-take-effect).
