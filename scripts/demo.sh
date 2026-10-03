#!/usr/bin/env bash
# End-to-end visual walkthrough of the `worm` CLI in an isolated sandbox.
#
# Usage:  pnpm demo
#
# Runs init → worktree add → slot assign → sync → worktree rm against a
# throwaway HOME and a throwaway clone, so the real ~/.worm and ~/.claude are
# never touched. Use this for eyeballing UX changes; for automated correctness
# checks, use `pnpm test`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORM_BIN="$REPO_ROOT/dist/cli.js"

if [ ! -f "$WORM_BIN" ]; then
  echo "Build the CLI first: pnpm build" >&2
  exit 1
fi

SANDBOX=$(mktemp -d /tmp/worm-demo-home.XXXXXX)
PROJ=$(mktemp -d /tmp/worm-demo-proj.XXXXXX)
# Worktrees live inside the clone (.claude/worktrees), so removing it cleans them too.
trap 'rm -rf "$SANDBOX" "$PROJ"' EXIT

# HOME too: worm links each worktree's ~/.claude/projects dir.
export WORM_HOME="$SANDBOX" HOME="$SANDBOX"

# The main worktree is just a normal clone — no bare container.
cd "$PROJ"
git init -q -b main
git config user.email demo@worm.dev
git config user.name "Worm Demo"
echo "seed" > README.md
git add . && git commit -q -m "seed"
git branch feature-stripe-fix

worm() { node "$WORM_BIN" "$@"; }
header() { echo; echo "════════════════════ $* ════════════════════"; }

header "worm init (binds this clone, lazy-creates ~/.worm/)"
worm init

header "worm worktree add feature-stripe-fix (an existing branch)"
worm worktree add feature-stripe-fix --no-setup

header "worm worktree add feat/billing (a new branch, cut from main)"
worm worktree add feat/billing --base main --no-setup

header "ERROR: add a branch that's already checked out"
worm worktree add feature-stripe-fix --no-setup || true

header "worm slot assign billing (lowest free slot) / main 3"
worm slot assign billing
worm slot assign main 3

header "worm status (worktrees and their slots)"
worm status

header "worm slot ls"
worm slot ls

header "worm sync (reconcile tunnels, env files and hooks across worktrees)"
worm sync

header "worm worktree rm billing (releases its slot)"
worm worktree rm billing

header "ERROR: refuse to remove the main worktree"
worm worktree rm main || true

header "worm status"
worm status
