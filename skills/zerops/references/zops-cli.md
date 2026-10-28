# `zops` — complete, agent-first CLI

`zops` ships with this plugin, in [`cli/`](../../../cli). It is generated from the Zerops OpenAPI
document, so **all 228 public API operations are reachable** — including everything
[`cli.md`](cli.md#what-zcli-cannot-do) lists as missing from `zcli`. 123 of them have a curated
command; the rest are one `zops api` call away.

**`zops --help` and `zops commands --json` are the source of truth for syntax.** This page is the
operating contract: when to reach for it, what its output guarantees are, and the things its help
text cannot tell you.

## Running it

There is nothing to install. Call the bundled wrapper, which runs the CLI from source with Bun:

```sh
"$CLAUDE_PLUGIN_ROOT/bin/zops" status
```

Every example below writes plain `zops` for readability. Use the wrapper path unless the user has
put a `zops` of their own on `PATH` — the wrapper ignores one on purpose, so that the commands
always match the documentation shipped beside them. If Bun is missing it says so and exits 1.

## When to use which tool

| Situation | Tool |
|---|---|
| Ship code (build + deploy) | `zops push` or `zcli push` — either works |
| Restart, reload, scale, env writes, routing, rollback, backups, deploy history | **`zops`** — `zcli` has no command |
| Git-push builds, CDN, tokens, project/service configuration | **`zops`** — `zcli` has no command |
| Anything else in the API | `zops api <operationId>` |
| Connect to the private network | `zcli vpn up` — `zops` deliberately omits VPN |
| Inside a running container | `zsc` |
| Zerops Box sandboxes, bases, templates, workspace policy | `zbox` — the workspace API is not in the Zerops API; `zops` handles only the `zbox@1` service itself ([`zbox.md`](zbox.md)) |
| Agent with MCP already wired up | `zcp` is fine for the operations it covers |

## Setup

```sh
cd cli && bun install && bun run build     # dist/zops, or run `bun src/index.ts`
export ZEROPS_TOKEN=...                    # or: zops auth login <token>
export ZEROPS_PROJECT=myapp                # names work everywhere ids do
```

`zops` also reads `projectId` / `serviceId` from an existing `.zcli.yaml`.

## Output contract

- **stdout is data; stderr is progress, warnings and errors** — including the JSON error
  envelope. `zops … --json | jq` is always safe.
- `--json` on every command; `--quiet`/`-q` for bare values, one per line.
- One error shape everywhere:
  `{"ok":false,"error":{"code","message","exitCode","retriable","hint"}}`
- Destructive commands require `--yes` when stdin is not a TTY, and all accept `--dry-run`.
  Nothing ever prompts an agent into hanging.

## Exit codes

`0` ok · `1` error · `2` usage · `3` auth · `4` not found · `5` conflict · `6` **transient, retry**
· `7` wait timed out (still running) · `8` remote operation failed.

The two that matter after a deploy: **8 means the build or deploy failed**, **7 means it is still
going**. Branch on these instead of grepping output.

## Async by default

Almost every mutation is asynchronous on the platform. `zops` **waits by default** so the exit code
reflects reality. `--no-wait` returns the process id; `zops process wait <id>` joins later;
`--timeout 20m` changes the deadline.

## Recipes

```sh
zops status                                  # orient: project, services, health, domains
zops apply -f zerops-import.yaml --dry-run   # what would change; then drop --dry-run
zops push api                                # streams build logs, exits 8 if the build fails
zops logs api --build                        # why the last build failed
zops logs api --since 1h --severity ERROR    # what went wrong recently
zops version rollback api --yes              # undo the last deploy
zops env set KEY value api --restart         # writes alone do NOT restart the service
zops scale set api --min-containers 2 --max-containers 5
zops catalog --search postgres               # valid type/version strings, no guessing
zops validate -S api                         # check zerops.yaml before spending a build
zops service create db --type postgresql:ha@18   # one service without an import YAML
zops route http get api.example.com          # DNS and certificate state for a domain
zops repo connect acme/api api --branch main # build on every push instead of `zops push`
zops notification list --type ERROR          # failures that happened after the process finished
```

## `zops apply` — the closest thing to declarative infrastructure

Import is create-only: re-importing updates nothing, and `override: true` *replaces* a runtime
service and forces a redeploy. A versioned import file is therefore a bootstrap script, not a
declaration of state, and it drifts from the first GUI change onwards.

`zops apply -f <import.yaml>` reconciles the file against the live project:

| | |
|---|---|
| **creates** | services in the file that do not exist — one import call, so the platform still expands `<@generateRandomString(…)>` |
| **converges** | `minContainers`/`maxContainers`, `verticalAutoscaling`, `enableSubdomainAccess`, `objectStorageSize` |
| **creates** | declared `envSecrets` keys that are missing |
| **reports** | everything else: a changed `type`, services nobody declared |

Deliberate limits, because the alternative is worse than drift:

- **Nothing is ever deleted.** An undeclared service is as likely to be deliberate as leftovers.
- **An existing secret is never overwritten**, so re-applying a file with generated secrets does not
  rotate a session secret or a database password out from under a running app. Change one with
  `zops env set … --restart`.
- **A blocked action does not abandon the rest.** Some fields are only settable in a particular
  order — a subdomain needs a deployed HTTP port — so failures are collected and reported, and the
  command exits 8 with the rest applied. Re-run once the blocker clears.
- `--dry-run` prints the same plan without sending a mutating request. Start there.

## Gotchas worth knowing

- **`zops env set` does not restart the service.** Running containers keep the old value until
  recreated. Pass `--restart`, or follow with `zops service restart`. A *reload* is not enough —
  it does not re-read environment variables.
- **`zops env list` fails with `serviceStackNotFound` before the first deploy**, and never shows
  `run.envVariables` at all — those are baked into the app version, not stored on the service. Use
  `zops env show` for what the process actually sees. See
  [`env-variables.md`](env-variables.md#reading-variables-back).
- **`zops push` reports that a deploy succeeded, not what it deployed.** A stale or wrong
  `zerops.yaml` builds, deploys and reports `ACTIVE` exactly like the right one; the only symptom is
  the app misbehaving. It now echoes the resolved `start` command for that reason — check it matches
  what you expect before believing a green deploy.
- **`zops logs` filters on the server over the whole retained history.** `--since`, `--until`,
  `--grep`, `--severity` and `--query '<LogsQL>'` all run in the project's VictoriaLogs; see
  [`operations.md`](operations.md#logging) for the fields. `--follow` accepts only the service,
  `--container`, `--type` and `--severity` filters, because the live stream supports no others.
- **Build logs belong to a throwaway builder service**, tagged `zbuilder@<appVersionId>`.
  `zops logs <svc> --build` handles the lookup.
- **Rollback is a redeploy of an archived version**, not a distinct endpoint. Nothing is rebuilt.
- **A project-scoped token cannot run `zops project list`** (exit 3). That is the token's shape, not
  a bug — address the project explicitly with `-P`.
- **Backups can be tagged at creation** through the API, so protected backups *are* possible
  headlessly. The `--tags`-less limitation belongs to `zsc backup-create`, not to the platform.
- **Restore is still GUI-only.** The API covers create, list, tag, retention and download URLs.
- **A project-scoped token cannot use the documented project listing**, but *can* use the
  undocumented `POST /project/search`, which applies per-project ACLs. `zops project list` falls
  back to it automatically — so it works where `zcli project list` returns 403.
- **Organization-scoped commands need an organization-scoped token.** `zops token list`,
  `zops token integration …`, `zops notification …` and `zops project tags` address the *client*, not a
  project, and exit 3 under a project-scoped token. That is the token's shape, not a bug.
- **`zops repo connect` needs an OAuth grant that only the GUI can obtain.** Without it the
  integration registers and then never fires; `zops repo status` reports
  `authorizationRequired: true`. Check with `zops repo list` before assuming a hook is live.
- **Routing edits are staged, then synced.** Every `zops route` command syncs for you, but a change
  made in the GUI or through `zops api` is not live until `zops route http sync` /
  `zops route port sync`. `zops route … revert` throws staged changes away.
- **Static CDN and storage CDN are different features.** `zops cdn purge` invalidates a routed
  domain on the balancer; `zops cdn storage purge` invalidates objects in a bucket. Neither
  affects the other.
- **`zops service debug` sends both phases every time.** There is no endpoint to read the current
  setting, so an omitted flag is written as `NONE` rather than left alone. A paused container is
  billed while it waits.
- **`zops project mode SERIOUS` is one-way.** The platform upgrades a LIGHT core to the HA one and
  does not downgrade it back.

## Undocumented search endpoints

17 Elasticsearch-backed `/search` endpoints exist that are not in the OpenAPI document; `zcli`
uses them internally. `zops` exposes them through `zops api --list --tag Search`, with a warning on
use, since nothing upstream promises they are stable.

Worth reaching for when you need **date-range filtering, sorting, or `totalHits` paging** — none
of which the documented list endpoints offer. Operators are type-dependent: `eq`/`ne` on strings,
`gt`/`gte`/`lt`/`lte` on dates, everything else rejected. `search` and `sort` are required even
when empty, and most resources need a `clientId` term.

## Extending it

```sh
cd cli
curl -o openapi.yml https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml
bun run generate && bun test
```

New operations become available through `zops api` immediately; only new *workflows* justify a
curated command.
