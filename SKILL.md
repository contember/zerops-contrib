---
name: zerops
description: Build, configure, deploy and operate applications on Zerops (zerops.io) — a bare-metal PaaS. Covers the two YAML files (`zerops.yaml` build/run pipeline in the repo, and the project/service import YAML), the service catalog and version strings, environment variables and cross-service references, private/public networking, the `zcli` CLI and in-container `zsc` utility, autoscaling, storage, and the build & deploy lifecycle. Use whenever the user mentions Zerops, zerops.yaml / zerops.yml, zerops-import.yaml, zcli, zsc, `.zerops.app` subdomains, `buildFromGit`, `deployFiles`, `envSecrets`, `yamlPreprocessor`, `zeropsSubdomainHost`, service types like `postgresql:ha@18` / `php-nginx@8.4` / `object-storage`, or asks to deploy, provision, scale, or debug an app on Zerops.
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
**Service** → one addressable unit, reachable at `http://<hostname>:<port>` from any sibling.
**Container** → 1..10 replicas of a service; ephemeral, replaced on every deploy.

Managed services (databases, caches, search, queues, storage) are provisioned, not built.
Runtime services (nodejs, php, go, …) are built from your repo by the pipeline.

## Minimal working example

`zerops-import.yaml` — provision once:

```yaml
project:
  name: myapp
  corePackage: LIGHT
services:
  - hostname: app
    type: nodejs@22
    enableSubdomainAccess: true
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
      deployFiles: ./dist
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

## Rules that break apps when ignored

1. **Bind `0.0.0.0`**, never `127.0.0.1`/`localhost` — the #1 cause of 502 from the balancer.
2. **Internal traffic is plain `http://`** — TLS terminates at the L7 balancer. `https://api:3000` fails.
3. **Cross-service env vars are NOT auto-injected.** Under the default `envIsolation: service` you
   must declare `DB_HOST: ${db_hostname}` in `run.envVariables`. An unresolved `${...}` reaches
   the process as a literal string — no error, no blank.
4. **Never write `FOO: ${FOO}`** (same name both sides) — it self-shadows and resolves to the literal
   `${FOO}`. Project variables are already inherited; just read them.
5. **The container filesystem is replaced on every deploy.** Restarts keep it; deploys and scale-ups
   do not. Uploads → object storage, sessions → Valkey.
6. **`build.deployFiles` decides what reaches `/var/www`.** Anything omitted is gone at runtime.
7. **HA is immutable.** `postgresql:single@18` → `postgresql:ha@18` requires delete + recreate.
8. **`run.initCommands` run on every container start** and a non-zero exit aborts the deploy.
   Keep them idempotent.

## Where to look

Read only the file you need.

| Task | File |
|---|---|
| Write or fix `zerops.yaml`; build/run/deploy keys, cron, health checks, `extends`, `envReplace`, static routing | `references/zerops-yaml.md` |
| Provision or export projects/services; autoscaling fields, `envSecrets`, `buildFromGit`, `yamlPreprocessor` functions | `references/import-yaml.md` |
| Pick a service type or version string; per-service generated env vars, ports, connection strings | `references/service-catalog.md` |
| Env var scopes, isolation, precedence, build↔runtime bridging, secrets | `references/env-variables.md` |
| Hostnames, ports, subdomains, custom domains, L7 balancer, firewall, VPN/SSH, 502 debugging | `references/networking.md` |
| `zcli` commands and config; `zsc` in-container commands | `references/cli.md` |
| Build phase, cache, runtime-prepare images, deploy strategy, readiness vs health checks, CI/CD | `references/pipeline.md` |
| Autoscaling, storage, backups, logging, metrics, production checklist | `references/operations.md` |

## Editor validation

Both files have official JSON Schemas, auto-applied via SchemaStore when named
`zerops.yaml` / `zerops.yml` and `zerops-import.yaml` / `zerops-*-import.yaml`:

```
https://api.app-prg1.zerops.io/api/rest/public/settings/zerops-yml-json-schema.json
https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json
```

Add a `# yaml-language-server: $schema=<url>` modeline for non-standard filenames. Prefer schema
validation in the editor over guessing key names.

## Verification loop

Never claim a deploy works without evidence:

```sh
zcli push                                   # build + deploy, streams the build log
zcli service log -S <service-id> --follow   # runtime log
zcli service log -S <service-id> --show-build-logs
curl -sS https://<hostname>-<subdomainHost>.zerops.app/health   # or http://<hostname>:<port> from a sibling
```

Build has a hard **60-minute** limit. `stack.build` reaching `FINISHED` means the build is done;
the deploy is done when the new appVersion is `ACTIVE`.

## Keeping this skill current

`scripts/sync-docs.sh` pulls `github.com/zeropsio/docs`, regenerates the version tables in
`references/service-catalog.md` from upstream `data.json`, and lists which upstream pages changed
since the last sync so the prose can be reviewed. Run `scripts/sync-docs.sh --check` to see drift
without writing anything.
