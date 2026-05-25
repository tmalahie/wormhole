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

### Shell integration (recommended)

Add this to your `~/.zshrc` (or `~/.bashrc`):

```bash
eval "$(worm shell-init)"
eval "$(worm completion zsh)"    # or `bash`
```

- `worm shell-init` installs a `worm()` wrapper so `worm cd <branch>` / `worm tp <N>` actually change your shell's working directory.
- `worm completion <shell>` registers tab completion: subcommand names (`worm sta<tab>` → `worm status`) and dynamic branch completion for `warp` / `collapse` / `cd` / `path` (`worm warp feat/<tab>` lists matching branches via `git for-each-ref`).

### Editor integration (optional)

Tell worm which editor to launch with `worm warp --open`:

```bash
worm config editor code     # or vim, subl, idea, …
```

## Quick start

```bash
# Set up a fresh project as a worm container (creates ~/git/mkpc/ with .bare/, .git pointer, .worm/, …)
worm clone https://github.com/you/mkpc.git ~/git/mkpc --universes 3
cd ~/git/mkpc

# mount a branch into the next free slot (--open spawns your configured editor on it)
worm warp my-feature --open

# or hop into it later from any directory
worm cd my-feature

# when done, free the slot (keeps caches warm)
worm collapse my-feature
```

`worm status` shows you what's loaded at any time. Drop your install commands into [.worm/scripts/setup.sh](#configuration) — that file runs after every `warp`.

> `worm init` (without `clone`) is available too, but only inside an already-set-up bare-clone container. For fresh projects, `worm clone` is the entry point.

## Commands

| Command | What it does |
|---|---|
| `worm clone <url> [path] [--universes N] [--name X] [--template <dir>]` | Recommended entry point. Bare-clones `<url>` into a worm container (`<path>/.bare/` + `.git` pointer) and binds it to a multiverse. |
| `worm init [--universes N] [--name X] [--template <dir>]` | Binds an existing bare-clone container to a wormhole profile (use `worm clone` to set one up first). Lazily creates `~/.worm/` on first use. Idempotent. |
| `worm status [--json]` | Reports each slot as `STABLE` / `ACTIVE` / `BROKEN`, plus the branch loaded into active slots. |
| `worm universes [count]` | Print the current universe count (no arg), or resize the multiverse (`worm universes 5`). Growing creates the new slot dirs; shrinking refuses if it would cut off an active universe. |
| `worm warp <branch> [--create] [--detach] [--open] [--skip-hook]` | Picks the lowest free slot, runs `git worktree add`, injects anchor + shared symlinks, runs `on_warp`. `--detach` checks out a detached HEAD (useful when the branch is already used elsewhere). `--open` launches your configured editor on the new worktree. |
| `worm collapse <ref> [--force] [--skip-hook]` | Frees a universe slot — `<ref>` is a branch name *or* a 0-based slot index (`worm collapse 0`). Refuses if the worktree has uncommitted changes; `--force` discards them. Anchors stay warm. |
| `worm cd <branch>` / `worm tp <N>` | Change directory into a warped branch (by branch name) or a slot (by 0-based index). Requires the shell-init wrapper above. |
| `worm path <ref>` | Print the worktree path for a branch or slot index (what `cd`/`tp` use under the hood). |
| `worm config <key> [value]` | Read or write machine-level worm settings in `~/.worm/config.json` (supported keys: `editor`). `--list` prints everything; `--unset` clears a key. |
| `worm destroy [--force]` | Unbind the project: collapse all warps, delete `.worm/`, the global profile, and the `.gitignore` entry. Prompts before doing anything destructive (refuses in non-interactive shells unless `--force`). |
| `worm shell-init` | Print the shell function described in [Shell integration](#shell-integration-recommended). |
| `worm completion <bash\|zsh>` | Print a tab-completion script for the chosen shell. Source via `eval "$(worm completion zsh)"`. |

Run `worm <command> --help` for the full option list.

All project-scoped commands walk up the directory tree looking for a worm container (like `git` walks up to find `.git/`), so you can run them from any subdirectory — including from inside a warped worktree.

## How it works

For a project named `mkpc` with `universes_count: 3` and one active warp on `feat/foo`:

```
~/git/mkpc/                           ← container (NOT a working tree — no checked-out files here)
├── .bare/                            ← the bare clone (all the git data)
├── .git                              ← FILE, one line: `gitdir: ./.bare` — makes git commands work from the container
├── .worm/                            ← self-ignored (its own .gitignore: `*`)
│   ├── .gitignore                    ← single line: `*`
│   ├── config.json                   → symlink to ~/.worm/multiverses/mkpc/config.json
│   ├── scripts/                      → symlink to ~/.worm/multiverses/mkpc/scripts/
│   │   └── setup.sh                  ← runs after `worm warp` (edit this!)
│   ├── shared/                       ← files mirrored into every active universe
│   │   └── .env                      → ~/.worm/multiverses/mkpc/.env (or local placeholder)
│   └── universes/                    ← per-slot persistent state (anchors live here)
│       ├── uni-0/
│       │   ├── node_modules/         ← anchor (persistent cache, survives collapse)
│       │   └── .venv/                ← anchor
│       ├── uni-1/
│       └── uni-2/
├── mkpc-uni0/                        ← real top-level git worktree (created by `worm warp feat/foo`)
│   ├── node_modules                  → ../.worm/universes/uni-0/node_modules
│   ├── .env                          → ../.worm/shared/.env
│   └── …                              (the checked-out branch files)
└── (mkpc-uni1/, mkpc-uni2/ appear when those slots are warped)
```

The container itself has nothing checked out, so there's no working tree to pollute — no `.gitignore` line worm needs to touch, no `git status` showing the worktree dirs as untracked. Each universe still has two locations: persistent state in `.worm/universes/uni-N/` (anchors that should survive `worm collapse`), and the actual git worktree at `<projectName>-uniN/`, which is easy to open in your editor and clearly named in VSCode tabs. Relative symlinks connect the two, so install commands write through to the persistent anchor.

## Configuration

Each project gets a config at `~/.worm/multiverses/<project-name>/config.json`. The built-in default is intentionally minimal — projects start with no anchors or shared files, so worm doesn't presume your stack:

```json
{
  "universes_count": 3,
  "anchors": [],
  "shared_paths": [],
  "hooks": {
    "on_warp": "bash \"$WORM_PROJECT_ROOT/.worm/scripts/setup.sh\""
  }
}
```

Edit the file (or pre-seed a `--template <dir>`) to add what your project actually needs.

- **`anchors`** — directories persisted at the slot level and symlinked into each worktree. Add things like `node_modules` (Node.js), `.venv` (Python), `vendor` (Ruby/Go) — whatever your stack benefits from keeping warm across warps.
- **`shared_paths`** — files mirrored from `.worm/shared/` into each worktree. If a matching file exists at `~/.worm/multiverses/<project>/<path>`, it's symlinked there; otherwise an empty local placeholder is created on first `init`. Common entries: `.env`, `CLAUDE.local.md`, `SKILL.md`, `.mcp.json`.
- **`hooks`** — shell commands run inside the worktree after warp / before collapse. The default `on_warp` invokes `.worm/scripts/setup.sh`; drop your install commands there (`npm install`, `pip install -r requirements.txt`, `bundle install`, …) instead of editing the JSON. A non-zero `on_warp` warns but does not abort the warp. `on_collapse` (none by default) runs before the worktree is removed; a non-zero exit aborts unless `--force` is passed. Note that `worm collapse` independently refuses on uncommitted changes regardless of hooks — `--force` is required to discard them.

### Hook environment

Hook commands (and any script they invoke, like `setup.sh`) receive these env vars:

| Variable | Value |
|---|---|
| `WORM_PROJECT_ROOT` | Absolute path to the project root. |
| `WORM_SLOT` | Slot name being acted on (e.g. `uni-0`). |
| `WORM_SLOT_INDEX` | The numeric, 0-based slot index (e.g. `0` for `uni-0`). Handy for derived values: `PORT=$((8080 + WORM_SLOT_INDEX))`. |
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
