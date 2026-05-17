# wormhole

> Warm, parallel `git worktree` environments for AI coding agents.

When you run multiple AI agents (Claude Code, Roo Code, Cody, …) against the same project at once they trample each other's files. `git worktree` solves that, but spinning up a fresh worktree means re-running `npm install`, copying `.env`, rebuilding caches — too slow for agent workflows.

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
# one-time global setup
worm init

# from your project root
worm register --universes 3

# mount a branch into the next free slot
worm warp my-feature

# work in it
cd .worm/universes/uni-1/src

# when done, free the slot (keeps node_modules warm)
worm collapse my-feature
```

`worm scan` shows you what's loaded at any time.

## Commands

| Command | What it does |
|---|---|
| `worm init` | Provisions `~/.worm/` with a template profile. Run once per machine. |
| `worm register [--universes N] [--name X]` | Binds the current project to a wormhole profile. Idempotent. |
| `worm scan [--json]` | Reports each slot as `STABLE` / `ACTIVE` / `BROKEN`, plus the branch loaded into active slots. |
| `worm warp <branch> [--create] [--skip-hook]` | Picks the lowest free slot, runs `git worktree add`, injects anchor + shared symlinks, runs `on_warp`. |
| `worm collapse <branch> [--force] [--skip-hook]` | Runs `on_collapse`, strips wormhole's injected symlinks, removes the worktree. Anchors stay warm. |

Run `worm <command> --help` for the full option list.

## How it works

```
<project-root>/
└── .worm/                            ← gitignored
    ├── config.json                   → symlink to ~/.worm/multiverses/<project>/config.json
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

The trick: `git worktree add` refuses non-empty target directories, so the worktree always lives in `src/` while anchors sit one level above. A relative symlink inside the worktree connects them, and `npm install` writes through the link into the persistent anchor.

## Configuration

Each project gets a config at `~/.worm/multiverses/<project-name>/config.json`:

```json
{
  "universes_count": 3,
  "anchors": ["node_modules", ".venv"],
  "shared_paths": [".env", "CLAUDE.local.md", "SKILL.md"],
  "hooks": {
    "on_warp": "npm install",
    "on_collapse": "git stash -u"
  }
}
```

- **`anchors`** — directories persisted at the slot level; symlinked into each worktree's `src/`.
- **`shared_paths`** — files mirrored from `.worm/shared/` into each worktree. If a matching file exists in the global profile, it's symlinked there; otherwise an empty local file is created on first `register`.
- **`hooks`** — shell commands run inside `src/` after warp and before collapse.

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
