# wormhole

> Warm, parallel `git worktree` environments for AI coding agents.

When you run multiple AI agents (Claude Code, Roo Code, Cody, …) against the same project at once they trample each other's files. `git worktree` solves that, but spinning up a fresh worktree means re-running setup commands like `npm install`, copying `.env`, or rebuilding caches — too slow and cumbersome in the era of agent workflows.

`worm` keeps a pool of **permanent, pre-warmed universes** ready to receive a branch. Heavy folders (`node_modules`, `.venv`) and shared files (`.env`, `CLAUDE.local.md`) are persisted across warps via filesystem symlinks, so mounting a branch into an empty slot finishes in milliseconds.

---

## Install

```bash
pnpm install
pnpm build
pnpm link --global    # exposes the `worm` binary
```

Requires Node ≥ 20.

## Quick start

```bash
# from your project root — first run also creates ~/.worm/ for you
worm init --universes 3

# mount a branch into the next free slot
worm warp my-feature

# work in it
cd .worm/universes/uni-1/src

# when done, free the slot (keeps caches warm)
worm collapse my-feature
```

`worm status` shows you what's loaded at any time. Drop your install commands into [.worm/scripts/setup.sh](#configuration) — that file runs after every `warp`.

## Commands

| Command | What it does |
|---|---|
| `worm init [--universes N] [--name X] [--template <dir>]` | Binds the current project to a wormhole profile. Lazily creates `~/.worm/` on first use. Idempotent. |
| `worm status [--json]` | Reports each slot as `STABLE` / `ACTIVE` / `BROKEN`, plus the branch loaded into active slots. |
| `worm warp <branch> [--create] [--skip-hook]` | Picks the lowest free slot, runs `git worktree add`, injects anchor + shared symlinks, runs `on_warp`. |
| `worm collapse <branch> [--force] [--skip-hook]` | Runs `on_collapse`, strips wormhole's injected symlinks, removes the worktree. Anchors stay warm. |

Run `worm <command> --help` for the full option list.

## How it works

```
<project-root>/
└── .worm/                            ← self-ignored (contains its own .gitignore: *)
    ├── .gitignore                    ← single line: `*`
    ├── config.json                   → symlink to ~/.worm/multiverses/<project>/config.json
    ├── scripts/                      → symlink to ~/.worm/multiverses/<project>/scripts/
    │   └── setup.sh                  ← runs after `worm warp` (edit this!)
    ├── shared/                       ← files mirrored into every active universe
    │   ├── .env
    │   ├── CLAUDE.local.md           → symlink to ~/.worm/multiverses/<project>/CLAUDE.local.md
    │   └── SKILL.md                  → symlink to ~/.worm/multiverses/<project>/SKILL.md
    └── universes/
        ├── uni-1/
        │   ├── node_modules/         ← anchor (persistent cache)
        │   ├── .venv/                ← anchor
        │   └── src/                  ← git worktree target (created on warp)
        │       ├── node_modules      → ../node_modules
        │       ├── .env              → ../../../shared/.env
        │       └── …
        ├── uni-2/
        └── uni-3/
```

The trick: `git worktree add` refuses non-empty target directories, so the worktree always lives in `src/` while anchors sit one level above. A relative symlink inside the worktree connects them, and install commands write through the link into the persistent anchor.

## Configuration

Each project gets a config at `~/.worm/multiverses/<project-name>/config.json`:

```json
{
  "universes_count": 3,
  "anchors": ["node_modules", ".venv"],
  "shared_paths": [".env", "CLAUDE.local.md", "SKILL.md"],
  "hooks": {
    "on_warp": "bash \"$WORM_PROJECT_ROOT/.worm/scripts/setup.sh\"",
    "on_collapse": "git stash -u"
  }
}
```

- **`anchors`** — directories persisted at the slot level and symlinked into each worktree. Examples: `node_modules` (Node.js), `.venv` (Python), `vendor` (Ruby/Go). Add as many as your stack requires.
- **`shared_paths`** — files mirrored from `.worm/shared/` into each worktree. If a matching file exists in the global profile, it's symlinked there; otherwise an empty local file is created on first `init`.
- **`hooks`** — shell commands run inside `src/` after warp and before collapse. The default `on_warp` invokes `.worm/scripts/setup.sh`; drop your install commands there (`npm install`, `pip install -r requirements.txt`, `bundle install`, …) instead of editing the JSON. A non-zero `on_warp` warns but does not abort the warp. `on_collapse` runs before the worktree is removed; a non-zero exit aborts unless `--force` is passed.

### Hook environment

Hook commands (and any script they invoke, like `setup.sh`) receive these env vars:

| Variable | Value |
|---|---|
| `WORM_PROJECT_ROOT` | Absolute path to the project root. |
| `WORM_SLOT` | Slot name being acted on (e.g. `uni-1`). |
| `WORM_SLOT_INDEX` | The numeric, 1-based slot index (e.g. `1` for `uni-1`). Handy for derived values: `PORT=$((8079 + WORM_SLOT_INDEX))`. |
| `WORM_BRANCH` | Branch name being warped or collapsed. |

### Templates

When you run `worm init` for the first time on a machine, `~/.worm/templates/default/` is seeded with a `config.json` and `scripts/setup.sh`. New projects are bootstrapped from that template — so edits to it apply to every project you create afterwards (existing projects are untouched).

Pass `--template <dir>` to bootstrap from a custom directory instead. The directory must contain a `config.json`; an optional `scripts/` subdirectory is copied into the new multiverse profile.

## Environment

| Variable | Effect |
|---|---|
| `WORM_HOME` | Override the global root (default: `~/.worm`). Useful for sandboxes, CI, or running multiple worm "homes" side by side. |
| `WORM_DEBUG` | Set to `1` to print stack traces on error. |

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test           # runs node:test against the built CLI
```

See [src/README.md](src/README.md) for architecture and [CLAUDE.md](CLAUDE.md) for agent contributor guidelines.
