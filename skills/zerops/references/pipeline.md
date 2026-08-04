# Build & deploy pipeline

## Contents

- [Triggering a pipeline](#triggering-a-pipeline)
- [Build phase](#build-phase)
- [Build cache](#build-cache)
- [Runtime prepare phase](#runtime-prepare-phase)
- [Deploy phase](#deploy-phase)
- [Readiness and health checks](#readiness-and-health-checks)
- [Event timeline](#event-timeline)
- [Application versions](#application-versions)
- [CI/CD](#cicd)
- [Debugging a failed pipeline](#debugging-a-failed-pipeline)

## Triggering a pipeline

| Method | How |
|---|---|
| Continuous deployment | Connect a GitHub/GitLab repo in *Pipelines & CI/CD settings*, or `zops repo connect <owner/name> <service> --branch main`. Trigger on push to a branch or on a new tag (optional regex filter). |
| On demand, CLI | `zcli service push` / `zops push` (build + deploy), or `zcli service deploy` / `zops deploy` (deploy only) |
| On demand, from the connected repo | `zops repo build <service>` — rebuilds the repository head without a push |
| On demand, GUI | *Pipelines & CI/CD settings* → **Re-deploy last pipeline** or **Trigger new pipeline** |
| One-time at import | `buildFromGit: <public-repo-url>` in the import YAML |
| Any Git URL, no webhook | `zops pipeline trigger <service> --from-git <url>` — the same mechanism as `buildFromGit`, on demand |

Add `[ci skip]` or `[skip ci]` (with brackets, case-insensitive) to a commit message to suppress a
webhook build.

## Build phase

A temporary build container is created and destroyed afterwards, regardless of outcome.

1. **Container creation** — from `build.base` + `build.os` (default Alpine).
2. **Source download** — from GitHub, GitLab, or the `zcli` upload, into `/var/www`.
3. **Cache restoration** — cached files moved into `/build/source`, **no-clobber: repository files
   win**.
4. **`prepareCommands`** — extra tooling; skipped when the base-layer cache is valid.
5. **`buildCommands`** — the actual build, in `/build/source`.
6. **Artifact upload** — files matching `deployFiles` stored internally.
7. **Cache preservation** — files matching `cache:` moved to `/build/cache`.
8. **Container deletion.**

### Limits

| Resource | Min | Max |
|---|---|---|
| CPU cores | 1 | 5 |
| RAM | 8 GB | 8 GB (fixed) |
| Disk | 1 GB | 100 GB |

Build containers start small and scale up automatically. They are **not charged separately** —
covered by the project fee. The whole pipeline has a hard **60-minute** limit with no retry.

### Command semantics

- Exit `0` continues; any non-zero exit cancels the build.
- **Each YAML list item is a separate shell.** Use a `|` block scalar when commands must share
  environment or working directory.
- Cancellation is only possible before the build finishes; once the artifact is uploaded the deploy
  cannot be cancelled.

## Build cache

Two layers:

| Layer | Contains | Valid while |
|---|---|---|
| Base | OS, packages, `prepareCommands` output | `prepareCommands` unchanged |
| Build | files listed in `cache:` after `buildCommands` | cache config unchanged |

The layers are **coupled** — invalidating the base layer also invalidates the build layer.

Any change to `build.os`, `build.base`, `build.prepareCommands` or `build.cache` invalidates both.
Adding `vim` to `prepareCommands` throws away your cached `node_modules`.

Manual invalidation: GUI → service → *Pipelines & CI/CD Settings* → **Invalidate build cache**.
Restoring an archived app version also invalidates the cache.

Recommended `cache:` values:

| Runtime | Cache |
|---|---|
| Node.js / Bun | `[node_modules, .next, .turbo, package-lock.json]` |
| PHP | `[vendor, composer.lock]` |
| Rust | `target` |
| Go | `cache: true` (modules live outside `/build/source`) |
| Python | `cache: true` (pip installs globally) or `.venv` |
| Java | `cache: true` (`.m2` outside `/build/source`) |
| .NET | `cache: true` (NuGet outside `/build/source`) |

Cache lock files alongside dependency directories so installs stay reproducible.

## Runtime prepare phase

Optional. Runs after build, before deploy, whenever `run.prepareCommands` is defined. Produces a
**custom runtime image** with extra system packages.

1. Prepare container created from `run.os` + `run.base`.
2. Files from `build.addToRunPrepare` copied to `/home/zerops/`.
3. `run.prepareCommands` executed in order.
4. Container snapshotted as the runtime image.
5. Image cached for subsequent deploys.

The image is reused unless it is the first deploy, or `run.os` / `run.base` /
`run.prepareCommands` / the contents of `build.addToRunPrepare` changed, or the cache was cleared
manually (*Pipelines & CI/CD settings* → **Clear runtime prepare image**).

Use it for: system libraries (`sudo apk add imagemagick`), C-extension dependencies, system tools.

**Do not** put application code in the runtime image — deploy files arrive separately. Shared
storage is not mounted during this phase.

## Deploy phase

Per container:

1. Install the runtime (base or custom image).
2. Download the artifact into `/var/www`.
3. Run `run.initCommands`.
4. Run the start command.
5. Pass the readiness check, if configured.
6. Container becomes active and receives traffic.

Containers deploy **in parallel**.

**Subsequent deploys** start the same number of new containers as currently exist; both versions
run briefly; old containers are then removed from the balancer, their processes terminated, and
the containers deleted. That is the default zero-downtime rolling deploy
(`deploy.temporaryShutdown: false`).

Set `temporaryShutdown: true` only when two versions genuinely cannot coexist — exclusive schema
migrations, singleton locks. It causes downtime.

Rolling cutover is zero-downtime at any `minContainers` value; replica count and deploy strategy
are separate concerns.

## Readiness and health checks

`deploy.readinessCheck` gates traffic during a deploy; `run.healthCheck` monitors the live app
continuously. Parameters, timeout semantics and failure behavior:
[`zerops-yaml.md`](zerops-yaml.md#health-and-readiness-checks).

Without a health check the balancer cannot route around a degraded container.

## Event timeline

1. `stack.build` process **RUNNING** — build container created.
2. `stack.build` process **FINISHED** — build complete, artifact uploaded. *(Or `FAILED`.)*
3. `appVersion` build event **ACTIVE** — deployed and running. This is the terminal success state.
4. Service status back to **RUNNING**.

Do not keep polling build status after `FINISHED`, and do not confuse `stack.build RUNNING` (build
in progress) with `appVersion ACTIVE` (already deployed). Project-level event lists include old
builds — filter by service hostname and check timestamps.

## Application versions

Zerops keeps the **10 most recent** versions; older ones are deleted automatically.

GUI → service → *Pipelines & CI/CD settings* shows the active version and the archive. Per version
you get the `zerops.yaml` that produced it, the build log, the runtime-prepare log, and a
downloadable artifact.

**Activate** an archived version to roll back: Zerops deploys it and archives the current one.
Environment variables are restored to their state when that version was last active.

## CI/CD

Three levels, in increasing order of control: the native repository connection, a CI job calling
`zcli`, or your own orchestration over the REST API.

### Native repository connection

The zero-config path. GUI → service → **Build, Deploy, Run Pipeline Settings** →
**Connect with a GitHub repository** (or GitLab), authorize, pick the repo, pick the trigger:

| Trigger | Behavior |
|---|---|
| **New tag** | builds on every new tag; optional regex filter. **Recommended for production.** |
| **Push to branch** | builds on every push to the named branch |

The repo needs a valid `zerops.yaml` in its root before this works. Zerops takes full repository
access in order to manage the webhook and pull code, and does not store your source beyond that.
Disconnect with **Stop automatic build trigger**, which removes the webhook and the integration
config.

Headless equivalents (`references/zops-cli.md`):

```sh
zops repo list                                        # also an authorization check
zops repo connect acme/api api --branch main
zops repo connect acme/api api --tag-regex '^v[0-9]'  # the production-grade trigger
zops repo status api                                  # what is connected, and whether it can fire
zops repo disable api --yes                           # stop building on push, keep the config
```

**The OAuth grant is still GUI-only.** `zops repo connect` registers the integration but cannot
authorize Zerops against the forge, so on a fresh account the hook is created and then never
fires — `zops repo status` reports `authorizationRequired: true`. Authorize once in the GUI, and
every later connection is scriptable.

`[ci skip]` / `[skip ci]` in a commit message (with brackets, case-insensitive) suppresses the
build. The webhook still fires and shows as delivered in GitHub — it just does nothing.

Organization repositories may need Zerops granted access separately in the GitHub application
settings.

**This connection is per service.** A monorepo deploying several services needs one connection per
service, and each builds the whole repo with its own `setup:`.

### GitHub Actions

```yaml
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zeropsio/actions@v1.0.2
        with:
          access-token: ${{ secrets.ZEROPS_TOKEN }}
          service-id: ${{ secrets.ZEROPS_SERVICE_ID }}
```

The wrapper action exposes only `access-token` and `service-id` — it **cannot pass `--setup`**. For
a multi-setup `zerops.yaml`, install `zcli` and call it directly.

### GitLab CI

```yaml
deploy:
  stage: deploy
  image: ubuntu:latest
  script:
    - apt-get update && apt-get install -y curl
    - curl -L https://zerops.io/zcli/install.sh | sh
    - zcli login $ZEROPS_TOKEN
    - zcli push --project-id $ZEROPS_PROJECT_ID --service-id $ZEROPS_SERVICE_ID
  only: [main]
```

### Any CI

```sh
curl -L https://zerops.io/zcli/install.sh | sh
zcli login <access-token>
zcli push --project-id <id> --service-id <id> [--setup <name>] [--version-name "$GIT_TAG"]
```

Set `ZEROPS_CLI_TERMINAL_MODE=disabled` in CI. Tokens come from GUI → Settings → Access Token
Management; the service ID from the service URL or its three-dot menu. Scope them per project — see
[`cli.md`](cli.md#roles-and-tokens).

### Preview and per-branch environments

Zerops has no managed preview-environment feature. The documented pattern is to drive **whole
projects** through the REST API from CI: check whether a project exists for the branch or PR, create
it from an import template if not, then deploy into it. Ephemeral projects are torn down with the
branch or PR; permanent stage and production projects only ever get new application code, so their
databases, caches and storage survive every deploy.

`zeropsio/zerops-showcase-deploy` is the reference implementation (GitHub Actions + the REST API, no
`zcli`). It is a repo to fork, not a Zerops-managed service — the Actions minutes and the API calls
are yours.

## Debugging a failed pipeline

1. **Build log** — `zcli service log -S <id> --show-build-logs`, or the pipeline detail in the GUI.
2. **Runtime log** — `zcli service log -S <id> --follow`. On `php-*` and `nginx` services also
   `--message-type WEBSERVER`, where the 502 evidence actually lives.
3. **Runtime-prepare log** — in the pipeline detail, when a custom runtime image is used.
4. **Debug mode** — the supported way to inspect a failing build. GUI → service → *Pipelines &
   CI/CD settings* → set the build phase to **On command fail**, re-run, then connect to the paused
   container and look around; drive it with `zsc debug continue|success|fail`. Remember the paused
   time counts against the 60-minute limit, and disable it afterwards. See
   [`cli.md`](cli.md#zsc-debug-continuesuccessfail).

Common causes:

| Symptom | Cause |
|---|---|
| Build fails immediately, no log, `buildFromGit` used | Private repository, or a `.git` suffix on the URL |
| Build fails ~1 min in, log ends at "downloading your application, source, and unpacking it" | **The uploaded archive could not be unpacked.** Most likely it carries no directory entries — the platform's unpacker does not create parents. See [Silent unpack failures](#silent-unpack-failures) |
| App starts but 502 | Bound to `127.0.0.1` instead of `0.0.0.0`, or a port mismatch with `run.ports`. Full checklist in [`networking.md`](networking.md#502-diagnostic-checklist) |
| `Cannot find module` / missing class at runtime | Dependencies not in `build.deployFiles`, or excluded by `.deployignore` |
| Static site 404s on every route | `deployFiles: ./dist` instead of `dist/~` |
| Deploy never activates, service still `ACTIVE` on old version | `run.initCommands` exited non-zero — **verified live**: the newest appVersion goes `DEPLOY_FAILED` with `activationDate: null` while the *service* and its active (previous) appVersion both still read `ACTIVE`. Diagnose via appVersion, not service status. Also **verified**: a failed init deploy does **not** stream the `initCommands` stdout to the runtime log — only the echoed script — so reproduce the command in a start step or debug mode to see why it failed |
| Cache seems ignored | A repository file shadows the cached path (no-clobber), or a `prepareCommands` change invalidated both layers |
| Env var arrives as literal `${db_x}` | Wrong hostname or variable name in the reference; see `env-variables.md` |

### Silent unpack failures

**Verified live:** a build can fail with **zero diagnostic output**. The log ends at

```
Zerops is now downloading your application,
source, and unpacking it on the container.
```

with no further line at any severity including `DEBUG`, the process record carrying
`status: FAILED` and no message, and the appVersion only saying `BUILD_FAILED`. Nothing names a
cause, so the pipeline has to be bisected:

1. Replace `buildCommands` with `echo` and `deployFiles` with a single file. Still failing means the
   cause is upstream of your commands.
2. Push the identical tree with the *other* CLI (`zcli push` vs `zops push`). If one works, the
   difference is the upload archive, not the repository or `zerops.yaml`.
3. Compare the two archives: `tar -tvzf a.tar.gz | grep -c '^d'`.

The known cause is **an archive with no directory entries**. The platform's unpacker does not create
parents, so it dies on the first file whose directory is missing. GNU tar reads such an archive
happily — it creates parents implicitly — so it looks valid locally. `zcli` writes them (520 for a
2300-file repo); `zops` did not until this was found.

Rule worth carrying: **a tar GNU tar accepts is not proof the receiver accepts it.** When you build
an archive for this platform, assert the directory entries are there.

### Build out of memory

Build RAM is **8 GB fixed** — min equals max, so there is nothing to scale. Options, in order:

1. Raise the runtime's own heap rather than the container: `NODE_OPTIONS: "--max-old-space-size=7168"`
   in `build.envVariables`, or the equivalent JVM `-Xmx`.
2. Cut build parallelism — `make -j1`, Jest/Vite `--max-workers=2`, Turbo `--concurrency=1`.
3. Split the build into sequential steps instead of one parallel monorepo build.
4. Check whether the build only *recently* got heavier because a `prepareCommands` or `cache` change
   invalidated the cache and forced a cold full build.
5. Build elsewhere (CI) and ship the artifacts with `zcli service deploy`, skipping the build phase.
