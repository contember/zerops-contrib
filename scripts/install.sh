#!/bin/sh
# Install zops, the agent-first CLI for Zerops.
#
#   curl -fsSL https://raw.githubusercontent.com/contember/zerops-contrib/main/scripts/install.sh | sh
#
# Using Claude Code? You do not need this — the zerops plugin already ships zops.
# This is for shells and CI that want a standalone binary with no Bun installed.
#
# ZOPS_VERSION   a tag such as v0.1.0 (default: the latest release)
# ZOPS_BIN_DIR   where to put it (default: ~/.local/bin)

set -eu

REPO=contember/zerops-contrib
VERSION=${ZOPS_VERSION:-latest}
BIN_DIR=${ZOPS_BIN_DIR:-$HOME/.local/bin}

case "$(uname -s)" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *)
    echo "zops: no binary for $(uname -s). Build from source: https://github.com/$REPO" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)  arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    echo "zops: no binary for $(uname -m). Build from source: https://github.com/$REPO" >&2
    exit 1
    ;;
esac

# macOS ships shasum, most Linux ships sha256sum; refuse rather than install unverified.
if command -v sha256sum >/dev/null 2>&1; then
  verify() { sha256sum -c -; }
elif command -v shasum >/dev/null 2>&1; then
  verify() { shasum -a 256 -c -; }
else
  echo "zops: neither sha256sum nor shasum found; cannot verify the download" >&2
  exit 1
fi

asset="zops-$os-$arch.tar.gz"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "==> downloading $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

echo "==> verifying"
(cd "$tmp" && grep " $asset\$" SHA256SUMS | verify) >/dev/null

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$BIN_DIR"
mv "$tmp/zops" "$BIN_DIR/zops"
chmod +x "$BIN_DIR/zops"

echo "==> installed $("$BIN_DIR/zops" --version | head -1) to $BIN_DIR/zops"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    note: $BIN_DIR is not on your PATH" >&2 ;;
esac
