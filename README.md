# zerops-contrib

A Claude Code plugin for [Zerops](https://zerops.io), a PaaS running on bare metal. It bundles two
things that are useful together:

- **the `zerops` skill** — how the platform actually behaves: `zerops.yaml` versus the import YAML,
  the service catalog and version strings, environment variables and cross-service references,
  networking, CDN and custom domains, the build/deploy lifecycle, autoscaling, backups.
- **`zops`** — a CLI generated from the Zerops OpenAPI document. All **228 documented operations**
  are reachable, plus 17 undocumented ones `zcli` uses internally; 123 have a curated command.
  `--json` on everything, meaningful exit codes, no runtime dependencies.

`zcli`, the official CLI, covers roughly a third of the API — restart, reload, autoscaling,
backups, environment writes, routing, rollback and deploy history have no command and the docs
send you to the GUI. All of it is in the REST API, so all of it is in `zops`.

## Install

```
/plugin marketplace add contember/zerops-contrib
/plugin install zerops@zerops-contrib
```

That is the whole thing. The skill and the CLI arrive together — there is no npm package and no
second install step. [Bun](https://bun.sh) is the one prerequisite for `zops`, because the CLI uses
`Bun.YAML`, `Bun.spawn` and `Bun.file`, which plain Node has no equivalent for.

Update with `/plugin update zerops@zerops-contrib`.

### Authenticate

```sh
export ZEROPS_TOKEN=...    # preferred — nothing written to disk
```

Tokens come from the Zerops GUI under **Settings → Access Token Management**. A project-scoped
token is enough for everything except `project list` and `project create`. `zops auth login` will
persist one to `~/.config/zops/config.json` (mode 0600) instead.

## Using it

The skill loads on its own whenever a conversation touches Zerops — a `zerops.yaml` in the repo, a
question about service types, an ask to deploy or scale something. To call the CLI directly:

```sh
"$CLAUDE_PLUGIN_ROOT/bin/zops" status
```

```sh
zops status                                   # whole project in one call
zops push api                                 # build on the platform, wait; exit 8 = build failed
zops logs api --build                         # why it failed
zops env set LOG_LEVEL debug api --restart
zops route http get api.example.com           # why a domain does not serve: DNS + TLS state
zops version rollback api --yes
zops apply -f zerops-import.yaml              # converge, rather than create-only import
zops api --list                               # everything else in the API, one call away
```

`zops commands --json` prints the whole surface — every command, flag and exit code — so an agent
can enumerate it at runtime instead of carrying a copy that goes stale. Full documentation is in
[`cli/README.md`](cli/README.md) and
[`skills/zerops/references/zops-cli.md`](skills/zerops/references/zops-cli.md).

## Other ways to install

**As a plain skill**, without the plugin system — symlink it and lose the update path:

```sh
git clone https://github.com/contember/zerops-contrib
ln -s "$PWD/zerops-contrib/skills/zerops" ~/.claude/skills/zerops
```

**As a standalone binary**, for shells and CI that have no Bun:

```sh
cd cli && bun install && bun run build     # dist/zops, self-contained
```

## Layout

```
.claude-plugin/     plugin + marketplace manifests
skills/zerops/      SKILL.md and references/ — the documentation half
cli/                zops: src/, the OpenAPI document, the operation generator
bin/zops            what the skill calls; resolves Bun and runs cli/ from source
scripts/            sync-docs.sh — regenerate version tables from zeropsio/docs
```

## Development

```sh
cd cli
bun install
bun test            # 54 tests
bun run typecheck
bun run generate    # rebuild the operation index after replacing openapi.yml
```

The service version tables in `skills/zerops/references/service-catalog.md` are machine-written
from [zeropsio/docs](https://github.com/zeropsio/docs):

```sh
scripts/sync-docs.sh            # regenerate, and report which upstream pages moved
scripts/sync-docs.sh --check    # report only; exits 1 on drift
```

Prose is never touched — the script only tells you which upstream pages changed so you can review
the matching reference by hand.

## Not affiliated with Zerops

This is a community project by [Contember](https://github.com/contember). It is not built,
endorsed or supported by Zerops s.r.o. The official tooling is
[`zcli`](https://github.com/zeropsio/zcli) and [`zcp`](https://github.com/zeropsio/zcp).

## License

MIT
