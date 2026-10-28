# CLI reference — `zcli` and `zsc`

Three tools, three places:

- **`zcli`** — runs on **your machine or CI**. Talks to the Zerops API: login, VPN, projects,
  services, push/deploy, logs.
- **`zsc`** — preinstalled **inside every Zerops container** (build and runtime). Controls the
  container itself: scaling, installing bases, backups, cron, secrets.
- **`zcp`** — an MCP server scoped to **one project**, for coding agents. Covers most of what
  `zcli` cannot do (restart, scaling, env writes, events, verification). See
  [`zcp-mcp.md`](zcp-mcp.md).
- **`zops`** — a from-scratch CLI **shipped with this plugin**, generated from the API's OpenAPI
  document, so all 247 documented operations are reachable, plus the 17 undocumented `/search`
  endpoints `zcli` uses internally. Designed for agents: `--json` everywhere, meaningful exit
  codes, name-based addressing, waits for async operations. Run it as
  `"$CLAUDE_PLUGIN_ROOT/bin/zops"`; nothing needs installing beyond Bun. See
  [`zops-cli.md`](zops-cli.md).

All four authenticate with the same personal access token. Only `zops` has a raw REST passthrough
(`zops api`).

## Contents

- [`zcli` install and auth](#zcli-install-and-auth)
- [`zcli` configuration](#zcli-configuration)
- [`zcli` commands](#zcli-commands)
- [What `zcli` cannot do](#what-zcli-cannot-do)
- [Roles and tokens](#roles-and-tokens)
- [`zsc` commands](#zsc-commands)

## `zcli` install and auth

```sh
npm i -g @zerops/zcli
# or
curl -L https://zerops.io/zcli/install.sh | sh
```

```sh
zcli login <access-token>     # token from GUI → Settings → Access Token Management
zcli logout                   # also disconnects the VPN
zcli version
zcli upgrade                  # self-update; see below
```

Scoping avoids repeating `--project-id`/`--service-id`:

```sh
zcli scope project [project-id]
zcli scope reset
```

## `zcli` configuration

Precedence, lowest to highest: **config file → environment variable → command-line flag**.

Config files (global first, then project-specific which overrides duplicate keys):

1. `~/.config/zerops/zcli.yaml` or `~/zerops/zcli.yaml`
2. `./.zcli.yaml` in the repository root

```yaml
# ./.zcli.yaml
projectId: "your-project-id"
serviceId: "your-service-id"
workspaceState: "clean"
```

Any flag can be set as an environment variable: `ZEROPS_` + the uppercased **full** flag name
(not the shorthand).

```sh
export ZEROPS_PROJECTID=...
export ZEROPS_WORKSPACESTATE=clean
```

Special variables:

- `ZEROPS_CLI_TERMINAL_MODE` — `auto` (default) / `enabled` / `disabled`. Set `disabled` in CI.
- `ZEROPS_CLI_LOG_FILE_PATH` — custom debug log location. Default `/var/log/zcli.log`, falling back
  to `~/.config/zerops/zerops.log`. Written by `push` and `deploy`; add `-v/--verbose` for detail.

**`ZEROPS_TOKEN` in the environment silently overrides `zcli login`.** Because any flag can be set
via a `ZEROPS_`-prefixed env var, an exported `ZEROPS_TOKEN` (e.g. sourced from a `.env`) wins over
whatever account you logged in as — every command then runs as that token regardless. Verified live:
it surfaces as a spurious `insufficientPermissions` against a project the *logged-in* account can
reach but the env token cannot. When switching accounts or projects, `unset ZEROPS_TOKEN` (or don't
export it) so `zcli login` actually takes effect.

## `zcli` commands

### Account and VPN

| Command | Purpose |
|---|---|
| `zcli login <token>` | Authenticate |
| `zcli logout` | Disconnect VPN and log out |
| `zcli vpn up [project-id]` | Connect. `--auto-disconnect`, `--mtu int` (default 1420), `-P/--project-id`, `--skip-check-installation`, `--skip-dns-setup` (then use IPs, not hostnames), `--skip-vpn-test` |
| `zcli vpn down` | Disconnect |

### Projects

| Command | Notes |
|---|---|
| `zcli project list` | |
| `zcli project create` | `--name`, `--org-id`, `--mode light\|serious` (default `light`), `--tags`, `--env-isolation service\|none`, `--ssh-isolation` (default `vpn`), `--location` (primary/fallback location, e.g. `eu-central`), `--out` (Go template) |
| `zcli project delete [project-id]` | `--confirm` skips the prompt |
| `zcli project env` | Print project env vars. `--export` prefixes `export`, `--template`, `--service`, `--user-only` |
| `zcli project project-import <file>` | Create project + services from import YAML. `--org-id`, `--working-dir` |
| `zcli project service-import <file>` | Add services to an existing project. `-P/--project-id` |

### Services

| Command | Notes |
|---|---|
| `zcli service list` | |
| `zcli service create` | `--name`, `--mode ha\|non_ha` (default `non_ha`), `--env` / `--env-file` (**both set secrets**, max 1 MiB), `--env-isolation`, `--ssh-isolation`, `--start-without-code`, `--noop` (create only if absent), `--working-dir`, `--zerops-yaml-path`, `--out` (Go template) |
| `zcli service push [service]` | **Build in Zerops and deploy.** The usual way to ship. Alias: `zcli push` |
| `zcli service deploy [service]` | Deploy pre-built artifacts, skipping the build phase |
| `zcli service start\|stop [service]` | **There is no `zcli service restart`.** Restart = `stop` then `start`, or the GUI's Restart action |
| `zcli service delete [service]` | `--confirm` |
| `zcli service enable-subdomain [service]` | |
| `zcli service log` | See below |

**There is no `zcli backup` command.** `features/backup.mdx` documents `zcli backup create <service>
--tags …` and tells you to run `zcli backup --help`; neither exists in **v1.1.0**, the current
release (verified against `zcli --help`, `zcli service --help` and `zcli project --help`). For a
headless backup use `zsc backup-create <stackName>` from inside a container — which takes **no
`--tags` flag**, so a *protected* tag cannot be set headlessly at all. See
[backups](operations.md#backups).

`zcli push` and the other service commands accept a service **name** as a positional argument, not
only an ID.

**One push deploys one setup.** In a monorepo, run it once per service with the matching
`--setup`.

#### `push` / `deploy` flags

The two commands do **not** share a flag set — verified against `--help` in v1.1.0.

| Flag | `push` | `deploy` | Meaning |
|---|---|---|---|
| `-P, --project-id` | ✓ | ✓ | Required with access to several projects |
| `-S, --service-id` | ✓ | ✓ | Required with access to several services |
| `--setup <name>` | ✓ | ✓ | Which `setup:` from `zerops.yaml` to use |
| `--version-name <s>` | ✓ | ✓ | Custom version label; auto-filled from `ZEROPS_VERSIONNAME` |
| `--working-dir <p>` | ✓ | ✓ | Default `./` |
| `--zerops-yaml-path <p>` | ✓ | ✓ | Non-default config path |
| `-g, --deploy-git-folder` | ✓ | ✓ | Include `.git/` |
| `--archive-file-path <p>` | ✓ | ✓ | Also write a `tar.gz` of the uploaded code |
| `-v, --verbose` | ✓ | ✓ | Extra debug into the log file |
| `-w, --workspace-state` | ✓ | — | `all` (default) / `clean` (HEAD without local changes) / `staged` |
| `--no-git` | ✓ | — | Upload the working directory as-is. Incompatible with `--workspace-state` and `--deploy-git-folder` |
| `--disable-logs` | ✓ | — | Do not stream build logs |
| `--path-to-file-or-dir <p>` | — | ✓ | **What to deploy.** Repeatable, default `.` |

`--path-to-file-or-dir` is the flag that makes `deploy` useful: it takes the pre-built artifacts
directly, so `deployFiles` in `zerops.yaml` is not what selects them.

`.deployignore` applies to both commands.

#### `zcli service log`

```sh
zcli service log -S <service-id>                     # runtime logs
zcli service log -S <service-id> --show-build-logs   # build logs
zcli service log -S <service-id> --follow
```

`--limit` 1–1000 (default 100), `--format FULL|SHORT|JSON|JSONSTREAM`, `--format-template`,
`--minimum-severity`, `--message-type APPLICATION|WEBSERVER`.

### Utility

`zcli env` (global env vars and paths) · `zcli show-debug-logs` · `zcli support` ·
`zcli completion {bash|fish|powershell|zsh}`

### `zcli upgrade`

Available from **v1.1.0**. Downloads the release asset, verifies it against `checksums.txt`, swaps
the binary atomically.

Flags: `--check`, `--yes`, `--version <tag>`, `--pick-version`, `--include-pre-release`,
`--no-cache`, `--download-timeout <duration>`.

`--check` exit codes: `0` up to date · `1` newer release available · `2` lookup failed ·
`3` target predates v1.1.0 (use the install script).

Package-manager installs refuse to self-swap and print the right command (`npm install -g
@zerops/zcli`, `brew upgrade zcli`, …). Downgrades below v1.1.0 need:

```sh
curl -fsSL https://raw.githubusercontent.com/zeropsio/zcli/main/install.sh | sh -s -- v1.0.67
```

## What `zcli` cannot do

A large part of day-2 management has no `zcli` command. Do not invent one — reach for `zops`
([`zops-cli.md`](zops-cli.md)), `zcp`, the GUI, or the REST API instead.

| Task | `zops` | Other surfaces |
|---|---|---|
| Restart a service | `zops service restart` | `zcp` `zerops_manage`, GUI (Restart), or `zcli service stop` + `start` |
| Reload a service | `zops service reload` | `zcp` `zerops_manage`, or GUI. Note a reload does **not** re-read environment variables |
| Change scaling / CPU mode / container count | `zops scale set` | `zcp` `zerops_scale`, GUI → **Automatic scaling configuration**, or REST |
| Set or read env vars beyond `zcli project env` | `zops env set` / `zops env show` | `zcp` `zerops_env`, GUI, or REST `/user-data`, `/project-env` |
| Read service events, deploy history | `zops process list`, `zops version list` | `zcp` `zerops_events`, GUI, or REST |
| Health / HTTP readiness probe | — | `zcp` `zerops_verify` |
| Export a project or service as YAML | `zops project export`, `zops service export` | `zcp` `zerops_export`, or GUI three-dot menu |
| Roll back (activate an archived app version) | `zops version rollback` | GUI → *Pipelines & CI/CD settings*, or REST `/app-version` |
| Read appVersion status, build/deploy state | `zops version list/get` | GUI, or REST `/app-version` |
| Configure domains, ports, firewall rules | `zops route http/port` | GUI, or REST `/public-http-routing`, `/public-port-routing` |
| Backups — create, list, tag, retention, download | `zops backup …` | GUI → **Backups List & Configuration**, or REST. `zsc backup-create <stackName>` creates one from inside a container, untagged |
| L7 balancer configuration | `zops project balancer get/set` | GUI → **Advanced balancer configuration** |
| Build on push from GitHub/GitLab | `zops repo connect` | GUI → *Pipelines & CI/CD settings*. Needs an OAuth grant made in the GUI first |
| Create one service without an import YAML | `zops service create` | GUI → **Add service**, or REST `/service-stack` |
| Object-storage CDN — enable, disable, purge | `zops cdn storage …` | GUI → the bucket's CDN panel |
| Access tokens — create, rotate, revoke | `zops token …` | GUI → Settings → **Access Token Management** |
| Upgrade the project core to HA | `zops project mode SERIOUS` | GUI → project settings. One-way |
| Dedicated / shared public IPv4 | `zops project ipv4 request\|release\|shared` | GUI → project **Add-ons** |
| Start a stopped project (e.g. after Zerops stopped it for lack of credit) | `zops project start` | GUI → **Start project**, or REST `PUT /project/{id}/start`. Does not bring the dedicated IPv4 back |
| Remote log forwarding, Prometheus scrape targets | `zops project logging`, `zops project prometheus` | GUI → project settings |
| Pause a build for inspection over SSH | `zops service debug` | GUI → *Pipelines & CI/CD settings* |
| Platform notifications | `zops notification list` | GUI → the bell |

Every row is reachable from `zops`, because it wraps the REST API rather than a curated subset.
Restoring a backup is still GUI-only — the API exposes creation, tagging, retention and a
download URL, but no restore endpoint.

### REST API

```
Base URL:  https://api.app-prg1.zerops.io/api/rest/public
Auth:      Authorization: Bearer <personal access token>
Swagger:   https://api.app-prg1.zerops.io/api/rest/public/swagger
```

Token from GUI → Settings → **Access Token Management**. Non-obvious resource names:
`/service-stack` manages services, `/user-data` manages environment variables. Other useful groups:
`/app-version` (builds, deploys, rollback), `/project`, `/project-env`, `/public-http-routing`,
`/public-port-routing`.

**Verified against the live API** (some `api.mdx` names are stale): `GET /service-stack/{id}` and
`GET /project/{id}` work and return full detail (service status, `activeAppVersion`,
`primaryInstanceLocation`). The **search** endpoints take a POST body and **require `clientId`** in
the conditions or they 400 with `clientId not defined` — this is the way to read appVersion status:

```sh
curl -sS -X POST "$BASE/app-version/search" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"search":[{"name":"clientId","operator":"eq","value":"<orgId>"},
                 {"name":"serviceStackId","operator":"eq","value":"<serviceId>"}],
       "sort":[{"name":"created","ascending":false}],"limit":6}'
# -> items[].status (ACTIVE | DEPLOY_FAILED | BACKUP), items[].activationDate
```

`GET /app-version?serviceStackId=…`, `/user-data` and `/project-env` returned 404 as written — use
the service-stack detail or the search POST above instead. The `orgId` (clientId) is on the project
detail (`GET /project/{id}` → `clientId`).

Scope CI tokens to the narrowest project that will work, and keep production tokens out of shared
CI where a branch build can read them.

## Roles and tokens

Permissions resolve in two layers: a **project role override** if one exists, otherwise the
**organization role**. Non-project operations (billing, team management) use the organization role
only.

| Role | Org access | Default project access | Create projects | Manage team |
|---|---|---|---|---|
| Owner | full, incl. billing | full | yes | all roles |
| Admin | full, excl. billing | full | yes | Developer, Guest |
| Developer | none | **none** — per-project only | yes (owns what they create) | no |
| Guest | none | **none** — per-project only | no | no |

Every organization must keep at least one Owner. Owners and Admins cannot be dropped below *Read
only* on a project through the GUI (the API can set `NO_ACCESS`).

Project access is **Full access** or **Read only**. Read-only blocks more than writes: no SSH web
terminal, no file browser, no backup or code download, no VPN key creation, and sensitive
environment variables come back as `REDACTED`. With full access, a personal access token still
got plaintext from the env list endpoints (verified live, 2026-10). The API also has decrypted reads
that require **sudo mode** — `GET /user-data/{id}/reveal` (service) and
`GET /project-env/{id}/reveal` (project) — which a browser login enters through a consent page.

### Integration tokens

Created at GUI → Settings → **Access Token Management**, or headlessly with
`zops token integration create <name> --project-role <project>=<ROLE>` (see
[`zops-cli.md`](zops-cli.md)) — which needs an organization-scoped token itself, so it bootstraps
per-project tokens rather than replacing the first one. Three shapes:

| Shape | Reach |
|---|---|
| Full access to all projects | every current and future project |
| Read access to all projects | view-only everywhere |
| **Custom access per project** | nothing by default; each project added explicitly as Full or Read only |

- **The value is shown once.** Regenerate creates a new value and immediately kills the old one;
  settings are preserved.
- **A token can never exceed its creator's permissions.** Developers and Guests can only mint
  *Custom access per project* tokens.
- A user cannot be demoted while holding tokens with higher permissions — modify or delete those
  first.
- Admins can manage tokens created by Developers and Guests, but not those of other Admins or Owners.

Prefer *Custom access per project* for anything automated. It is also the **only** shape `zcp`
accepts — it refuses account-wide and multi-project tokens at startup
([`zcp-mcp.md`](zcp-mcp.md#zcp_api_key)).

Keep the names distinct: `ZEROPS_TOKEN` is the CI/`zcli` delivery token, `ZCP_API_KEY` is the
single-project agent token. A production `ZEROPS_TOKEN` belongs in the release secret store and
nowhere near a development agent.

The API exposes two roles the dashboard does not (`BASIC_USER`, `READ_ONLY`) plus per-user flags
`canViewFinances`, `canEditFinances`, `canCreateProjects`.

## `zsc` commands

Run inside containers — from the GUI web terminal, over SSH, or from `zerops.yaml` commands.

### `zsc install <base>`

Adds a technology to the current container.

```sh
zsc install python@3.11
zsc install rust@1.78
```

```yaml
run:
  base: nodejs@22
  prepareCommands:
    - zsc install python@3.11
```

### `zsc exec-once <key> -- <command>`

Runs a command exactly once across all containers of a service — the answer to "how do I run
migrations without racing in HA". `execOnce` stays accepted as an alias; upstream now writes the
kebab-case form, as it does for `env-replace`, `set-env` and `set-secret-env`.

```sh
zsc exec-once ${ZEROPS_appVersionId} -- php /var/bin/console migrations:continue
```

`-r/--retryUntilSuccessful` retries on a different container until it succeeds. On failure without
that flag, all containers report the command failed.

### `zsc debug continue|success|fail`

Available only while a pipeline is **paused by debug mode**. Configure the pause points first in
GUI → service → *Pipelines & CI/CD settings*, per phase (build / runtime-prepare): *Disable*,
*Before first command*, *On command fail*, *After last command*. Then connect to the paused
container and drive it:

| Command | Before first command | On command fail | After last command |
|---|---|---|---|
| `zsc debug continue` | run the phase's commands | skip the failed command, carry on | move to the next phase |
| `zsc debug success` | end the phase without running anything | ignore the failure, mark success | mark the phase successful |
| `zsc debug fail` | mark the phase failed | end with the original error | overwrite success with failure |

*On command fail* on the build phase is the tool for triaging a failing build — it holds the
container at the moment of failure so you can inspect state.

Caveats: the 60-minute build limit **includes the paused time**; `zsc debug success` requires valid
`deployFiles`; settings persist until changed, so disable both phases when finished.

### `zsc noop`

Keeps a container alive with a non-terminating process. Use as `start:` for services with no
foreground process, or to keep a failing build container inspectable.

```yaml
run:
  start: zsc noop --silent
```

### `zsc scale {cpu|ram} {<value> <duration>|auto}`

Temporary manual scaling of the current container.

```sh
zsc scale cpu 5 1h
zsc scale cpu +2 30m
zsc scale ram 5GB 1h
zsc scale ram +2.5GB 600s
zsc scale ram max 10m
zsc scale cpu auto          # drop back to autoscaling
```

RAM values need a unit (KiB/MiB/GiB) and may be floats; CPU values are bare integers. `+` is
relative to current usage. `min`/`max` use the service's configured bounds. Duration units
`s/m/h/d`, **minimum 10 minutes**. Effective within ~10 s.

Cannot exceed the service's configured min/max — a request above the max simply yields the max.
Changing the autoscaling configuration cancels custom scaling; call `zsc scale` again. If the node
lacks capacity the container may migrate, which resets the duration.

`zsc resources` prints the current allocation as JSON.

### `zsc env-replace <source> <target>`

Renders Go `text/template` files: `{{.VAR}}` becomes the value of env var `VAR`, the result goes to
`<target>` and the source is never modified. A source directory is rendered recursively into the
target directory. Guard optional variables with `{{if .VAR}}…{{end}}`; a file named
`script.sh.0755` is written as `script.sh` with mode `0755`. The target must not be inside the
source.

```yaml
run:
  initCommands:
    - zsc env-replace ./templates/app.conf /etc/app/app.conf
```

**Not the same as the `envReplace` key in `zerops.yaml`**, which rewrites `%%VAR%%` placeholders in
deployed files in place. `zsc env-replace` runs per container start, so it sees the live runtime
values.

### `zsc shared-storage mount <name>` — SeaweedFS mount shortcut

Shared storage is deprecated; the command keeps its name and now mounts a **SeaweedFS** service at
`/mnt/<name>` with `weed mount` against `node-stable-1.db.<name>.zerops:8888`, with a RAM-lean tuning
(~100–150 MB). **It needs `sudo`.**

```yaml
run:
  startCommands:
    - name: app
      command: npm start
    - name: storage
      command: sudo zsc shared-storage mount storage            # foreground, restarted if it dies
  # or, when initCommands need the files:
  initCommands:
    - sudo zsc shared-storage mount storage --background        # returns when ready, NOT restarted
```

`unmount` also removes the mount directory; `wait` blocks until the mount is ready. Migration from
the managed mounts is in [`operations.md`](operations.md#seaweedfs-and-the-shared-storage-migration).

### `zsc object-storage`

Backup and restore directories to an object-storage service. Requires `objectstorage_apiUrl`,
`objectstorage_accessKeyId`, `objectstorage_secretAccessKey`, `objectstorage_bucketName` in the
environment — present automatically only when the storage shares its variables with your service
(`envIsolation: none`, or `envIsolation: service@<your-hostname>` on the storage or the project);
otherwise reference them explicitly.

```sh
zsc object-storage list    --storage <svc> --name <backup>
zsc object-storage backup  <dir>... --storage <svc> --name <backup> [--truncate-count N] [-C <dir>]
zsc object-storage restore [<dir>]  --storage <svc> --name <backup> [--dryRun] [--overwrite]
                                     [--index N] [--ignore-non-existing] [--strip-components N]
zsc object-storage truncate --storage <svc> --name <backup> [--truncate-count N] [--dryRun]
```

`--index`: `0` newest, `1` second newest; negative counts from oldest. Common parameters:
`--silent`, `--no-fail`.

```yaml
run:
  initCommands:
    - zsc object-storage restore --storage objectstorage --name $ZEROPS_StackName --ignore-non-existing ./data/
  crontab:
    - timing: "*/10 * * * *"
      command: zsc object-storage backup --storage objectstorage --name $ZEROPS_StackName --truncate-count 5 ./data/
      allContainers: false
```

### Others

| Command | Purpose |
|---|---|
| `zsc backup-create <stackName>` | Trigger a backup of a service |
| `zsc cdn purge <domain> [pattern]` | Invalidate CDN cache. Static-mode CDN only; run from any container in the project. Patterns: `"/*"`, `"/images/"`, `"/path/file$"` |
| `zsc crontab list \| run` | Inspect or trigger cron entries from `zerops.yaml` |
| `zsc set-env <key> <value> [--sensitive]` | Set or update a variable of the current service; `-` reads stdin. Without `--sensitive` an existing variable keeps its secret flag and a new one is plain. `setSecretEnv` / `set-secret-env` is the deprecated always-sensitive form |
| `zsc test tcp <host>:<port>` | Connectivity probe. `--timeout` (30s), `--dialTimeout` (2s), `-4`, `-6` |
| `zsc fail-me` | Deliberately fail the container (testing) |
| `zsc resources` | Current CPU/RAM/disk allocation |
| `zsc version`, `zsc help`, `zsc completion <shell>` | |
