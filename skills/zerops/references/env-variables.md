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
- [Rotating a credential](#rotating-a-credential)
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

`envIsolation` is a space-separated list of rules. **It is owner-side**: a service's own rules
decide who sees *its* variables. The reader's rules are never consulted, so a service cannot grant
itself access to a sibling's secrets.

| Rule | Behavior |
|---|---|
| `service` (default) | Nobody else sees this service's variables. Explicit `${hostname_varname}` references required. |
| `none` | Every service sees them as bare `<host>_KEY`. Broad — prefer a grant. |
| `service@name` | Service `name` additionally sees them as bare `<host>_KEY`. |
| `-service@name` | Service `name` never sees them, even with `none`. |

For reader R against owner O: `-service@R` → hidden, else `service@R` → visible, else `none` →
visible, else hidden. A service always sees its own variables.

Set at project level; a service-level value **replaces** the project value (no merge):

```yaml
project:
  envIsolation: service@zcp          # the zcp service sees every service inheriting this
services:
  - hostname: db
    envIsolation: none               # everyone sees db's variables
  - hostname: api
    envIsolation: service            # opts out of the project grant — not even zcp sees api
  - hostname: cache
    envIsolation: none -service@api  # everyone except api
```

In import YAML it may also be nested under `envVariables` / `envSecrets` (the nested one wins).

Explicit references work in **every** mode, so code stays correct if isolation ever changes.
Keep the default; when one tooling or admin service needs broad read access, grant it with
`service@<hostname>` at project level rather than switching to `none`.

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

**Verified live it is worse than "resolves to a literal":** the self-shadowed variable **disappears
from the container environment entirely** — it is not present as `${API_URL}` and not present with a
value, it is simply absent. Code reading it gets undefined, not a wrong-looking string.

- Reading a project variable → delete the line, it is already there.
- Reading a sibling's variable → use a **different** left-hand name (`DB_HOST: ${db_hostname}`).

**Escape hatch (undocumented, verified live):** every project variable is also injected under a
`PROJECT_` prefix — `PROJECT_API_URL`, `PROJECT_staticCdnUrl`, etc. — and that copy is **not**
shadowed by a service-level variable of the bare name. So `PROJECT_API_URL` still holds the real
value even after `API_URL: ${API_URL}` has nuked `API_URL`. Useful as a recovery read; still, the
right fix is to not self-shadow in the first place.

## Build and runtime

Build and runtime are separate containers with separate variable stores.

| Want | From | How |
|---|---|---|
| Runtime var `API_KEY` | build container | `${RUNTIME_API_KEY}` — runtime `run.envVariables` are known at build time |
| Build var `BUILD_ID` | runtime container | **Does not work in practice.** The build container is destroyed and its variables are not carried into the runtime store; `${BUILD_BUILD_ID}` arrives as a literal string. (The older reference page documents a `BUILD_` prefix for this; the newer guide says it does not work — do not rely on it.) Write the value into a deployed file, or recompute at runtime. |

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
- Masked in the GUI. Through the API a read-only token gets `REDACTED`; verified live (2026-10),
  a full-access personal token still gets plaintext from the service env list endpoints
  (`zops env list` / `env show`). The API also has dedicated decrypted reads that require
  **sudo mode** (`GET /user-data/{id}/reveal`, `/project-env/{id}/reveal`,
  `GET /project/{id}/project-env/env-file`), and Zerops' own `zbox` CLI enters sudo before reading
  a sensitive value — so if a list read starts returning `REDACTED`, this is the way back.
  Inside the container the value is plaintext — the app needs it.
- Editable without a redeploy; the service must be **restarted** to pick up the new value.
- Generate them at import time with the [YAML preprocessor](import-yaml.md#yaml-preprocessor)
  rather than committing them.
- `zsc setSecretEnv <key> <value>` updates one from inside a container (`-` reads stdin).

**Security note — the container environment holds platform private keys.** Verified live, the
build **and** runtime environment include `ZEROPS_VpnPrivateKey` (the WireGuard key), plus
`ZEROPS_CertKey` / `ZEROPS_CertCrt` (an RSA private key and the service's internal mTLS identity).
Consequences for how you write pipelines:

- **Never dump the full environment to logs or an external service.** `env | …`, error reporters
  that attach `process.env`, and debug endpoints that echo the environment will leak these keys.
- The build phase runs third-party dependency code (`npm`/`composer` postinstall) with these keys
  present, and build egress on 443 is open — a compromised dependency can exfiltrate them. Pin and
  audit build dependencies; prefer lockfiles and `--ignore-scripts` where the toolchain allows.
- Read only the specific variables your app needs; do not forward the whole environment to child
  processes or subrequests.

```yaml
services:
  - hostname: app
    envSecrets:
      SECRET_KEY: <@generateRandomString(<32>)>
    dotEnvSecrets: |
      APP_KEY=<@generateRandomString(<32>)>
      DB_PASSWORD=secure123
```

## Reading variables back

The endpoint behind `zops env list` / the API's `ListServiceStackUserData` covers **only variables
stored on the service** — `envSecrets` and anything set in the GUI. Two verified surprises:

- **Before the first deploy it answers `400 serviceStackNotFound`**, even though the service plainly
  exists and the import just wrote secrets into it. The error names the wrong cause: the stack is
  found, its variables simply are not readable yet. Treat it as "cannot check yet", not as a missing
  service — a reconciler that fails here fails on every fresh environment.
- **`run.envVariables` never appear there at all**, before or after a deploy. They are baked into the
  app version rather than stored as service user-data, so the endpoint has nothing to return.

`zops env show` is the one that answers "what does the process actually see" — the resolved
environment, generated variables included. Reach for it when debugging; `env list` only ever tells
you what is *set on the service*.

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
environment**. Only newly spawned processes see the new value. A *reload* is not enough — it does
not re-read the environment, and PHP-FPM in particular keeps its boot config. (The older reference
page says "reload"; the newer guide says restart, and restart is what actually works.)

**There is no `zcli service restart`.** Use the GUI's Restart action, or `zcli service stop` then
`zcli service start`. With `minContainers: 1` that is a hard outage — see the rotation recipe below.

Restoring an archived app version also restores the variables to their state when that version was
last active.

## Rotating a credential

A restart is not zero-downtime on a single-container service, and a database password lives in two
places that do not synchronise. Sequence for a live rotation:

**Application secret (API key, signing key)**

1. Add the new value under a **new key** (`API_KEY_NEXT`) in `envSecrets`.
2. Deploy code that accepts either key.
3. Move the new value onto `API_KEY`, restart, verify.
4. Remove `API_KEY_NEXT`.

**Database password**

1. Ensure `minContainers: 2` or accept the outage.
2. `ALTER USER db WITH PASSWORD '<new>'` in the database.
3. Update the `password` env variable on the **database** service — changing it in the database does
   not update the variable, and `connectionString` is derived from it.
4. Restart the consuming services so they pick up the new value.

Verify from inside a container (`zcli project env --service app`, or read the process environment);
the API returns stored templates, not resolved values.

## `envReplace`

For files that cannot read environment variables (PEM keys, static frontend configs), substitute at
deploy time — see [`zerops-yaml.md`](zerops-yaml.md#envreplace). Directory targets are not
recursive.

## Local development

Environment variables are **not** available over the VPN — the VPN gives network reachability, not
the env store. Two ways to bridge the gap:

1. **Generate a local `.env`** with `zcp` (`zerops_env action="generate-dotenv"`). It merges project
   `envVariables`, `zerops.yaml` `run.envVariables` and `.env.local`, resolving `${db_password}`-style
   references recursively into real values — see [`zcp-mcp.md`](zcp-mcp.md#generating-a-local-env).
   Put manual overrides in `.env.local`, not in `.env`; the next generation refuses with a diff when
   it finds keys it did not write.
2. **Copy access details from the GUI** (service detail → *Peek access details*).

Either way `.env` goes into `.gitignore` immediately, and it is a snapshot rather than a live sync —
regenerate it after changing anything in Zerops.

The three access paths (VPN, Cloud IDE, native IDE over SSH) are in
[`networking.md`](networking.md#local-development).

`${hostname_varname}` references are resolved by Zerops at container start regardless of whether
the push came from your laptop or from CI, so one `zerops.yaml` works everywhere.
