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
| Continuous deployment | Connect a GitHub/GitLab repo in *Pipelines & CI/CD settings*. Trigger on push to a branch or on a new tag (optional regex filter). |
| On demand, CLI | `zcli service push` (build + deploy) or `zcli service deploy` (deploy only) |
| On demand, GUI | *Pipelines & CI/CD settings* → **Re-deploy last pipeline** or **Trigger new pipeline** |
| One-time at import | `buildFromGit: <public-repo-url>` in the import YAML |

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

Full parameter reference in [`zerops-yaml.md`](zerops-yaml.md#health-and-readiness-checks).

- **`deploy.readinessCheck`** gates traffic during a deploy. Sequence: `start` runs → check runs →
  on failure wait `retryPeriod` and retry → on success the container goes active. After
  `failureTimeout` the container is deleted and the deploy fails; the previous version keeps
  serving. Overall retry window is 5 minutes.
- **`run.healthCheck`** monitors the live app. Failures → `disconnectTimeout` removes the container
  from the balancer → `failureTimeout` restarts it → `recoveryTimeout` gates its return.

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
Management; the service ID from the service URL or its three-dot menu.

## Debugging a failed pipeline

1. **Build log** — `zcli service log -S <id> --show-build-logs`, or the pipeline detail in the GUI.
2. **Runtime log** — `zcli service log -S <id> --follow`.
3. **Runtime-prepare log** — in the pipeline detail, when a custom runtime image is used.
4. Add `zsc noop` as a build command to keep the container alive for inspection.

Common causes:

| Symptom | Cause |
|---|---|
| Build fails immediately, no log, `buildFromGit` used | Private repository, or a `.git` suffix on the URL |
| App starts but 502 | Bound to `127.0.0.1` instead of `0.0.0.0`, or a port mismatch with `run.ports` |
| Files missing at runtime | Not listed in `build.deployFiles`, or excluded by `.deployignore` |
| Deploy never activates, service still `ACTIVE` on old version | `run.initCommands` exited non-zero — check `appVersion.status` = `DEPLOY_FAILED` and a null `activationDate`, not the service status |
| Cache seems ignored | A repository file shadows the cached path (no-clobber), or a `prepareCommands` change invalidated both layers |
| Env var arrives as literal `${db_x}` | Wrong hostname or variable name in the reference; see `env-variables.md` |
