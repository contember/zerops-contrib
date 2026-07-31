# ZCP — the MCP server (`zcp`)

The third tool surface, after `zcli` (your machine / CI) and `zsc` (inside a container). **`zcp` is
an MCP server that exposes one Zerops project to a coding agent.** Any MCP-capable client can
connect and call its tools.

It matters even when no agent is involved, because **it covers most of the day-2 operations `zcli`
has no command for** — restart, scaling, env writes, subdomain toggling, rollback-adjacent state
reads. Where [`cli.md`](cli.md#what-zcli-cannot-do) says "GUI or REST API", `zcp` is usually the
third answer.

## Contents

- [The three surfaces](#the-three-surfaces)
- [What it covers that `zcli` does not](#what-it-covers-that-zcli-does-not)
- [Tools](#tools)
- [Remote vs local setup](#remote-vs-local-setup)
- [Local install](#local-install)
- [`ZCP_API_KEY`](#zcp_api_key)
- [Generating a local `.env`](#generating-a-local-env)
- [Production boundary](#production-boundary)
- [Diagnosing a stuck run](#diagnosing-a-stuck-run)
- [Gotchas](#gotchas)

## The three surfaces

| | `zcli` | `zsc` | `zcp` |
|---|---|---|---|
| Runs on | your machine, CI | inside every container | your machine, or a `zcp@1` service |
| Talks to | Zerops API | the container it runs in | Zerops API, one project only |
| Scope | every project the token reaches | one container | **exactly one project** |
| Interface | CLI | CLI | MCP tools (+ `zcp init`, `zcp serve`, `zcp version`) |
| Auth | `zcli login <token>` | ambient | `ZCP_API_KEY`, falls back to a `zcli` login |

The same personal access token from GUI → Settings → **Access Token Management** feeds all three;
`zcp` additionally *requires* it to be scoped to a single project. There is no raw API passthrough
in any of them — for anything none of these expose, call the [REST API](cli.md#rest-api) directly.

## What it covers that `zcli` does not

| Task | `zcli` | `zcp` |
|---|---|---|
| Restart / reload a service | **no command** | `zerops_manage` |
| Start / stop | `service start` / `stop` | `zerops_manage` |
| Change CPU / RAM / disk / CPU mode / container count | **no command** | `zerops_scale` |
| Read or write env variables | read-only `project env` | `zerops_env` |
| Enable / disable subdomain access | `service enable-subdomain` (enable only) | `zerops_subdomain` |
| Connect shared storage | **no command** | `zerops_manage` |
| Read service events / deploy history | **no command** | `zerops_events` |
| Health / HTTP-readiness probe | **no command** | `zerops_verify` |
| Export a project or service as YAML | **no command** | `zerops_export` |
| Expand preprocessor expressions | **no command** | `zerops_preprocess` |
| Delete a service | `service delete` | `zerops_delete` (named approval required) |
| Build + deploy | `push` / `deploy` | `zerops_deploy` (wraps `zcli push`) |
| Logs | `service log` | `zerops_logs` |

Still nowhere but the GUI or REST: rollback to an archived app version, domain / port / firewall
routing, backup listing, deletion and retention, and L7 balancer configuration.

`HA` / `NON_HA` is set at service creation and `zerops_scale` cannot change it either — see
[`operations.md`](operations.md#moving-a-managed-database-to-ha).

## Tools

Read-only:

| Tool | Purpose |
|---|---|
| `zerops_discover` | Services, ports, env-var keys, project topology, current state |
| `zerops_export` | Project/service export YAML and service metadata |
| `zerops_logs` | Runtime and build logs, filtered by service, severity, time, search |
| `zerops_events` | Service activity: deploys, builds, scaling, failures |
| `zerops_verify` | Service health, recent error logs, HTTP readiness |
| `zerops_knowledge` | Platform guidance for the current state |
| `zerops_process` | Check a known async process (cancelling is mutating) |

Mutating:

| Tool | Purpose |
|---|---|
| `zerops_deploy` | Build + deploy through the Zerops pipeline; returns build/deploy evidence |
| `zerops_env` | Read, set, delete, generate env vars and local `.env` files |
| `zerops_manage` | Start, stop, restart, reload, connect storage |
| `zerops_scale` | CPU, RAM, disk, CPU mode, container autoscaling |
| `zerops_subdomain` | Enable/disable public subdomain access |
| `zerops_delete` | Delete a service — **explicit named approval required** |

Setup and workflow: `zerops_import` (destructive override is gated behind a second acknowledging
call), `zerops_mount` (mount/unmount runtime filesystems, remote setup only), `zerops_preprocess`,
`zerops_workflow` (session state, recovery, packaging/export flow).

Two operations have hard confirmation gates: **service deletion** needs named approval in the
current conversation, and a **destructive import override** refuses once, naming what would be
replaced, and requires a second call acknowledging the same targets.

## Remote vs local setup

The same binary, two places to run it.

| | Remote setup | Local setup |
|---|---|---|
| Workspace service | always a `zcp@1` service | not required |
| `zcp` process | in Zerops | on your machine |
| Files the agent edits | workspace files, mounted runtime files | files on your machine |
| Private service access | project network, directly | `zcli vpn up` |
| Token location | injected into the workspace service | `.mcp.json` |
| Git credentials | configured in the workspace | your local git |
| Blast radius | agent shell stays inside Zerops | agent shell is on your laptop |

Remote is the safer default. Use local when local files, local data, desktop tooling, git
credentials or a local-only agent client are the point. Upstream warns that **local setup is less
settled** — the install path, `.mcp.json` shape and files written by `zcp init` still move between
releases.

Switching between them is a handoff, not a sync: preserve the source tree through git, pick one
deploy source for the next task, don't edit mounted runtime files and a local repo in parallel, and
regenerate `.env` after any env change.

Remote setup also relates to the Cloud IDE / hosted-workspace access paths in
[`networking.md`](networking.md#local-development).

## Local install

```sh
curl -sSfL https://raw.githubusercontent.com/zeropsio/zcp/main/install.sh | sh
zcp version
```

Installs into `~/.local/bin` (or `/usr/local/bin` as root). Then, from the directory the agent
should own:

```sh
zcp init
```

`zcp init` writes `.mcp.json`, `CLAUDE.md`, `.claude/settings.local.json` (Claude Code),
`~/.config/zerops/aliases` plus a shell-rc sourcing line, and `.zcp/state/` once MCP first stores
workflow state. Re-running it refreshes generated config: `CLAUDE.md` keeps edits outside its
managed markers, but **`.mcp.json` is regenerated from a token-less template** — re-add the key.

```json
{
  "mcpServers": {
    "zerops": {
      "command": "zcp",
      "args": ["serve"],
      "env": {
        "ZCP_API_KEY": "<single-project-token>"
      }
    }
  }
}
```

Add `.mcp.json` to `.gitignore` — it holds a live credential. One directory, one `.mcp.json`, one
token.

Prerequisites are a Zerops project, `zcli` installed and authenticated, an MCP-capable agent client,
and a single-project token. You do **not** need MCP to develop locally against Zerops services as a
human — `zcli vpn up` plus your editor is enough. Add MCP when an agent should also operate Zerops.

## `ZCP_API_KEY`

Generate at GUI → Settings → **Access Token Management**: choose **Custom access per project**, add
**exactly one** project, set it to **Full access**.

| Token shape | Result |
|---|---|
| Account-wide or multi-project | ZCP refuses to start (`Token accesses N projects; use project-scoped token`) |
| No project access | ZCP refuses to start (`Token has no project access`) |
| Expired or revoked | refuses to start, or HTTP 401 / `AUTH_TOKEN_EXPIRED` |
| Read-only project token | starts fine, then fails on every deploy, env write, restart, scale |

The message `No authentication found: set ZCP_API_KEY or log in with zcli` confirms the fallback:
**`zcp` can use a `zcli` login session** when no key is set. Upstream calls that a diagnostic
fallback, not the normal setup — a scoped `ZCP_API_KEY` is the intended path, and it is the only one
that enforces the single-project blast radius.

Token permissions are bounded by the creating user's role, and a user cannot be demoted while
holding tokens with higher permissions. See [`cli.md`](cli.md#roles-and-tokens).

## Generating a local `.env`

Zerops has no `.env` at runtime, and the VPN gives network reachability but **not** the env store —
so local development needs a bridge. `zerops_env action="generate-dotenv"` resolves Zerops
references and writes real values:

```
db_hostname=db
db_port=5432
db_password=<actual-password>
db_connectionString=postgresql://db:<actual>@db:5432
```

It merges three input channels — project `envVariables`, `zerops.yaml` `run.envVariables`, and
`.env.local` — into one resolved file, resolving `${db_password}`-style references recursively, so a
`DATABASE_URL` lands as a complete connection string.

Requirements: `zerops.yaml` in the working directory, a matching `setup:` entry, and non-empty
`run.envVariables` under it. If those are missing the agent should fix `zerops.yaml` or ask which
runtime to target — not invent values from service names.

- **Do not hand-edit `.env`.** The next generation refuses with a diff when it finds keys it did not
  produce. Put manual overrides in `.env.local` (a no-touch input channel that survives
  regeneration), or pass `force=true`.
- It is a **snapshot, not a live sync** — regenerate after changing anything in Zerops.
- VPN is still required for the local app to actually reach `db` / `cache` from that `.env`.
- Keep `.env` out of git.

## Production boundary

**Keep `zcp` in development or staging. Production stays a separate project with no `zcp` service.**
Zerops does not enforce this; the reason is blast radius — the MCP server hands a coding agent
operational access to everything in its project.

| Project | Contains | Operated by |
|---|---|---|
| Development / staging | `zcp` service, agent workspace, dev + optional stage runtime, non-production managed services | agent and humans |
| Production | production runtimes, managed services, env values, backups, scaling | CI / release process and humans |

Different tokens per project: a development `ZCP_API_KEY` must never reach production, and the
production `ZEROPS_TOKEN` belongs only in the release secret store — not in the `zcp` service and not
in a local `.mcp.json`.

Stage is the rehearsal, not production approval. Match production where it matters (runtime family
and version, managed service types, build/start command pattern, deploy route) but with
non-production data and secrets. The release itself happens outside the agent loop: CI on a merged
commit or tag, or a deliberate `zcli push` with production credentials.

## Diagnosing a stuck run

Start from live state, not chat history:

```text
Read current project status and tell me where things stand before changing anything.
```

Evidence depends on the failure category reported by the deploy/verify tools:

| Category | Read first | Do not |
|---|---|---|
| `build` | build logs, build commands, dependency manifests, deploy file list | read runtime logs — the runtime never started |
| `start` | prepare/runtime logs, start command, ports, env references | rebuild without knowing why the process exited |
| `verify` | failing check detail, HTTP response, request-time runtime logs, stored state | call a green deploy "done" before behavior passes |
| `network` | VPN, SSH, DNS, subdomain readiness, service status, transport error | edit app code before proving connectivity |
| `config` | field-level rejection, `zerops.yaml`, setup name, env refs, service settings | guess from service names or dashboard memory |
| `credential` | the named credential surface (`ZCP_API_KEY`, git, SSH, managed service, CI, external API) | rotate unrelated secrets |

Local setup has **two independent connections** — `ZCP_API_KEY` for the Zerops API, and `zcli vpn up`
for private hostnames. MCP working proves nothing about whether the app can reach `db`.

| Symptom | Check |
|---|---|
| Client does not list the MCP server | relaunch the agent from the directory holding `.mcp.json` |
| Startup says the token reaches multiple projects | replace with a single-project token |
| MCP vanished after re-running `zcp init` | re-add the `ZCP_API_KEY` block to `.mcp.json` |
| Local app cannot reach `db` / `cache` | `zcli vpn up <project-id>` again |
| Local app reads stale credentials | regenerate `.env` — it is a snapshot |
| `zcp: command not found` | add the install dir to `PATH`, restart the shell |

Stop the loop when the same failure repeats without new evidence, an external credential is needed,
the target runtime is ambiguous, a destructive action is next, or production release authority is
required.

## Gotchas

1. **One project per server instance.** ZCP binds to a single project at startup; a multi-project
   token is rejected outright. Several projects means several directories, each with its own
   `.mcp.json` and token.
2. **`zcp init` strips the token.** It regenerates `.mcp.json` from a token-less template — re-add
   `ZCP_API_KEY` before launching the agent, or the server silently will not be there.
3. **Launch directory matters.** The agent must start in the directory containing `.mcp.json`.
4. **The MCP server name is inconsistent upstream.** `zcp/setup/local-agent-bridge` shows
   `"zerops"` and says the name is intentional and should not be renamed; `guides/local-development`
   shows `"zcp"` with no `args`. Follow the setup page (`"zerops"`, `"args": ["serve"]`) and treat
   the guide's snippet as stale.
5. **VPN is not MCP auth.** They fail independently and produce different symptoms.
6. **`.env` is a credential snapshot**, not a sync. Regenerate after every Zerops env change and keep
   it and `.mcp.json` out of git.
7. **A read-only token starts fine and fails later** — at the first deploy, env write, restart or
   scale, not at startup.
8. **Deploy success is not proof.** A green build proves Zerops accepted it; reachability proves the
   process is up. Neither proves the requested behavior works.
