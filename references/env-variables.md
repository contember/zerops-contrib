# Environment variables

Zerops has no `.env` file at runtime — variables come from the platform. Two scopes (project,
service), two phases (build, runtime), and strict isolation between sibling services.

## Contents

- [Scopes](#scopes)
- [Precedence](#precedence)
- [Cross-service references](#cross-service-references)
- [Isolation modes](#isolation-modes)
- [Project variables are inherited](#project-variables-are-inherited)
- [The self-shadow trap](#the-self-shadow-trap)
- [Build and runtime](#build-and-runtime)
- [Secrets](#secrets)
- [Naming rules](#naming-rules)
- [When changes take effect](#when-changes-take-effect)
- [`envReplace`](#envreplace)
- [Local development](#local-development)

## Scopes

| Scope | Defined in | Visible to | Change without redeploy |
|---|---|---|---|
| Project | import YAML `project.envVariables`, GUI | every service, build **and** runtime | Yes (restart to apply) |
| Service secret | import YAML `envSecrets` / `dotEnvSecrets`, GUI | one service | Yes (restart to apply) |
| Service build | `zerops.yaml` `build.envVariables` | build container only | No — redeploy |
| Service runtime | `zerops.yaml` `run.envVariables` | runtime container only | No — redeploy |
| System-generated | platform | own service; referenceable from siblings | partly (some read-only) |

## Precedence

Highest wins: **system/platform → `run.envVariables` → service secret → project**.

A key declared in `run.envVariables` **owns** that key. Setting a secret with the same name is
rejected with `userDataDuplicateKey` — the two never coexist. To change the value, edit
`zerops.yaml` and redeploy.

Service-level beats project-level. Build and runtime are separate stores; the same key can hold
different values in each.

## Cross-service references

Under the default `envIsolation: service`, a service sees **only** its own variables plus project
variables. Even a managed database's connection variables require an explicit reference:

```yaml
run:
  envVariables:
    DB_HOST: ${db_hostname}
    DB_PASS: ${db_password}
    DATABASE_URL: ${db_connectionString}
    CACHE_URL: ${cache_connectionString}
```

The left-hand key is what your app reads; `${hostname_varname}` is the source.

- References resolve **at container start**, so the target need not exist when you write the YAML.
- An unresolvable reference stays **literal**: the process receives the string `${db_hostname}`.
  No error, no empty value — the app fails later at connect time with a nonsense host.
- Hostnames are lowercase alphanumeric only, so a reference is always the plain hostname plus
  underscore plus variable name. There is no dash-to-underscore rewriting to reason about.

## Isolation modes

| Mode | Behavior |
|---|---|
| `service` (default) | Siblings isolated. Explicit `${hostname_varname}` references required. |
| `none` (legacy) | Every service's variables auto-injected into every container as bare `<host>_KEY`. Broad and ambiguous — avoid. |

Set at project level, overridable per service:

```yaml
project:
  envIsolation: none        # legacy — avoid
services:
  - hostname: db
    envIsolation: none      # expose only THIS service's vars to siblings
```

Explicit references work in **both** modes, so code stays correct if isolation ever changes.
Keep the default.

## Project variables are inherited

Project variables are injected as OS environment variables into every container, build and runtime.

- From application code: read them directly (`process.env.API_URL`).
- From shell commands (`buildCommands`, `initCommands`, `start`): `$API_URL` works.
- From `zerops.yaml` YAML, to forward one under a framework-conventional name: `${API_URL}` with
  **no prefix**.

```yaml
build:
  buildCommands:
    - VITE_API_URL=$API_URL npm run build
  envVariables:
    VITE_API_URL: ${API_URL}
run:
  envVariables:
    CORS_ALLOWED_ORIGIN: ${FRONTEND_URL}
    LOG_LEVEL: debug          # overrides the project-level value for this service
```

A common pattern for a frontend + API pair is project-level URL constants derived from the
platform-generated `zeropsSubdomainHost`:

```yaml
project:
  envVariables:
    API_URL: https://apistage-${zeropsSubdomainHost}-3000.prg1.zerops.app
    FRONTEND_URL: https://appstage-${zeropsSubdomainHost}.prg1.zerops.app
```

## The self-shadow trap

```yaml
run:
  envVariables:
    API_URL: ${API_URL}            # WRONG — project-level self-shadow
    db_hostname: ${db_hostname}    # WRONG — cross-service self-shadow
```

The interpolator finds the service-level variable of that name first, cannot recurse back to the
inherited value, and the container ends up with the literal string `${API_URL}`.

- Reading a project variable → delete the line, it is already there.
- Reading a sibling's variable → use a **different** left-hand name (`DB_HOST: ${db_hostname}`).

## Build and runtime

Build and runtime are separate containers with separate variable stores.

| Want | From | How |
|---|---|---|
| Runtime var `API_KEY` | build container | `${RUNTIME_API_KEY}` — runtime `run.envVariables` are known at build time |
| Build var `BUILD_ID` | runtime container | **Not possible.** The build container is destroyed and its variables are not carried over; `${BUILD_BUILD_ID}` arrives as a literal string. Write the value into a deployed file, or recompute at runtime. |

```yaml
build:
  envVariables:
    API_KEY: ${RUNTIME_API_KEY}
run:
  envVariables:
    API_KEY: "12345-abcde"
```

Note the `RUNTIME_` prefix is only for lifting a service's *own* runtime variable into its build
context. It is never used for project variables.

## Secrets

- Defined via import YAML `envSecrets` / `dotEnvSecrets`, or the GUI (individually or with the bulk
  `.env`-format editor).
- Masked in the GUI. Via the API an admin/write token returns the value; a read-only token gets
  `REDACTED`. Inside the container the value is plaintext — the app needs it.
- Editable without a redeploy; the service must be **restarted** to pick up the new value.
- Generate them at import time with the [YAML preprocessor](import-yaml.md#yaml-preprocessor)
  rather than committing them.
- `zsc setSecretEnv <key> <value>` updates one from inside a container (`-` reads stdin).

```yaml
services:
  - hostname: app
    envSecrets:
      SECRET_KEY: <@generateRandomString(<32>)>
    dotEnvSecrets: |
      APP_KEY=<@generateRandomString(<32>)>
      DB_PASSWORD=secure123
```

## Naming rules

- **Key**: must match `[a-zA-Z_]+[a-zA-Z0-9_]*`. Case-sensitive, but must be unique within a scope
  regardless of case.
- **Value**: ASCII only, no EOL characters. (Multi-line PEM values are handled by the preprocessor
  with `|` block scalars.)

## When changes take effect

| Changed | Needed |
|---|---|
| Secret or project variable | Service **restart** (not reload) |
| `run.envVariables` in `zerops.yaml` | Full **redeploy** — baked into the app version |

An env-store change reaches the container in ~5–10 s, but a **running process keeps its boot-time
environment**. Only newly spawned processes see the new value. Reload is not enough — PHP-FPM in
particular keeps its boot config.

Restoring an archived app version also restores the variables to their state when that version was
last active.

## `envReplace`

For files that cannot read environment variables (PEM keys, static frontend configs), substitute at
deploy time — see [`zerops-yaml.md`](zerops-yaml.md#envreplace). Directory targets are not
recursive.

## Local development

Environment variables are **not** available over the VPN — the VPN gives network reachability, not
the env store. Copy access details from the GUI, or generate a local `.env`. Add `.env` to
`.gitignore` immediately.

`${hostname_varname}` references are resolved by Zerops at container start regardless of whether
the push came from your laptop or from CI, so one `zerops.yaml` works everywhere.
