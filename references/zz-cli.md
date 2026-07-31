# `zz` — complete, agent-first CLI

`zz` lives in [`cli/`](../cli) in this repository. It is generated from the Zerops OpenAPI
document, so **all 228 public API operations are reachable** — including everything
[`cli.md`](cli.md#what-zcli-cannot-do) lists as missing from `zcli`.

**`zz --help` and `zz commands --json` are the source of truth for syntax.** This page is the
operating contract: when to reach for it, what its output guarantees are, and the things its help
text cannot tell you.

## When to use which tool

| Situation | Tool |
|---|---|
| Ship code (build + deploy) | `zz push` or `zcli push` — either works |
| Restart, reload, scale, env writes, routing, rollback, backups, deploy history | **`zz`** — `zcli` has no command |
| Anything else in the API | `zz api <operationId>` |
| Connect to the private network | `zcli vpn up` — `zz` deliberately omits VPN |
| Inside a running container | `zsc` |
| Agent with MCP already wired up | `zcp` is fine for the operations it covers |

## Setup

```sh
cd cli && bun install && bun run build     # dist/zz, or run `bun src/index.ts`
export ZEROPS_TOKEN=...                    # or: zz auth login <token>
export ZEROPS_PROJECT=myapp                # names work everywhere ids do
```

`zz` also reads `projectId` / `serviceId` from an existing `.zcli.yaml`.

## Output contract

- **stdout is data; stderr is progress, warnings and errors** — including the JSON error
  envelope. `zz … --json | jq` is always safe.
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

Almost every mutation is asynchronous on the platform. `zz` **waits by default** so the exit code
reflects reality. `--no-wait` returns the process id; `zz process wait <id>` joins later;
`--timeout 20m` changes the deadline.

## Recipes

```sh
zz status                                  # orient: project, services, health, domains
zz push api                                # streams build logs, exits 8 if the build fails
zz logs api --build                        # why the last build failed
zz version rollback api --yes              # undo the last deploy
zz env set KEY value api --restart         # writes alone do NOT restart the service
zz scale set api --min-containers 2 --max-containers 5
zz catalog --search postgres               # valid type/version strings, no guessing
zz validate -S api                         # check zerops.yaml before spending a build
```

## Gotchas worth knowing

- **`zz env set` does not restart the service.** Running containers keep the old value until
  recreated. Pass `--restart`, or follow with `zz service restart`. A *reload* is not enough —
  it does not re-read environment variables.
- **Log `--limit` is not a scan depth.** The platform filters within a window over the project's
  *combined* log stream, so `zz` separates `--limit` (lines you want) from `--scan` (how far back
  the server looks). If a quiet service in a busy project returns nothing, raise `--scan`.
- **Build logs belong to a throwaway builder service**, tagged `zbuilder@<appVersionId>`.
  `zz logs <svc> --build` handles the lookup.
- **Rollback is a redeploy of an archived version**, not a distinct endpoint. Nothing is rebuilt.
- **A project-scoped token cannot run `zz project list`** (exit 3). That is the token's shape, not
  a bug — address the project explicitly with `-P`.
- **Backups can be tagged at creation** through the API, so protected backups *are* possible
  headlessly. The `--tags`-less limitation belongs to `zsc backup-create`, not to the platform.
- **Restore is still GUI-only.** The API covers create, list, tag, retention and download URLs.
- **A project-scoped token cannot use the documented project listing**, but *can* use the
  undocumented `POST /project/search`, which applies per-project ACLs. `zz project list` falls
  back to it automatically — so it works where `zcli project list` returns 403.

## Undocumented search endpoints

17 Elasticsearch-backed `/search` endpoints exist that are not in the OpenAPI document; `zcli`
uses them internally. `zz` exposes them through `zz api --list --tag Search`, with a warning on
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

New operations become available through `zz api` immediately; only new *workflows* justify a
curated command.
