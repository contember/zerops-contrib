# CLI reference — `zcli` and `zsc`

Two different tools:

- **`zcli`** — runs on **your machine or CI**. Talks to the Zerops API: login, VPN, projects,
  services, push/deploy, logs.
- **`zsc`** — preinstalled **inside every Zerops container** (build and runtime). Controls the
  container itself: scaling, installing bases, backups, cron, secrets.

## Contents

- [`zcli` install and auth](#zcli-install-and-auth)
- [`zcli` configuration](#zcli-configuration)
- [`zcli` commands](#zcli-commands)
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

## `zcli` commands

### Account and VPN

| Command | Purpose |
|---|---|
| `zcli login <token>` | Authenticate |
| `zcli logout` | Disconnect VPN and log out |
| `zcli vpn up [project-id]` | Connect. `--auto-disconnect`, `--mtu int` (default 1420), `-P/--project-id` |
| `zcli vpn down` | Disconnect |

### Projects

| Command | Notes |
|---|---|
| `zcli project list` | |
| `zcli project create` | `--name`, `--org-id`, `--mode light\|serious`, `--tags`, `--env-isolation service\|none`, `--ssh-isolation` (default `vpn`), `--out` (Go template) |
| `zcli project delete [project-id]` | `--confirm` skips the prompt |
| `zcli project env` | Print project env vars. `--export` prefixes `export`, `--template`, `--service`, `--user-only` |
| `zcli project project-import <file>` | Create project + services from import YAML. `--org-id`, `--working-dir` |
| `zcli project service-import <file>` | Add services to an existing project. `-P/--project-id` |

### Services

| Command | Notes |
|---|---|
| `zcli service list` | |
| `zcli service create` | `--name`, `--mode ha\|non_ha`, `--env`, `--env-file`, `--start-without-code`, `--noop` (create only if absent), `--zerops-yaml-path` |
| `zcli service push [service]` | **Build in Zerops and deploy.** The usual way to ship. Alias: `zcli push` |
| `zcli service deploy [service]` | Deploy pre-built artifacts, skipping the build phase |
| `zcli service start\|stop [service]` | |
| `zcli service delete [service]` | `--confirm` |
| `zcli service enable-subdomain [service]` | |
| `zcli service log` | See below |

#### `push` / `deploy` flags

| Flag | Meaning |
|---|---|
| `-P, --project-id` | Required with access to several projects |
| `-S, --service-id` | Required with access to several services |
| `--setup <name>` | Which `setup:` from `zerops.yaml` to use |
| `--version-name <s>` | Custom version label (e.g. a git tag) |
| `--working-dir <p>` | Default `./` |
| `--zerops-yaml-path <p>` | Non-default config path |
| `-w, --workspace-state` | `all` (default) / `clean` (HEAD without local changes) / `staged` |
| `--no-git` | Upload the working directory as-is. Incompatible with `--workspace-state` and `--deploy-git-folder` |
| `-g, --deploy-git-folder` | Include `.git/` |
| `--archive-file-path <p>` | Also write a `tar.gz` of the uploaded code |
| `--disable-logs` | Do not stream build logs |
| `-v, --verbose` | Extra debug into the log file |

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

### `zsc execOnce <key> -- <command>`

Runs a command exactly once across all containers of a service — the answer to "how do I run
migrations without racing in HA".

```sh
zsc execOnce ${ZEROPS_appVersionId} -- php /var/bin/console migrations:continue
```

`-r/--retryUntilSuccessful` retries on a different container until it succeeds. On failure without
that flag, all containers report the command failed.

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

### `zsc object-storage`

Backup and restore directories to an object-storage service. Requires `objectstorage_apiUrl`,
`objectstorage_accessKeyId`, `objectstorage_secretAccessKey`, `objectstorage_bucketName` in the
environment (present automatically only with `envIsolation: none`; otherwise reference them
explicitly).

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
| `zsc setSecretEnv <key> <value>` | Update a secret variable; `-` reads stdin |
| `zsc shared-storage mount\|unmount\|wait <name>` | Manage `/mnt/<name>` mounts |
| `zsc test tcp <host>:<port>` | Connectivity probe. `--timeout` (30s), `--dialTimeout` (2s), `-4`, `-6` |
| `zsc fail-me` | Deliberately fail the container (testing) |
| `zsc resources` | Current CPU/RAM/disk allocation |
| `zsc version`, `zsc help`, `zsc completion <shell>` | |
