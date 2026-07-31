#!/usr/bin/env bash
# Sync this skill against upstream https://github.com/zeropsio/docs
#
#   sync-docs.sh            regenerate version tables + report upstream changes
#   sync-docs.sh --check    report only, change no skill file; exits 1 on drift
#
# Version tables are machine-written from the upstream static/data.json into the
# GENERATED block of references/service-catalog.md. Prose is not touched — the
# script only tells you which upstream pages moved so you can review them.
#
# Both modes clone/fetch the upstream repo into a cache outside the skill
# (~/.cache/zerops-skill/docs, override with ZEROPS_DOCS_CACHE).
#
# Fails loudly rather than producing a quietly-wrong table: a renamed data.json
# key, a service upstream added that this generator does not render, or a tracked
# page that no longer exists are all reported.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Outside the skill on purpose: the upstream clone is ~120 MB and would otherwise
# pollute greps of the skill and get zipped into any packaged artifact.
CACHE_DIR="${ZEROPS_DOCS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/zerops-skill/docs}"
STATE_FILE="$SKILL_DIR/.docs-sync.json"
CATALOG="$SKILL_DIR/references/service-catalog.md"
REPO="https://github.com/zeropsio/docs.git"

CHECK_ONLY=0
DRIFT=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

for bin in git python3; do
  command -v "$bin" >/dev/null || { echo "error: $bin not found" >&2; exit 1; }
done

# Upstream pages this skill is derived from. If one of these changes, the prose
# in the matching reference file may need a human pass.
UPSTREAM_SOURCES=(
  "apps/docs/content/zerops-yaml/specification.mdx|references/zerops-yaml.md"
  "apps/docs/content/zerops-yaml/base-list.mdx|references/service-catalog.md"
  "apps/docs/content/zerops-yaml/cron.mdx|references/zerops-yaml.md"
  "apps/docs/content/guides/zerops-yaml-advanced.mdx|references/zerops-yaml.md"
  "apps/docs/content/guides/readiness-health-checks.mdx|references/zerops-yaml.md"
  "apps/docs/content/references/import.mdx|references/import-yaml.md"
  "apps/docs/content/references/import-yaml/pre-processor.mdx|references/import-yaml.md"
  "apps/docs/content/references/import-yaml/type-list.mdx|references/service-catalog.md"
  "apps/docs/content/references/zcli/commands.mdx|references/cli.md"
  "apps/docs/content/references/zcli/configuration.mdx|references/cli.md"
  "apps/docs/content/references/zsc.mdx|references/cli.md"
  "apps/docs/content/references/networking/internal-access.mdx|references/networking.md"
  "apps/docs/content/references/networking/public-access.mdx|references/networking.md"
  "apps/docs/content/features/access.mdx|references/networking.md"
  "apps/docs/content/features/env-variables.mdx|references/env-variables.md"
  "apps/docs/content/guides/environment-variables.mdx|references/env-variables.md"
  "apps/docs/content/guides/networking.mdx|references/networking.md"
  "apps/docs/content/features/pipeline.mdx|references/pipeline.md"
  "apps/docs/content/guides/deployment-lifecycle.mdx|references/pipeline.md"
  "apps/docs/content/guides/build-cache.mdx|references/pipeline.md"
  "apps/docs/content/guides/ci-cd.mdx|references/pipeline.md"
  "apps/docs/content/features/infrastructure.mdx|references/operations.md"
  "apps/docs/content/guides/scaling.mdx|references/operations.md"
  "apps/docs/content/guides/production-checklist.mdx|references/operations.md"
  "apps/docs/content/guides/logging.mdx|references/operations.md"
  "apps/docs/content/guides/object-storage-integration.mdx|references/operations.md"
  "apps/docs/content/guides/choose-database.mdx|references/service-catalog.md"
  "apps/docs/content/guides/choose-cache.mdx|references/service-catalog.md"
  "apps/docs/content/guides/choose-queue.mdx|references/service-catalog.md"
  "apps/docs/content/guides/choose-search.mdx|references/service-catalog.md"
  "apps/docs/content/guides/choose-runtime-base.mdx|references/service-catalog.md"
  "apps/docs/content/postgresql/how-to/connect.mdx|references/service-catalog.md"
  "apps/docs/content/postgresql/how-to/manage.mdx|references/service-catalog.md"
  "apps/docs/content/postgresql/how-to/scale.mdx|references/operations.md"
  "apps/docs/content/valkey/overview.mdx|references/service-catalog.md"
  "apps/docs/content/features/backup.mdx|references/operations.md"
  "apps/docs/content/guides/backup.mdx|references/operations.md"
  "apps/docs/content/features/debug-mode.mdx|references/pipeline.md"
  "apps/docs/content/references/metrics.mdx|references/operations.md"
  "apps/docs/content/references/api.mdx|references/cli.md"
  "apps/docs/content/references/networking/ssh.mdx|references/networking.md"
  "apps/docs/content/references/networking/vpn.mdx|references/networking.md"
  "apps/docs/content/references/networking/dns.mdx|references/networking.md"
  "apps/docs/content/references/networking/l7-balancer-config.mdx|references/networking.md"
  "apps/docs/content/guides/firewall.mdx|references/networking.md"
  "apps/docs/content/guides/smtp.mdx|references/networking.md"
  "apps/docs/content/guides/public-access.mdx|references/networking.md"
  "apps/docs/content/guides/shared-storage-integration.mdx|references/operations.md"
  "apps/docs/content/static/overview.mdx|references/zerops-yaml.md"
  "apps/docs/content/php/how-to/build-pipeline.mdx|references/zerops-yaml.md"
  "apps/docs/content/nodejs/how-to/build-pipeline.mdx|references/zerops-yaml.md"
)

# ---------------------------------------------------------------- fetch upstream

if [[ -d "$CACHE_DIR/.git" ]]; then
  echo "==> updating $CACHE_DIR"
  git -C "$CACHE_DIR" fetch --depth 1 origin HEAD --quiet
  git -C "$CACHE_DIR" reset --hard FETCH_HEAD --quiet
else
  echo "==> cloning $REPO"
  mkdir -p "$(dirname "$CACHE_DIR")"
  git clone --depth 1 --quiet "$REPO" "$CACHE_DIR"
fi

NEW_COMMIT="$(git -C "$CACHE_DIR" rev-parse HEAD)"
OLD_COMMIT="$(python3 -c "
import json,sys
try:
    print(json.load(open('$STATE_FILE'))['commit'])
except Exception:
    print('')
")"

echo "==> upstream HEAD $NEW_COMMIT"

# ------------------------------------------------------- regenerate version block

DATA_JSON="$CACHE_DIR/apps/docs/static/data.json"
[[ -f "$DATA_JSON" ]] || { echo "error: data.json not found at $DATA_JSON" >&2; exit 1; }

TMP_BLOCK="$(mktemp)"
trap 'rm -f "$TMP_BLOCK"' EXIT

python3 - "$DATA_JSON" > "$TMP_BLOCK" <<'PY'
import json, sys

data = json.load(open(sys.argv[1]))
out = []

def joined(rows):
    """rows: list of alias-lists -> one markdown cell per row, aliases comma-joined."""
    # Upstream writes some entries as "bun@1.1(Ubuntu only)"; give the note room to breathe.
    fix = lambda s: s.replace("(", " (") if "(" in s and " (" not in s else s
    return ["`" + "` / `".join(fix(a) for a in r) + "`" for r in rows]

missing = []

def table(title, entries, header="Service type"):
    """entries: list of (name, rows-or-None). A None row means upstream data moved."""
    out.append(f"### {title}\n")
    out.append(f"| {header} | Versions (newest first, aliases share a row) |")
    out.append("|---|---|")
    for name, rows in entries:
        if not rows:
            missing.append(f"{title} / {name}")
            continue
        cell = "<br>".join(joined(rows))
        out.append(f"| {name} | {cell} |")
    out.append("")

def base(key, sub=None):
    node = data.get(key, {}).get("base")
    if node is None:
        return None
    if sub:
        for part in sub:
            if not isinstance(node, dict):
                return None
            node = node.get(part)
            if node is None:
                return None
    return node if isinstance(node, list) else None

def imp(key, sub=None):
    node = data.get(key, {}).get("import")
    if node is None:
        return None
    if sub:
        for part in sub:
            if not isinstance(node, dict):
                return None
            node = node.get(part)
            if node is None:
                return None
    return node if isinstance(node, list) else None

out.append("### `base:` for `zerops.yaml`\n")
out.append("Values for `build.base` and `run.base`.\n")

table("Runtimes — build and run", [
    ("Bun", base("bun")), ("Deno", base("deno")), (".NET", base("dotnet")),
    ("Elixir", base("elixir")), ("Gleam", base("gleam")), ("Go", base("go")),
    ("Java", base("java")), ("Node.js", base("nodejs")), ("Python", base("python")),
    ("Ruby", base("ruby")), ("Rust", base("rust")),
])

table("PHP, static and containers — build vs run differ", [
    ("PHP (build)", base("php", ["build"])),
    ("PHP + Apache (run)", base("php", ["runtime", "apache"])),
    ("PHP + nginx (run)", base("php", ["runtime", "nginx"])),
    ("nginx (run)", base("nginx", ["build"]) or base("nginx", ["runtime"])),
    ("static (run)", base("static", ["build"]) or base("static", ["runtime"])),
    ("Docker (run)", base("docker", ["runtime"])),
    ("Alpine", base("alpine")),
    ("Ubuntu", base("ubuntu")),
])

out.append("### `type:` for the import YAML\n")
out.append(
    "Managed services take a `:single` / `:ha` deployment variant where listed. "
    "The legacy `mode: NON_HA|HA` field is deprecated.\n"
)

table("Runtimes", [
    ("Bun", imp("bun")), ("Deno", imp("deno")), (".NET", imp("dotnet")),
    ("Elixir", imp("elixir")), ("Gleam", imp("gleam")), ("Go", imp("go")),
    ("Java", imp("java")), ("Node.js", imp("nodejs")),
    ("PHP + Apache", imp("php", ["apache"])), ("PHP + nginx", imp("php", ["nginx"])),
    ("Python", imp("python")), ("Ruby", imp("ruby")), ("Rust", imp("rust")),
])

table("Static, containers and VMs", [
    ("nginx", imp("nginx")), ("static", imp("static")),
    ("Alpine", imp("alpine")), ("Ubuntu", imp("ubuntu")), ("Docker", imp("docker")),
])

table("Databases", [
    ("PostgreSQL", imp("postgresql")), ("MariaDB", imp("mariadb")),
    ("ClickHouse", imp("clickhouse")), ("Valkey", imp("valkey")),
    ("KeyDB (legacy)", imp("keydb")), ("Qdrant", imp("qdrant")),
], header="Database")

table("Search engines", [
    ("Elasticsearch", imp("elasticsearch")), ("Meilisearch", imp("meilisearch")),
    ("Typesense", imp("typesense")),
], header="Search engine")

table("Message brokers", [
    ("Kafka", imp("kafka")), ("NATS", imp("nats")), ("RabbitMQ", imp("rabbitmq")),
], header="Broker")

table("Storage", [
    ("Object storage", imp("objectstorage")),
    ("Shared storage", imp("sharedstorage")),
    ("SeaweedFS", imp("seaweedfs")),
], header="Storage")

if missing:
    sys.exit(
        "error: no version data in data.json for: "
        + ", ".join(missing)
        + "\n       upstream renamed or removed these keys; fix the generator."
    )

# Surface services upstream added that this generator does not render.
KNOWN = {
    "alpine", "ubuntu", "go", "php", "dotnet", "nodejs", "python", "ruby", "rust",
    "bun", "deno", "elixir", "gleam", "java", "nginx", "static", "docker",
    "mariadb", "postgresql", "keydb", "valkey", "qdrant", "nats", "kafka",
    "elasticsearch", "meilisearch", "typesense", "rabbitmq", "clickhouse",
    "seaweedfs", "sharedstorage", "objectstorage",
}
unmapped = sorted(set(data) - KNOWN)
if unmapped:
    sys.exit(
        "error: data.json has services this generator does not render: "
        + ", ".join(unmapped)
        + "\n       add them to a table in scripts/sync-docs.sh."
    )

print("\n".join(out).rstrip())
PY

if [[ "$CHECK_ONLY" -eq 0 ]]; then
  python3 - "$CATALOG" "$NEW_COMMIT" "$TMP_BLOCK" <<'PY'
import re, sys, datetime

path, commit, block_path = sys.argv[1], sys.argv[2], sys.argv[3]
body = open(path, encoding="utf-8").read()
generated = open(block_path, encoding="utf-8").read().rstrip()

block = (
    "<!-- BEGIN GENERATED: versions -->\n"
    "<!-- Generated by scripts/sync-docs.sh from zeropsio/docs@{commit} on {date}."
    " Do not edit by hand. -->\n\n"
    "{generated}\n\n"
    "<!-- END GENERATED: versions -->"
).format(
    commit=commit[:12],
    date=datetime.date.today().isoformat(),
    generated=generated,
)

new, n = re.subn(
    r"<!-- BEGIN GENERATED: versions -->.*?<!-- END GENERATED: versions -->",
    lambda _: block,
    body,
    flags=re.S,
)
if n != 1:
    sys.exit("error: expected exactly 1 GENERATED block in %s, found %d" % (path, n))
open(path, "w", encoding="utf-8").write(new)
print("==> wrote version tables to %s" % path)
PY
else
  # Check mode must still answer "would the tables change?".
  if python3 - "$CATALOG" "$TMP_BLOCK" <<'PY'
import re, sys
body = open(sys.argv[1], encoding="utf-8").read()
fresh = open(sys.argv[2], encoding="utf-8").read().strip()
m = re.search(
    r"<!-- BEGIN GENERATED: versions -->\n(?:<!--.*?-->\n)?(.*?)<!-- END GENERATED: versions -->",
    body, re.S,
)
sys.exit(0 if m and m.group(1).strip() == fresh else 1)
PY
  then
    echo "==> --check: version tables are up to date"
  else
    echo "==> --check: VERSION TABLES ARE STALE — rerun without --check to regenerate"
    DRIFT=1
  fi
fi

# ------------------------------------------------------------ report doc changes

if [[ -z "$OLD_COMMIT" ]]; then
  echo "==> no previous sync recorded; skipping change report"
elif [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  echo "==> upstream unchanged since last sync"
else
  # A shallow clone cannot diff two commits; deepen just enough to try.
  if git -C "$CACHE_DIR" cat-file -e "$OLD_COMMIT^{commit}" 2>/dev/null; then
    CHANGED="$(git -C "$CACHE_DIR" diff --name-only "$OLD_COMMIT" "$NEW_COMMIT")"
  else
    git -C "$CACHE_DIR" fetch --unshallow --quiet 2>/dev/null || true
    CHANGED="$(git -C "$CACHE_DIR" diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" 2>/dev/null || true)"
  fi

  if [[ -z "$CHANGED" ]]; then
    echo "==> could not diff against $OLD_COMMIT (history unavailable); review manually"
  else
    echo
    echo "==> upstream pages that changed and feed this skill:"
    HIT=0
    for entry in "${UPSTREAM_SOURCES[@]}"; do
      src="${entry%%|*}"
      dst="${entry##*|}"
      if grep -qxF "$src" <<<"$CHANGED"; then
        printf '    %-62s -> %s\n' "$src" "$dst"
        HIT=1
      fi
    done
    [[ "$HIT" -eq 0 ]] && echo "    (none — only unrelated pages changed)"
  fi
fi

# A renamed upstream page would otherwise silently never match again.
STALE=0
for entry in "${UPSTREAM_SOURCES[@]}"; do
  src="${entry%%|*}"
  if [[ ! -f "$CACHE_DIR/$src" ]]; then
    echo "    warning: tracked page no longer exists upstream: $src"
    STALE=1
  fi
done
[[ "$STALE" -eq 1 ]] && echo "    -> update UPSTREAM_SOURCES in scripts/sync-docs.sh"

# ----------------------------------------------------------------- record state

if [[ "$CHECK_ONLY" -eq 0 ]]; then
  python3 - "$STATE_FILE" "$NEW_COMMIT" <<'PY'
import json, sys, datetime
json.dump(
    {"commit": sys.argv[2], "syncedAt": datetime.datetime.now().astimezone().isoformat()},
    open(sys.argv[1], "w"),
    indent=2,
)
open(sys.argv[1], "a").write("\n")
PY
  echo "==> recorded $NEW_COMMIT in $STATE_FILE"
fi

[[ "$DRIFT" -eq 1 ]] && exit 1
exit 0
