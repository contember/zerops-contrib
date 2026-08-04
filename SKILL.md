---
name: zerops
description: Build, configure, deploy and operate applications on Zerops (zerops.io) — a bare-metal PaaS. Covers `zerops.yaml` (build/run pipeline, in the repo) and the project/service import YAML, the service catalog and version strings, environment variables and cross-service references, networking and CDN, `zcli`/`zsc`/`zcp`/`zz`, roles and access tokens, autoscaling, storage, backups and the deploy lifecycle. Use whenever the user mentions Zerops, zerops.yaml / zerops.yml, zerops-import.yaml, zcli, zsc, zcp, zz, ZCP_API_KEY, `.zerops.app` subdomains, `buildFromGit`, `deployFiles`, `envSecrets`, `yamlPreprocessor`, `zeropsSubdomainHost`, service types like `postgresql:ha@18` / `php-nginx@8.4` / `object-storage`; whenever the working repository contains a `zerops.yaml`, `zerops.yml`, `zerops-import.yaml` or a `.mcp.json` with a Zerops MCP server; or when asked to deploy, provision, scale, roll back, or debug an app on Zerops.
---

# Zerops

Zerops is a PaaS running on bare metal. You describe infrastructure in **import YAML** and the
build/run pipeline in **`zerops.yaml`**. Both are YAML, both mention services, and they are
**not interchangeable** — confusing them is the single most common failure.

## The two YAML files

| | `zerops.yaml` | import YAML (`zerops-import.yaml`) |
|---|---|---|
| Lives in | **root of your git repository** | anywhere; pasted into GUI or passed to `zcli` |
| Answers | *How is this service built and run?* | *Which services exist, with what resources?* |
| Top-level key | `zerops:` (list of setups) | `project:` and/or `services:` |
| Applied by | every build/deploy | `zcli project project-import` / `service-import`, or GUI import |
| Contains | `build`, `deploy`, `run` | `hostname`, `type`, autoscaling, `envSecrets`, `buildFromGit` |

A service must already exist (via import or GUI) before `zerops.yaml` can target it. The
`setup:` name in `zerops.yaml` matches the service `hostname` unless overridden by
`zeropsSetup` / `--setup`.

## Mental model

**Project** → private VXLAN network + L7 balancer + core (logger, stats, firewall, SSL).
**Service** → one addressable unit, reachable at `<hostname>:<port>` from any sibling.
**Container** → the replicas of a service. Runtimes and Linux containers scale 1–10; managed
services have a fixed count set by the `:single` / `:ha` type variant. Containers are ephemeral
and replaced on every deploy.

Managed services (databases, caches, search, queues, storage) are provisioned, not built.
Runtime services (nodejs, php, go, …) are built from your repo by the pipeline.

**Import is create-only.** Re-importing a file updates nothing, and `override: true` *replaces* a
runtime service and forces a redeploy — so a committed import YAML is a bootstrap script, not a
declaration of state, and it drifts from the first GUI change onwards. Where you want it to behave
like infrastructure-as-code, use `zz apply -f <import.yaml>`: it creates what is missing, converges
the fields the API can change in place, and reports the rest instead of pretending. See
`references/zz-cli.md`.

## Minimal working example

`zerops-import.yaml` — provision once:

```yaml
project:
  name: myapp
  corePackage: LIGHT
services:
  - hostname: app
    type: nodejs@22
    enableSubdomainAccess: true   # .zerops.app subdomain — dev/testing only
    minContainers: 1
    maxContainers: 2
  - hostname: db
    type: postgresql:single@18
    profile: oltp-hobby
```

`zerops.yaml` — committed to the repo root:

```yaml
zerops:
  - setup: app
    build:
      base: nodejs@22
      buildCommands:
        - npm ci
        - npm run build
      deployFiles:            # the whole runtime filesystem, not just build output
        - ./dist
        - ./package.json
        - ./node_modules      # omit only if the build bundles dependencies
      cache: node_modules
    run:
      base: nodejs@22
      ports:
        - port: 3000
          httpSupport: true
      envVariables:
        DATABASE_URL: ${db_connectionString}
      start: node dist/server.js
```

Then `zcli push`.

Webserver runtimes (`php-apache`, `php-nginx`, `nginx`, `static`) are shaped differently — no
`start`, no `ports`. See `references/zerops-yaml.md`.

## Rules that break apps when ignored

1. **Bind `0.0.0.0`**, never `127.0.0.1`/`localhost` — the #1 cause of 502 from the balancer.
2. **Internal HTTP is plain `http://`** — TLS terminates at the L7 balancer, so `https://api:3000`
   fails. This is about HTTP between services; non-HTTP protocols just connect to `hostname:port`
   with their own TLS rules (Postgres `5432` plaintext but `6432` TLS-required, Valkey `6379`
   plaintext / `6380` TLS).
3. **Cross-service env vars are NOT auto-injected.** Under the default `envIsolation: service` you
   must declare `DB_HOST: ${db_hostname}` in `run.envVariables`. An unresolved `${...}` reaches
   the process as a literal string — no error, no blank.
4. **Never write `FOO: ${FOO}`** (same name both sides) — it self-shadows and resolves to the literal
   `${FOO}`. Project variables are already inherited; just read them.
5. **The container filesystem is replaced on every deploy.** Restarts keep it; deploys and scale-ups
   do not. Uploads → object storage, sessions → Valkey.
6. **`build.deployFiles` is the entire runtime filesystem**, not a list of build outputs. Nothing
   reinstalls dependencies at runtime — an unbundled app must ship `node_modules` / `vendor` and its
   manifest too.
7. **Each command list item runs in its own shell.** `cd` and `export` do not carry to the next item;
   use a `|` block scalar when they must.
8. **`run.initCommands` run on every container start, in parallel across containers**, and a
   non-zero exit aborts the deploy. Gate once-per-version work with
   `zsc execOnce ${ZEROPS_appVersionId} -- <cmd>`.
9. **HA is immutable.** `postgresql:single@18` → `postgresql:ha@18` is a new service, not an edit —
   back up and migrate the data first (`references/operations.md`).

## Where to look

Read only the file you need.

| Task | File |
|---|---|
| Write or fix `zerops.yaml`; build/run/deploy keys, webserver vs process runtimes, cron, health checks, `extends`, `envReplace`, static routing, PHP/FPM tuning | `references/zerops-yaml.md` |
| Provision or export projects/services; autoscaling fields, `envSecrets`, `buildFromGit`, `yamlPreprocessor` functions | `references/import-yaml.md` |
| Pick a service type or version string; per-service generated env vars, ports, connection strings, DB admin access | `references/service-catalog.md` |
| Env var scopes, isolation, precedence, build/runtime bridging, secrets, rotating a credential | `references/env-variables.md` |
| Hostnames, ports, subdomains, custom domains, L7 balancer, CDN, firewall and outbound ports, VPN, SSH and the web terminal, local development, 502 debugging | `references/networking.md` |
| `zcli` commands and config; what `zcli` cannot do and the REST API; roles, project access and integration tokens; `zsc` in-container commands — run once across HA (`execOnce`), keep a container alive (`noop`), debug-mode control, temporary scaling, backups | `references/cli.md` |
| The `zcp` MCP server: tools, remote vs local setup, `ZCP_API_KEY`, generating a local `.env`, the production boundary — and the day-2 operations it covers that `zcli` has no command for | `references/zcp-mcp.md` |
| `zz`, the complete agent-first CLI in `cli/`: full API coverage, output contract and exit codes, waiting on async operations, `zz apply` for convergence, git-push builds, routing edits, CDN, access tokens, project and service configuration, the `zz api` passthrough, and the platform gotchas its help text cannot state | `references/zz-cli.md` |
| Build phase, cache, runtime-prepare images, deploy strategy, readiness vs health checks, debug mode, CI/CD and repository integration, preview environments, diagnosing a failed build or deploy | `references/pipeline.md` |
| Autoscaling and changing it on a live service, storage, backup and restore, HA migration, logging, observability, production checklist | `references/operations.md` |

Version tables in `references/service-catalog.md` are generated — refresh with
`scripts/sync-docs.sh` (`--check` to inspect drift first).

## Editor validation

Both files have official JSON Schemas, auto-applied via SchemaStore when named
`zerops.yaml` / `zerops.yml` and `zerops-import.yaml` / `zerops-*-import.yaml`. URLs and the
modeline for non-standard filenames are in `references/zerops-yaml.md` and
`references/import-yaml.md`. Prefer schema validation in the editor over guessing key names.

`zz schema zerops` and `zz schema import` print the same schemas from the live API, which is the
way to read one before writing either file rather than guessing. For `zerops.yaml`,
`zz validate -S <service>` is the stronger check — it also resolves the target service's type and
version, which a schema cannot.

## Verification loop

Never claim a deploy works without evidence:

```sh
zcli push                                   # build + deploy, streams the build log
zcli service log -S <service-id> --follow   # runtime log
zcli service log -S <service-id> --show-build-logs
zcli service log -S <service-id> --message-type WEBSERVER   # 502s on nginx/apache runtimes
```

With `zz` (`references/zz-cli.md`) the same loop is exit-code driven, which is what you want when
scripting it: `zz push api` exits **8** if the build or deploy failed and **7** if it is still
running, so no log parsing is needed to decide what happened.

```sh
zz push api                                 # waits; exit 8 = failed, 7 = still running
zz logs api --build                         # why it failed
zz status                                   # project-wide state in one call
```

Then reach the app. Internally from any sibling or over the VPN — this always works and does not
depend on public access being configured:

```sh
curl -sS http://app:3000/health
```

Publicly, the subdomain is `{hostname}-{prefix}[-{port}].{rest}`, e.g.
`https://app-1df2-3000.prg1.zerops.app`. Do not compose it from memory — read the real value from
the GUI or `zcli project env`, because the port suffix and region segment vary. See
`references/networking.md`.

With the `zcp` MCP server connected, `zerops_verify` does the health + readiness probe and
`zerops_events` the deploy history — same evidence, fewer steps. See `references/zcp-mcp.md`.

Build has a hard **60-minute** limit. `stack.build` reaching `FINISHED` means the build is done;
the deploy is done when the new appVersion is `ACTIVE`. **Neither proves the app does what was
asked** — a green build means Zerops accepted it, reachability means the process is up. Check the
actual behavior.

That is not a platitude. Verified live: a `zerops.yaml` whose `start` was `sleep 3600` validated,
built, deployed and reported `ACTIVE` exactly like the real one — the only symptom was a 502. And a
deployment can serve `/healthz` 200, serve its admin page, and still refuse every browser sign-in,
because TLS terminates at the balancer and the app compares the `Origin` header against its own
internal `http` scheme. **Exercise the behaviour you care about**, including one authenticated
request, before calling a deploy done.
