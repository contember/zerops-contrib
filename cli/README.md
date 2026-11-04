# `zops` — agent-first CLI for Zerops

A complete client for the Zerops public API, generated from its OpenAPI document and wrapped in a
command surface designed for AI coding agents (and, as a side effect, for humans in a hurry).

`zcli`, the official CLI, covers roughly a third of the API. Restart, reload, autoscaling,
backups, environment writes, routing, rollback and deploy history have no command — the docs send
you to the GUI. All of it is in the REST API, so all of it is here.

```
247 documented operations + 17 undocumented · 100% reachable via `zops api`
122 curated commands over the operations that deserve one · 0 runtime dependencies
```

## Install

Nothing to install — `zops` ships inside the `zerops` Claude Code plugin and runs from this
source tree. Bun is the only prerequisite, because the CLI uses `Bun.YAML`, `Bun.spawn`,
`Bun.file` and `Bun.write`.

```sh
"$CLAUDE_PLUGIN_ROOT/bin/zops" status    # from the plugin
../bin/zops status                       # from a checkout
bun src/index.ts status                  # directly
```

It is not published to npm. To get a `zops` on `PATH` for interactive use, build the standalone
binary:

```sh
bun install
bun run build             # single binary at dist/zops, no Bun needed to run it
cp dist/zops ~/.local/bin/
```

## Authenticate

```sh
export ZEROPS_TOKEN=...            # preferred in CI — nothing written to disk
zops auth login <token>              # or persist to ~/.config/zops/config.json (0600)
zops auth status
```

Tokens come from the Zerops GUI under **Settings → Access Token Management**. A project-scoped
token is enough for everything except `project list` and `project create`.

### Profiles: one per organization

A Zerops token belongs to exactly one organization. To work with several, store one named
profile per organization. A profile holds either a token or a `tokenCommand`, a shell command
that prints the token, so the secret can stay in the keychain or a password manager:

```sh
zops auth login --profile acme   --token-command 'security find-generic-password -s zerops-acme -w'
zops auth login --profile globex --token-command 'op read op://work/zerops-globex/token' --project shop
zops profile list                    # names, credential kind, defaults; never a token
zops profile use acme                # the default from now on (`--none` clears it)
zops project list --profile globex   # one command against another organization
ZEROPS_PROFILE=globex zops service list
```

`auth login` writes into the profile in effect (`--profile`, `ZEROPS_PROFILE` or `profile use`),
creating it if needed, and into the top-level setting when there is none. The first profile
created becomes the selected one when the config has no top-level token yet. `--project`,
`--service` and `--region` typed on the `auth login` command line are stored as defaults.
`zops auth status` shows the profile in effect and where the token came from.
`zops auth logout` removes only the credential; `zops profile remove <name>` deletes a profile.

The resulting `~/.config/zops/config.json`:

```json
{
  "profile": "acme",
  "profiles": {
    "acme":   { "tokenCommand": "security find-generic-password -s zerops-acme -w" },
    "globex": { "tokenCommand": "op read op://work/zerops-globex/token", "project": "shop" }
  }
}
```

The `tokenCommand` runs through `/bin/sh` only when a command needs the token. A config file
without `profiles` keeps working exactly as before.

## Context

Every command takes `--project/-P` and `--service/-S`, accepting **names or ids**. Resolution
order is flag → environment → repo config file → profile or user config file:

| Source | Keys |
|---|---|
| Flags | `--token`, `--project`, `--service`, `--region` |
| Environment | `ZEROPS_TOKEN`, `ZEROPS_PROJECT`, `ZEROPS_SERVICE`, `ZEROPS_REGION` |
| `./.zops.json` / `.zops.yaml` (walking up) | `token`, `project`, `service`, `region` |
| `./.zcli.yaml` | `projectId`, `serviceId` (read for compatibility), also `token`, `region` |
| `~/.config/zops/config.json`, selected profile | `token` or `tokenCommand`, `project`, `service`, `region` |
| `~/.config/zops/config.json`, top level | the same keys; used only when no profile is selected |

The profile is selected by `--profile`, else `ZEROPS_PROFILE`, else `zops profile use`. It
replaces the top-level settings rather than layering over them, so a profile never inherits
another organization's token or project. A profile typed as `--profile` counts as a flag: its
values beat the environment and repo files, and only other typed flags beat it. A profile chosen
by `ZEROPS_PROFILE` or `profile use` sits in the table's last rows, so an exported `ZEROPS_TOKEN`
wins; zops then warns on stderr (not under `--json`, where `auth status` reports `tokenSource`).

A repo config file can pin a project but cannot select a profile or run a `tokenCommand`. A
`region` must be a plain label like `prg1`; anything else is rejected, since it becomes part of
the host the token is sent to. For another API host, set `ZEROPS_API_URL`.

## Output contract

This is the part that makes the tool scriptable:

- **stdout is data. stderr is everything else** — progress, warnings, and errors. `zops service list --json | jq` cannot be corrupted by a status line, even on the failure path.
- `--json` on every command. `--quiet`/`-q` prints bare values, one per line, for `xargs`.
- Errors always use one envelope:
  ```json
  { "ok": false, "error": { "code": "notFound", "message": "…", "exitCode": 4, "retriable": false, "hint": "…" } }
  ```
- No command ever prompts when its inputs are supplied. Destructive commands need `--yes`
  (or a TTY) and all accept `--dry-run`.

### Exit codes

| Code | Meaning | Retry? |
|---|---|---|
| 0 | success | — |
| 1 | unclassified error | no |
| 2 | usage error — bad command or flags | no |
| 3 | auth or permission error | no |
| 4 | not found | no |
| 5 | conflict — already exists or already in that state | no |
| 6 | transient — rate limit, 5xx, network | **yes** |
| 7 | `--wait` deadline elapsed; the operation is still running | poll |
| 8 | the remote operation ran and failed | no |

`push` exiting 8 means the build failed. `push` exiting 7 means it is still going.

## Async operations

Nearly every mutation is asynchronous on the platform. Commands **wait by default**, so the exit
code reflects the real outcome rather than "the request was accepted". Use `--no-wait` to get the
process id immediately, `--timeout 20m` to change the deadline, and `zops process wait <id>` to
join a process later.

## Command tour

```sh
zops status                                   # whole project in one call
zops service list --status ACTIVE --json
zops service restart api                      # a real endpoint, not stop+start
zops service reload api

zops push api                                 # build on the platform, stream logs, wait
zops push api --setup worker --version-name v1.4.2
zops deploy api ./dist ./package.json         # ship prebuilt artifacts

zops logs api --follow
zops logs api --build                         # the log for the last build
zops logs api --since 2d --until 1d --grep 'connection refused'
zops logs api --since 1d --query '* | stats by (severity) count() lines'   # LogsQL
zops logs api --json | jq -r 'select(.severity <= 3) | .message'

zops version list api                         # deploy history
zops version rollback api --yes               # redeploy the previous version

zops env set LOG_LEVEL debug api --restart    # writes do not restart on their own
zops env show db -q                           # every generated variable, keys only
zops scale set api --min-containers 2 --max-containers 5
zops backup create db --tag pre-migration

zops service create db --type postgresql:ha@18   # one service, no import YAML
zops route http create api.example.com api --port 3000
zops route http get api.example.com           # why a domain does not serve: DNS + TLS state
zops route http dns-check api.example.com     # re-check after fixing the A record
zops cdn storage enable assets                # publish a bucket through the CDN

zops repo connect acme/api api --branch main  # build on every push
zops repo build api                           # build now, without a push
zops pipeline trigger api --from-git https://github.com/acme/api@main

zops tunnel db:5432 -- psql -h 127.0.0.1 -p {port} -U db   # private network, no root
zops token integration create ci --project-role myapp=BASIC_USER
zops notification list --type ERROR           # what broke after the process finished

zops catalog --search postgres                # valid type/version strings
zops validate -S api                          # check zerops.yaml before pushing
zops schema zerops > zerops-schema.json       # JSON Schema for editors and agents
```

## Tunnels into the private network, without root

`zcli vpn up` puts the whole machine on a project's network through a kernel WireGuard
interface, which needs sudo for the interface, routes and resolver. `zops tunnel` reaches the
same network in userspace instead: [wireproxy](https://github.com/windtf/wireproxy) runs
WireGuard on its own network stack and forwards only the services you name to `127.0.0.1`.
Nothing on the machine changes, so an agent can open one by itself, and a running `zcli vpn` is
not disturbed.

```sh
# Run one command through the tunnel; zops exits with its status. {port} and $ZOPS_TUNNEL_PORT
# are the first tunnel's local port.
PGPASSWORD="$(zops env get password db -q)" \
  zops tunnel db:5432 -- psql -h 127.0.0.1 -p {port} -U "$(zops env get user db -q)" -c 'select 1'

# Or hold it open: prints the local addresses, closes on Ctrl-C (exit 130) or after --ttl (default 1h).
zops tunnel db:5432:15432 cache:6379 --ttl 30m --json
```

- **Needs wireproxy** on `PATH`, or its path in `--wireproxy` / `ZOPS_WIREPROXY` (release
  binaries on GitHub), and a token with at least `BASIC_USER` in the project. A `READ_ONLY`
  token cannot register a VPN key.
- **A fresh key per run.** zops registers a new WireGuard key with the project and deletes it on
  exit, also when interrupted at any point. The private key goes to wireproxy on stdin and is
  never written to disk.
- **Up means up.** zops runs the command (or prints the addresses) only once the project's
  resolver answers through the tunnel and every forward is held by wireproxy itself, not by some
  other process that took the port first. It waits up to 30s, or `--timeout` if shorter (exit 7).
- **Ctrl-C belongs to the command.** wireproxy runs in its own process group, so cancelling a
  query in `psql` does not take the tunnel down. SIGTERM and SIGHUP sent to zops are passed on to
  the command, and SIGINT too when zops is not in the terminal's foreground (a parent process
  or `kill -INT` stopping zops alone). A held tunnel whose reader is gone before the addresses
  are printed (`| true`) tears down and exits 0.
- **SIGKILL is the one thing zops cannot clean up after.** The run's public key and pids stay in
  `~/.config/zops/tunnels/`, and the next tunnel to the same project deletes the key and stops
  the orphaned wireproxy. Leftovers of other projects wait for a tunnel to those.
- **Names resolve as `<hostname>.zerops`** through the project's resolver; targets are always
  given as plain hostnames.
- **The tunnel is network access, not credentials.** Database users and passwords still come
  from the service's environment (`zops env`). For an agent, prefer a read-only database user.
- Listeners bind to `127.0.0.1` only, but any local process can connect to them while the tunnel
  is up. Close it when done.

## Escape hatch: `zops api`

The curated commands cover the common workflows. Everything else in the API is one call away, so
a gap is never a dead end.

```sh
zops api --list                        # every operation
zops api --list --tag ServiceStack
zops api --describe ConfigureAutoscaling
zops api GetProjectDetails --param id=@project
zops api RestartServiceStack --param id=@service --follow-process
zops api ConfigurePrometheus --param id=@project --body '{"retention":30}'
```

`@project`, `@service` and `@client` resolve from the current context, so ids rarely need pasting.

### The undocumented search endpoints

`zcli` uses an Elasticsearch-backed query surface that is absent from the published OpenAPI
document. Those 17 endpoints are declared by hand in `src/lib/extra-operations.ts`, tagged
`Search`, and `zops api` warns when you call one. Verified live against `api.app-prg1.zerops.io`.

```sh
zops api --list --tag Search
zops api SearchProcess --body '{
  "search":[{"name":"clientId","operator":"eq","value":"..."},
            {"name":"created","operator":"gt","value":"2026-07-31T12:00:00Z"}],
  "sort":[{"name":"created","ascending":false}],
  "limit":10
}'
```

They give three things the documented list endpoints do not: date-range filtering, multi-field
sorting, and `totalHits` with real offset/limit paging. Operators are type-dependent — string
fields take `eq`/`ne`, date fields take `gt`/`gte`/`lt`/`lte`, everything else is rejected. Nested
fields use dotted paths. `search` and `sort` are both required even when empty, and most resources
demand a `clientId` term. The DTO's `text` field is accepted but does not filter.

The one that matters operationally: **`POST /project/search` applies per-project ACLs**, while
`GET /client/{id}/project` requires organization-level read. `zops project list` tries the
documented endpoint first and falls back here on 403, which is why it works with a project-scoped
token where `zcli project list` does not.

## Discovery

```sh
zops commands --json          # machine-readable catalog: every command, flag, arg, exit code
zops <command> --help         # flags, arguments, examples, and the API operations behind it
```

`zops commands --json` exists so an agent can enumerate the surface at runtime instead of carrying
a copy of this README that goes stale.

## Regenerating against a newer API

```sh
curl -o openapi.yml https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml
bun run generate && bun test
```

New operations appear in `zops api` immediately. Only genuinely new *workflows* need a curated
command.

## What is deliberately missing

**A system-wide VPN.** `zcli vpn up` needs root, WireGuard and platform-specific DNS work. To
reach particular services without any of that, use `zops tunnel` (above); to put the whole
machine on the network, keep using `zcli`.

**Account and billing.** Interactive login, 2FA and WebAuthn ceremonies, registration, password
recovery, avatars, payment sources, invoices and the Stripe webhook. An agent has no business
holding these, and most reject an access token anyway. Team membership and project role
assignment are absent for the same reason — an integration token's scope is set when it is
created (`zops token integration create --project-role`), which covers the automation case without
handing the CLI the ability to reshape who can reach what.

Everything named here is still reachable through `zops api` if you genuinely need it.

## Notes on the API worth knowing

Discovered while building this; none of it is documented upstream:

- **Project logs are a VictoriaLogs instance with a LogsQL API.** `GetProjectLog` returns
  `urlUi`, `https://<proxy>/logs-ui/<accessToken>/login`; the same prefix serves the read API
  (`select/logsql/query`, `hits`, `stats_query`, `field_names`, `field_values`) with the token in
  the path and no other auth. `extra_stream_filters` and `extra_filters` are honoured, which is how
  `zops logs` scopes a free-form `--query` to one service. `select/logsql/tail` returns nothing
  through the proxy, so `--follow` uses the older websocket instead.
- **The older log stream replays the whole matching history on every connect.** It ignores `limit`
  and `from`, and its entry ids are generated per request, so they cannot resume a stream.
  `zops logs --follow` skips the replay by timestamp.
- **Build logs are ordinary container logs** from a throwaway builder service, tagged
  `zbuilder@<appVersionId>`.
- **Rollback is not its own endpoint** — it is `deployAppVersion` aimed at an archived version.
- **`getUserInfo` and `GetUserInfo` are different operations** (`/auth/info` vs `/user/info`).
  `zops api` matches ids case-insensitively except where that would be ambiguous.
- **Application tokens are rejected by `/auth/info`** but work everywhere else; `zops auth status`
  uses `/user/info`.
- **Backups can be tagged at creation** via the API, so a protected backup *can* be taken
  headlessly — the container-side `zsc backup-create` is what lacks the flag.
