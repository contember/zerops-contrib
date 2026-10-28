# Import YAML reference

Infrastructure-as-code for Zerops: defines **which project and services exist** and how they are
sized. Not the build pipeline — that is `zerops.yaml`.

Schema: `https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json`
(auto-applied by SchemaStore to `zerops-import.yaml` / `zerops-*-import.yaml`).

## Contents

- [How to apply it](#how-to-apply-it)
- [`project`](#project)
- [`services`](#services)
- [Vertical autoscaling](#vertical-autoscaling)
- [Horizontal scaling](#horizontal-scaling)
- [Storage: no mounts in import](#storage-no-mounts-in-import)
- [Object storage](#object-storage)
- [Embedding `zerops.yaml`](#embedding-zeropsyaml)
- [Export](#export)
- [YAML preprocessor](#yaml-preprocessor)
- [Preprocessor functions](#preprocessor-functions)
- [Preprocessor modifiers](#preprocessor-modifiers)
- [Gotchas](#gotchas)

## How to apply it

```sh
zcli project project-import <file>   # creates a new project + its services
zcli project service-import <file>   # adds services to the current project scope
```

GUI: **Import a project** in the Projects list, or **Import services** on a project detail page.

A file with only `services:` needs an existing project. A file with `project:` creates a new one —
project names are not unique, so repeated imports create duplicates.

## `project`

```yaml
project:
  name: myapp                 # required
  description: "Example"
  corePackage: LIGHT          # LIGHT (default) | SERIOUS
  tags: [dev, test]
  envVariables:               # inherited by every service, build and runtime
    LOG_LEVEL: info
    API_URL: https://apistage-${zeropsSubdomainHost}-3000.prg1.zerops.app
  envIsolation: service       # service (default) | none (legacy)
```

| Field | Type | Notes |
|---|---|---|
| `name` | string, required | Duplicates allowed. |
| `description` | string | |
| `corePackage` | enum | `LIGHT` (single-container core) or `SERIOUS` (HA multi-container core). **Upgradeable but not downgradeable**; the upgrade is partially destructive — logs and statistics are lost, ~35 s network outage, $10 fee. |
| `tags` | list of strings | Filtering only. |
| `envVariables` | map | Project-scope variables, automatically available in every service. Do not reference them with `${...}` from a service — just read them. Marked deprecated in the live schema in favour of `vault`. |
| `envSecrets` | map | Sensitive project variables. Deprecated in favour of `vault`. |
| `vault` | map | The live schema's replacement for both maps above: `KEY: value`, or `KEY: {value: …, sensitive: true}`. Not yet in the upstream reference — `envVariables`/`envSecrets` still work. |
| `sharedIpv4` | bool | Whether the project domain gets an A record to the shared IPv4 (AAAA always). Ignored once the project has a dedicated IPv4. |
| `envIsolation` | enum | `service` (default, siblings isolated) or `none` (legacy, all vars auto-injected). |

`zeropsSubdomainHost` is a platform-generated project variable available from project creation —
useful for composing cross-service URLs in `project.envVariables`.

## `services`

```yaml
services:
  - hostname: app             # required
    type: nodejs@22           # required
    priority: 10
    enableSubdomainAccess: true
    startWithoutCode: false
    override: false
    envSecrets:
      SECRET_KEY: <@generateRandomString(<32>)>
    dotEnvSecrets: |
      APP_KEY=<@generateRandomString(<32>)>
      DB_PASSWORD=secure123
    envIsolation: service
    buildFromGit: https://github.com/myorg/myapp
```

| Field | Type | Notes |
|---|---|---|
| `hostname` | string, required | Max **25 chars, lowercase `[a-z0-9]` only** — dashes, underscores and uppercase are rejected (`serviceStackNameInvalid`). Unique within the project. |
| `type` | enum, required | Service type + version. See `service-catalog.md`. **Write the OS for runtimes**: `alpine/nodejs@22`, `ubuntu/python@3.12`. The live schema enum lists runtimes *only* in that form; a bare `nodejs@22` is legacy, still accepted, and resolves to **Ubuntu** in import (Alpine as a `zerops.yaml` `base:`). Box Workspace appears as `ubuntu/zbox@1`. |
| `profile` | string | Scaling/tuning preset — PostgreSQL and Valkey only. See `service-catalog.md`. |
| `profileOverrides` | map | Individual engine params. PostgreSQL requires `profile: custom` for these; Valkey accepts them alongside any profile. |
| `mode` | enum | `NON_HA` / `HA`. **Deprecated only where a `:single`/`:ha` type variant exists** (PostgreSQL, MariaDB, ClickHouse, Valkey, SeaweedFS) — there, write the variant. For Elasticsearch, Typesense, Kafka and other services with no variant, `mode: HA` is still the documented and only way to get HA. |
| `envSecrets` | map | Secret variables — masked in the GUI, editable later, no redeploy needed (restart required). Non-secret runtime variables belong in `zerops.yaml` `run.envVariables`. The live schema marks it deprecated in favour of `vault`; it still works. |
| `dotEnvSecrets` | string (multiline) | Same, in `.env` format. |
| `envVariables` / `dotEnvVariables` | map / string | Non-sensitive service variables, editable in the GUI. In the live schema (`envVariables` already marked deprecated for `vault`); not in the upstream reference. |
| `vault` | map | Live-schema replacement for the above: `KEY: value` or `KEY: {value: …, sensitive: true}`. Not yet in the upstream reference. |
| `sshIsolation` | string | SSH access rules, default `vpn`. See [`networking.md`](networking.md#sshisolation). |
| `envIsolation` | enum | Per-service override of the project setting. May also be nested under `envVariables`/`envSecrets`, in which case the nested value wins. |
| `buildFromGit` | URL | One-time build from a **public** GitHub/GitLab repo. A private repo fails at clone with no build log. **No trailing `.git`** — that fails the same way. |
| `startWithoutCode` | bool | Default `false`. `true` starts runtime containers before any deploy — useful for a container to SSH into. Version working setup steps into `run.prepareCommands` afterwards. On Swarm it makes the pool usable before a first deploy. |
| `enableSubdomainAccess` | bool | Default `false`. Enables the `.zerops.app` subdomain. Dev/testing only. |
| `priority` | integer | Higher = created sooner. Use it to bring databases up before the app. |
| `override` | bool | Default `false`. **Runtime services only.** `true` replaces an existing service of the same hostname and triggers a redeploy. |
| `objectStorageSize` | integer | Whole number 1–100 (GB), object-storage only. Changeable in the GUI afterwards. |
| `objectStoragePolicy` | enum | `private` / `public-read` / `public-objects-read` / `public-write` / `public-read-write` / `custom`. |
| `objectStorageRawPolicy` | JSON | Custom S3 policy; `{{ .BucketName }}` placeholder available. |
| `enableCdn` | bool | Object storage only: put the bucket behind the CDN. |
| `zeropsSetup` | string | Which `setup:` from `zerops.yaml` to use. Defaults to the hostname. |
| `zeropsYaml` | object | Inline `zerops.yaml`; used instead of the repo's file. |
| `minContainers` / `maxContainers` | integer | 1–10. Runtimes and Linux containers only. On Swarm they are pool limits for API calls (min may be `0`), not autoscaling bounds — see `service-catalog.md`. |
| `verticalAutoscaling` | object | See below. |
| `os` | string | Deprecated — put the OS in `type`. |

**Removed:** `mount` (shared-storage mounts) fails the import with `yamlMountDeprecated`, and
`nginxConfig` is gone from both the schema and the upstream reference. Neither is accepted any more.

## Vertical autoscaling

```yaml
verticalAutoscaling:
  cpuMode: DEDICATED        # SHARED | DEDICATED
  minCpu: 1
  maxCpu: 4
  startCpuCoreCount: 2      # cores at container start (default 2)
  minRam: 1                 # GB
  maxRam: 8
  minDisk: 1                # GB
  maxDisk: 20
  minFreeCpuCores: 0.5      # 0.0–1.0, DEDICATED only (default 0.1)
  minFreeCpuPercent: 20     # 0–100 (default 0 = disabled)
  minFreeRamGB: 0.5         # default 0.0625 (64 MB)
  minFreeRamPercent: 20     # default 0 = disabled
```

Set min = max on any resource to pin it. See `operations.md` for thresholds, defaults and limits.

## Horizontal scaling

`minContainers` / `maxContainers`, range 1–10. Runtimes and Linux containers only — managed
services have a fixed container count baked into the `:single` / `:ha` type variant.

## Storage: no mounts in import

The import only **creates** storage services; mounting happens in the runtime's `zerops.yaml`:

```yaml
services:
  - hostname: vol
    type: local-storage:single@1   # mounted via run.volume
  - hostname: files
    type: seaweedfs:ha@3.85        # mounted via a weed mount start command
```

- Local storage → `run.volume: {hostname: vol}` in `zerops.yaml`.
- SeaweedFS → a `run.startCommands` entry running `weed mount`, or `zsc shared-storage mount`.
- `shared-storage:single` / `:ha` still import, but create SeaweedFS. The old `mount:` field fails
  with `yamlMountDeprecated`.

Details and trade-offs in [`service-catalog.md`](service-catalog.md#local-storage).

## Object storage

```yaml
services:
  - hostname: storage
    type: object-storage
    objectStorageSize: 2
    objectStoragePolicy: public-read
    priority: 10
```

One bucket per service, auto-named `<prefix>-<hostname>` (random prefix first, e.g.
`4gl2o-storage`), immutable. Need more buckets?
Add more services. Not covered by Zerops backups; no autoscaling.

## Embedding `zerops.yaml`

| `zeropsSetup` | `zeropsYaml` | Behavior |
|---|---|---|
| — | — | Look for `zerops.yaml` in the repo root, find the setup matching the hostname. |
| set | — | Repo `zerops.yaml`, setup named by `zeropsSetup`. |
| — | set | Use the inline YAML, setup matching the hostname. |
| set | set | Use the inline YAML, setup named by `zeropsSetup`. |

If the named setup does not exist, the import fails.

```yaml
services:
  - hostname: app
    type: nodejs@22
    buildFromGit: https://github.com/myorg/myapp
    zeropsSetup: backendapi
    zeropsYaml:
      zerops:
        - setup: backendapi
          build:
            base: nodejs@22
            buildCommands: [npm ci, npm run build]
            deployFiles: ./
            cache: node_modules
          run:
            # execOnce — initCommands run on every container in parallel
            initCommands: [zsc execOnce ${ZEROPS_appVersionId} -- npm run db:migrate]
            start: npm start
```

## Export

GUI → project or service card → three-dot menu → **Export project as yaml** /
**Export service as yaml**. Output is import-compatible; use it to clone environments or to
capture drift back into version control.

## YAML preprocessor

Enable with **`#yamlPreprocessor=on` as the literal first line**. Without it the functions below
are left as plain text.

```yaml
#yamlPreprocessor=on
project:
  name: myapp
services:
  - hostname: app
    type: nodejs@22
    envSecrets:
      SECRET_KEY: <@generateRandomString(<64>)>
```

Processing is two-pass: pass 1 evaluates functions/modifiers into memory, pass 2 creates the
project, services and variables. All functions return **strings**.

### Syntax

| Token | Meaning |
|---|---|
| `<@` … `>` | Function expression |
| `<` … `>` | String expression (spaces are **not** trimmed) |
| `(` `)` `,` | Parameter list and delimiter |
| `\|` | Modifier separator |
| `\` | Escape character; `\<>\|` must be escaped to be printed |

Variable *references* (the argument to `getVar`) are **not** wrapped in `<>`; they are
case-sensitive and surrounding spaces are trimmed.

Because both passes process escapes, printing a single backslash requires four: `<\\\\>` → `\`.

Nesting is supported: `<@generateRandomString(<@generateRandomInt(<20>, <50>)>)>`.

`${ENV_REFERENCES}` inside string expressions pass through untouched — the preprocessor treats
them as ordinary text and the second pass resolves them.

## Preprocessor functions

| Function | Result |
|---|---|
| `generateRandomString(<len>)` | Random `[a-zA-Z0-9_-.]` string. `len` 1–1024. |
| `generateRandomBytes(<len>)` | Cryptographically random bytes. `len` 1–1024. |
| `generateRandomInt(<min>, <max>)` | Random integer, inclusive. |
| `pickRandom(<a>, <b>, …)` | One of the given values. |
| `setVar(<name>, <content>)` | Stores and returns `content`. Overwrites an existing name. |
| `getVar(name)` | Retrieves a stored value. **Name is unwrapped.** Errors if missing. |
| `generateRandomStringVar(<name>, <len>)` | `generateRandomString` + `setVar` in one. |
| `generateJWT(<secret>, <jsonPayload>)` | HS256 JWT. Defaults `iss: zerops`, `iat: now`. |
| `getDateTime(<mask>[, <timezone>])` | Formatted current time. Default timezone GMT. |
| `generateED25519Key(<name>)` | ED25519 keypair. |
| `generateRSA2048Key(<name>)` | RSA-2048 keypair. |
| `generateRSA4096Key(<name>)` | RSA-4096 keypair. |

Key functions store variants under `<name>Public`, `<name>PublicSsh`, `<name>Private`,
`<name>PrivateSsh` (ED25519 only for the last) and return the public key.

`getDateTime` mask tokens: `YYYY YY`, `MMMM MMM MM M`, `DDDD DD D dddd ddd`, `HH hh h`, `mm m`,
`ss s`, `S`, `A a`, `ZZZ zz Z`.

### Generated keys are multiline

```yaml
#yamlPreprocessor=on
services:
  - hostname: app
    type: nodejs@22
    envSecrets:
      GENERATED_PUBLIC_KEY: |
        <@generateED25519Key(<Key>)>
      APP_PUBLIC_KEY: |
        <@getVar(KeyPublic)>
      APP_PUBLIC_KEY_SSH: <@getVar(KeyPublicSsh)>
      APP_PRIVATE_KEY: |
        <@getVar(KeyPrivate)>
      APP_PRIVATE_KEY_SSH: |
        <@getVar(KeyPrivateSsh)>
```

The `|` block scalar is mandatory for PEM values; the SSH public key is single-line.

## Preprocessor modifiers

Chain with `|` inside the expression, before the closing `>`:

| Modifier | Effect |
|---|---|
| `sha256`, `sha512` | Hash |
| `bcrypt` | bcrypt, 11 rounds |
| `argon2id` | argon2id, m=64MiB t=4 p=4 salt=16B key=32B |
| `toHex` | Hex encoding |
| `toString` | Encode to `[a-zA-Z0-9_-.]` |
| `upper`, `lower`, `title` | Case mapping |
| `noop` | No-op |

```yaml
PASSWORD: <@generateRandomStringVar(<myPassword>, <30>)>
PASSWORD_HASH: <@getVar(myPassword)| bcrypt>
BUCKET: <@setVar(<bucketName>, <@generateRandomString(<10>) | lower>)>
```

A space before `|` inside a **function** expression is not included in the output; inside a plain
**string** expression it is.

## Gotchas

1. `#yamlPreprocessor=on` must be the **first line**. Missing it silently leaves `<@…>` as literal
   secret values.
2. Not every key is valid for every service type — the schema is the arbiter.
3. **Re-importing is not an update path.** `service-import` against an existing hostname does not
   edit the service. `override: true` works only for runtime services, and it *replaces* the
   service and forces a redeploy. To change scaling, storage size or domains on a live service, use
   the GUI or the REST API — see [`operations.md`](operations.md#changing-scaling-on-a-live-service).
