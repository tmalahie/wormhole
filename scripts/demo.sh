#!/usr/bin/env bash
# End-to-end visual walkthrough of the `worm` CLI in an isolated sandbox.
#
# Usage:  pnpm demo
#
# Runs init → universe add → switch → sync → universe rm against a throwaway
# HOME and a throwaway clone, so the real ~/.worm is never touched. Use this for
# eyeballing UX changes; for automated correctness checks, use `pnpm test`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORM_BIN="$REPO_ROOT/dist/cli.js"

if [ ! -f "$WORM_BIN" ]; then
  echo "Build the CLI first: pnpm build" >&2
  exit 1
fi

SANDBOX=$(mktemp -d /tmp/worm-demo-home.XXXXXX)
PROJ=$(mktemp -d /tmp/worm-demo-proj.XXXXXX)
# Clean the sandbox, the clone, and any sibling pool worktrees (<proj>-N).
trap 'rm -rf "$SANDBOX" "$PROJ" "$PROJ"-*' EXIT

export WORM_HOME="$SANDBOX"

# Slot 0 is just a normal clone — no bare container.
cd "$PROJ"
git init -q -b main
git config user.email demo@worm.dev
git config user.name "Worm Demo"
echo "seed" > README.md
git add . && git commit -q -m "seed"
git branch feature-stripe-fix
git branch feature-billing
git branch experiment-ai

worm() { node "$WORM_BIN" "$@"; }
header() { echo; echo "════════════════════ $* ════════════════════"; }

header "worm init (binds this clone as Slot 0, lazy-creates ~/.worm/)"
worm init

header "worm status (just Slot 0 so far)"
worm status

header "worm universe add feature-stripe-fix"
worm universe add feature-stripe-fix --skip-hook

header "worm universe add feature-billing"
worm universe add feature-billing --skip-hook

header "worm status (a pool of 3: main + 2 siblings)"
worm status

header "ERROR: add a branch that's already in a slot"
worm universe add feature-billing --skip-hook || true

header "worm switch experiment-ai (move Slot 0 in place)"
worm switch experiment-ai --skip-hook

header "worm sync (reconcile shared-path tunnels across slots)"
worm sync

header "worm status (Slot 0 now on experiment-ai)"
worm status

header "worm universe rm 1 (collapse a sibling)"
worm universe rm 1 --skip-hook

header "ERROR: refuse to remove Slot 0"
worm universe rm 0 || true

header "worm status (after removing universe 1)"
worm status
