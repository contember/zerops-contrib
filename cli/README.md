# `zops` — agent-first CLI for Zerops

A complete client for the Zerops public API, generated from its OpenAPI document and wrapped in a
command surface designed for AI coding agents (and, as a side effect, for humans in a hurry).

`zcli`, the official CLI, covers roughly a third of the API. Restart, reload, autoscaling,
backups, environment writes, routing, rollback and deploy history have no command — the docs send
you to the GUI. All of it is in the REST API, so all of it is here.

```
228 documented operations + 17 undocumented · 100% reachable via `zops api`
123 curated commands over the operations that deserve one · 0 runtime dependencies
```

## Install

```sh
bun install
bun run generate          # regenerate the operation index from openapi.yml
bun run build             # single binary at dist/zops
```

Or run straight from source: `bun src/index.ts <command>`.

## Authenticate

```sh
export ZEROPS_TOKEN=...            # preferred in CI — nothing written to disk
zops auth login <token>              # or persist to ~/.config/zops/config.json (0600)
zops auth status
```

Tokens come from the Zerops GUI under **Settings → Access Token Management**. A project-scoped
token is enough for everything except `project list` and `project create`.

## Context

Every command takes `--project/-P` and `--service/-S`, accepting **names or ids**. Resolution
order is flag → environment → config file:

| Source | Keys |
|---|---|
| Environment | `ZEROPS_TOKEN`, `ZEROPS_PROJECT`, `ZEROPS_SERVICE`, `ZEROPS_REGION` |
| `./.zops.json` / `.zops.yaml` (walking up) | `token`, `project`, `service`, `region` |
| `./.zcli.yaml` | `projectId`, `serviceId` — read for compatibility |
| `~/.config/zops/config.json` | written by `zops auth login` |

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

zops token integration create ci --project-role myapp=BASIC_USER
zops notification list --type ERROR           # what broke after the process finished

zops catalog --search postgres                # valid type/version strings
zops validate -S api                          # check zerops.yaml before pushing
zops schema zerops > zerops-schema.json       # JSON Schema for editors and agents
```

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

**VPN.** `zcli vpn up` needs root, WireGuard and platform-specific DNS work, and it is orthogonal
to the API. Keep using `zcli` for that one thing.

**Account and billing.** Interactive login, 2FA and WebAuthn ceremonies, registration, password
recovery, avatars, payment sources, invoices and the Stripe webhook. An agent has no business
holding these, and most reject an access token anyway. Team membership and project role
assignment are absent for the same reason — an integration token's scope is set when it is
created (`zops token integration create --project-role`), which covers the automation case without
handing the CLI the ability to reshape who can reach what.

Everything named here is still reachable through `zops api` if you genuinely need it.

## Notes on the API worth knowing

Discovered while building this; none of it is documented upstream:

- **`limit` on the log endpoint is a scan window, not a result count.** The server filters within
  the most recent N entries of the *project's combined* stream, so a narrow window over a busy
  project returns nothing for a quiet service. `zops logs` therefore separates `--limit` (lines you
  want) from `--scan` (how far back the server looks) and widens the scan automatically.
- **Build logs are ordinary container logs** from a throwaway builder service, tagged
  `zbuilder@<appVersionId>`.
- **Rollback is not its own endpoint** — it is `deployAppVersion` aimed at an archived version.
- **`getUserInfo` and `GetUserInfo` are different operations** (`/auth/info` vs `/user/info`).
  `zops api` matches ids case-insensitively except where that would be ambiguous.
- **Application tokens are rejected by `/auth/info`** but work everywhere else; `zops auth status`
  uses `/user/info`.
- **Backups can be tagged at creation** via the API, so a protected backup *can* be taken
  headlessly — the container-side `zsc backup-create` is what lacks the flag.
