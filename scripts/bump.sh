#!/usr/bin/env bash
# Bump the version, commit and tag. Pushing the tag is what publishes a release.
#
#   scripts/bump.sh patch          0.1.0 -> 0.1.1
#   scripts/bump.sh minor          0.1.0 -> 0.2.0
#   scripts/bump.sh major          0.1.0 -> 1.0.0
#   scripts/bump.sh 0.4.2          exactly that
#   scripts/bump.sh minor --push   also push the branch and the tag, starting the release
#   scripts/bump.sh minor --dry-run
#
# Three files carry the version and none derives from another:
#   .claude-plugin/plugin.json    what /plugin update reads
#   cli/package.json
#   cli/src/cli.ts                what `zops --version` prints
#
# They are rewritten together, then the test suite confirms they agree — the same check the
# release workflow runs against the tag before it publishes anything.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLUGIN=.claude-plugin/plugin.json
PKG=cli/package.json
SRC=cli/src/cli.ts

BUMP=""
PUSH=0
DRY=0

for arg in "$@"; do
  case "$arg" in
    --push)    PUSH=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    -*)        echo "error: unknown flag $arg" >&2; exit 2 ;;
    *)
      [[ -n "$BUMP" ]] && { echo "error: give exactly one version or bump level" >&2; exit 2; }
      BUMP="$arg"
      ;;
  esac
done

[[ -n "$BUMP" ]] || { echo "error: expected patch|minor|major|X.Y.Z" >&2; exit 2; }

for bin in git python3 bun; do
  command -v "$bin" >/dev/null || { echo "error: $bin not found" >&2; exit 1; }
done

# ------------------------------------------------------------------ read + check

read_version() {
  python3 - "$1" <<'PY'
import json, re, sys
path = sys.argv[1]
if path.endswith(".json"):
    print(json.load(open(path))["version"])
else:
    m = re.search(r'VERSION\s*=\s*"([^"]+)"', open(path, encoding="utf-8").read())
    sys.exit("error: no VERSION in %s" % path) if not m else print(m.group(1))
PY
}

CURRENT="$(read_version "$PLUGIN")"
for file in "$PKG" "$SRC"; do
  found="$(read_version "$file")"
  [[ "$found" == "$CURRENT" ]] || {
    echo "error: versions already disagree — $PLUGIN says $CURRENT, $file says $found" >&2
    echo "       fix that by hand first; this script will not paper over it" >&2
    exit 1
  }
done

NEXT="$(python3 - "$CURRENT" "$BUMP" <<'PY'
import re, sys
current, bump = sys.argv[1], sys.argv[2]
if re.fullmatch(r"\d+\.\d+\.\d+", bump):
    print(bump)
    raise SystemExit
major, minor, patch = (int(p) for p in current.split("."))
if bump == "major":   major, minor, patch = major + 1, 0, 0
elif bump == "minor": minor, patch = minor + 1, 0
elif bump == "patch": patch += 1
else: sys.exit(f"error: {bump!r} is not patch, minor, major or X.Y.Z")
print(f"{major}.{minor}.{patch}")
PY
)"

TAG="v$NEXT"
echo "==> $CURRENT -> $NEXT ($TAG)"

# --------------------------------------------------------------------- git guards

[[ -z "$(git status --porcelain)" ]] || {
  echo "error: working tree is dirty; commit or set aside your changes first" >&2
  git status --short >&2
  exit 1
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || echo "    warning: on branch $BRANCH, not main"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && {
  echo "error: tag $TAG already exists" >&2
  exit 1
}

# A tag on a commit the remote has never seen would point somewhere nobody else can reach.
git fetch --quiet origin "$BRANCH" 2>/dev/null || true
if git rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
  behind="$(git rev-list --count "HEAD..origin/$BRANCH")"
  [[ "$behind" -eq 0 ]] || {
    echo "error: $BRANCH is $behind commit(s) behind origin; pull first" >&2
    exit 1
  }
fi

# ------------------------------------------------------------------------- rewrite

if [[ "$DRY" -eq 1 ]]; then
  echo "==> --dry-run: would rewrite $PLUGIN, $PKG, $SRC and tag $TAG"
  exit 0
fi

python3 - "$NEXT" "$PLUGIN" "$PKG" "$SRC" <<'PY'
import re, sys

nxt, paths = sys.argv[1], sys.argv[2:]
for path in paths:
    body = open(path, encoding="utf-8").read()
    pattern = (
        r'("version"\s*:\s*")[^"]+(")' if path.endswith(".json")
        else r'(VERSION\s*=\s*")[^"]+(")'
    )
    new, n = re.subn(pattern, lambda m: m.group(1) + nxt + m.group(2), body, count=1)
    if n != 1:
        sys.exit(f"error: expected exactly 1 version field in {path}, replaced {n}")
    open(path, "w", encoding="utf-8").write(new)
    print(f"    {path}")
PY

echo "==> running the test suite"
(cd cli && bun test) || {
  echo "error: tests failed; reverting" >&2
  git checkout -- "$PLUGIN" "$PKG" "$SRC"
  exit 1
}

git add "$PLUGIN" "$PKG" "$SRC"
git commit --quiet -m "chore: release $TAG"
git tag -a "$TAG" -m "zops $NEXT"
echo "==> committed and tagged $TAG"

if [[ "$PUSH" -eq 1 ]]; then
  git push --quiet origin "$BRANCH"
  git push --quiet origin "$TAG"
  echo "==> pushed; the release workflow is building"
  echo "    gh run watch --workflow release"
else
  echo
  echo "Nothing is published yet. To release:"
  echo "    git push origin $BRANCH && git push origin $TAG"
  echo "To undo:"
  echo "    git tag -d $TAG && git reset --hard HEAD~1"
fi
