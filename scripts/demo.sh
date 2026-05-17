#!/usr/bin/env bash
# End-to-end visual walkthrough of the `worm` CLI in an isolated sandbox.
#
# Usage:  pnpm demo
#
# Runs init → register → warp → scan → collapse against a throwaway HOME
# so the real ~/.worm is never touched. Use this for eyeballing UX changes;
# for automated correctness checks, use `pnpm test`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORM_BIN="$REPO_ROOT/dist/cli.js"

if [ ! -f "$WORM_BIN" ]; then
  echo "Build the CLI first: pnpm build" >&2
  exit 1
fi

SANDBOX=$(mktemp -d /tmp/worm-demo-home.XXXXXX)
PROJ=$(mktemp -d /tmp/worm-demo-proj.XXXXXX)
trap 'rm -rf "$SANDBOX" "$PROJ"' EXIT

export WORM_HOME="$SANDBOX"

cd "$PROJ"
git init -q -b main
git config user.email demo@worm.dev
git config user.name "Worm Demo"
echo "seed" > README.md
git add . && git commit -q -m "seed"
git branch feature-stripe-fix
git branch feature-billing
git branch experiment-ai

header() { echo; echo "════════════════════ $* ════════════════════"; }

header "worm init"
node "$WORM_BIN" init

header "worm register --universes 3"
node "$WORM_BIN" register --universes 3

header "worm scan (empty multiverse)"
node "$WORM_BIN" scan

header "worm warp feature-stripe-fix"
node "$WORM_BIN" warp feature-stripe-fix --skip-hook

header "worm warp feature-billing"
node "$WORM_BIN" warp feature-billing --skip-hook

header "worm scan (mid-multiverse)"
node "$WORM_BIN" scan

header "ERROR: warp same branch twice"
node "$WORM_BIN" warp feature-billing --skip-hook || true

header "worm collapse feature-stripe-fix"
node "$WORM_BIN" collapse feature-stripe-fix --skip-hook

header "worm scan (after collapse)"
node "$WORM_BIN" scan

header "ERROR: no free slot"
node "$WORM_BIN" warp experiment-ai --skip-hook >/dev/null
node "$WORM_BIN" warp another --create --skip-hook || true
