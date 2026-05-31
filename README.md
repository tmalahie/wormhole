# wormhole

> A hub for your coding agents — one git-tracked home for their config and instructions, the tooling to maintain it, and a warm pool of worktrees to run several at once.

A coding agent is only as good as its setup: the right instructions and skills, an allowlist of commands it may run unattended, a sandbox around the ones you don't fully trust, and room to work without colliding with the next agent. That setup is usually ad-hoc, trapped on one machine, and untracked — and it falls apart the moment you run more than one agent on a project.

`worm` turns it into a managed, version-controlled layer with three parts:

- **A meta-repo for your agents — `~/.worm`.** A single git repository holds the config and instructions for every project's agents: `CLAUDE.md`, skills, slash commands, settings, the permission allowlist, the sandbox policy. Because it's just git, your agent setup is reviewable, shareable, and portable — re-clone a machine and your agents come back configured.
- **Tooling to maintain that config — recipes.** Composable capabilities you switch on per project: a Docker **sandbox** that keeps filesystem-mutating commands off the host, **permission sync** so approving a command in one slot teaches every agent, **shared history** across worktrees. `worm sync` reconciles everything declaratively; templates seed new projects.
- **Tooling to run agents in parallel — a warm worktree pool.** Permanent `git worktree` slots let several agents work different branches at once without trampling each other. Think of them as **parallel universes** of your repo: your main clone is **Slot 0**, siblings are `<repo>-1`, `<repo>-2`, … Each universe is isolated, always-warm (no re-`npm install` per task), and wired with the same shared config via tunnels - this is where `wormhole` gets its name from.

The worktree pool used to be the whole story; now it's the backend. The product is the cognitive layer it serves — the git-tracked home that keeps your agents consistent, contained, and reproducible across every universe.

> Built around **Claude Code** today (the recipes wire Claude's hooks and settings) on a deliberately agent-agnostic core — the pool, tunnels, and lifecycle hooks don't care which agent you run.

---

## Install

```bash
pnpm install
pnpm build
pnpm link --global    # exposes the `worm` binary
```

Requires Node ≥ 20 and git ≥ 2.31.

### Shell integration (recommended)

Add this to your `~/.zshrc` (or `~/.bashrc`):

```bash
eval "$(worm shell-init)"
eval "$(worm completion zsh)"    # or `bash`
```

- `worm shell-init` installs a `worm()` wrapper so `worm cd <branch>` / `worm tp <N>` actually change your shell's working directory.
- `worm completion <shell>` registers tab completion: subcommand names (`worm sta<tab>` → `worm status`), branch completion for `switch`, and slot/branch completion for `cd` / `tp` / `path`.

## Quick start

```bash
# Clone a repo and bind it as Slot 0 (a normal clone — no bare container).
worm clone https://github.com/you/mkpc.git ~/git/mkpc
cd ~/git/mkpc

# Day to day, just switch branches in place — Slot 0 stays warm.
git switch my-feature        # or: worm switch my-feature   (also re-runs setup.sh)

# Want a second branch checked out at the same time? Add a permanent universe.
worm universe add my-other-feature        # creates ~/git/mkpc-1, runs setup.sh
worm cd my-other-feature                   # hop into it

# See the whole pool.
worm status

# Done with a universe? Collapse it (Slot 0 can never be removed).
worm universe rm my-other-feature
```

`worm sync` reconciles your shared-file tunnels across every slot (run it after editing `shared_paths`). Drop your install commands into [.worm/scripts/setup.sh](#configuration) — it runs on `worm universe add` and `worm switch`.

## Commands

| Command | What it does |
|---|---|
| `worm clone <url> [path] [--name X] [--template <dir>] [--skip-hook]` | Recommended entry point. Normal-clones `<url>`, binds it as Slot 0, and warms it via `on_create`. |
| `worm init [--name X] [--template <dir>] [--skip-hook]` | Bind the current git clone as Slot 0 and warm it via `on_create`. Lazily creates `~/.worm/` on first use. Idempotent. |
| `worm status [--json]` | List every slot in the pool (Slot 0 + siblings) and the branch each is on. |
| `worm universe add <branch> [--create] [--skip-hook]` | Create a permanent sibling worktree on `<branch>` at `<repo>-<N>`, link shared paths, run `on_create`. Refuses a branch already checked out in another slot. |
| `worm universe rm <ref> [--force] [--skip-hook]` | Remove a sibling universe — `<ref>` is a slot index or a branch. Refuses Slot 0; refuses uncommitted changes unless `--force`; runs `on_remove`. |
| `worm switch <branch> [--create] [--skip-hook]` | `git switch <branch>` in the current slot and re-run the warm-up hook. (Plain `git switch` works too — this just adds the hook + the "branch held elsewhere" guard.) |
| `worm sync` | Declaratively reconcile shared-path links across all slots: create missing tunnels, prune removed ones. Idempotent. |
| `worm cd <branch>` / `worm tp <N>` | Change directory into a slot by branch name or 0-based index. Requires the shell-init wrapper. |
| `worm path <ref>` | Print the worktree path for a branch or slot index (what `cd`/`tp` use under the hood). |
| `worm config <key> [value]` | Read or write machine-level worm settings in `~/.worm/config.json` (supported keys: `editor`). `--list` prints everything; `--unset` clears a key. |
| `worm destroy [--force]` | Unbind the project: remove sibling universes, `.worm/`, and the global profile. **Slot 0 (your repo) is left intact.** Prompts unless `--force`. |
| `worm shell-init` | Print the shell function described in [Shell integration](#shell-integration-recommended). |
| `worm completion <bash\|zsh>` | Print a tab-completion script for the chosen shell. |

Run `worm <command> --help` for the full option list. Project-scoped commands resolve Slot 0 via git (`--git-common-dir`), so they work from any slot or subdirectory.

## How it works

For a project named `mkpc` with two extra universes:

```
~/git/
├── mkpc/                              ← Slot 0: the primary working tree (a normal clone)
│   ├── .git/                          ← standard git directory (the common dir for all slots)
│   ├── .worm/                         ← local wiring (excluded from git via .git/info/exclude)
│   │   ├── .gitignore                 ← single line: `*`
│   │   ├── .managed-links.json        ← manifest of the symlinks worm created per slot
│   │   ├── config.json                → symlink to ~/.worm/multiverses/mkpc/config.json
│   │   ├── scripts/                   → symlink to ~/.worm/multiverses/mkpc/scripts/
│   │   │   └── setup.sh               ← warm-up hook (edit this!)
│   │   └── shared/                    ← the "tunnel" sources mirrored into every slot
│   │       └── .env                   → ~/.worm/multiverses/mkpc/.env (or local placeholder)
│   └── .env                           → .worm/shared/.env   (a tunnel, on Slot 0)
├── mkpc-1/                            ← sibling universe (worm universe add …)
│   ├── .env                           → ../mkpc/.worm/shared/.env
│   └── …                               (its checked-out branch)
└── mkpc-2/                            ← another sibling universe
```

Slots are **permanent** — there's no spawn/teardown, so they stay warm (your `node_modules`, build state, etc. just persist in each one). Sibling worktrees live one level up so Slot 0's `git status` never sees them, and `.worm/` is hidden from git locally. Shared files are relative symlinks back to Slot 0's `.worm/shared/`, recorded in a manifest so `worm sync` can add/prune them safely.

## Configuration

Each project gets a config at `~/.worm/multiverses/<project-name>/config.json`. The built-in default is intentionally minimal — projects start with no shared files, so worm doesn't presume your stack:

```json
{
  "shared_paths": [],
  "hooks": {
    "on_create": "bash \"$WORM_PROJECT_ROOT/.worm/scripts/setup.sh\""
  },
  "recipes": {}
}
```

Edit the file (or pre-seed a `--template <dir>`) to add what your project needs.

- **`shared_paths`** — files tunnelled from `.worm/shared/` into every slot. If a matching file exists at `~/.worm/multiverses/<project>/<path>`, it's symlinked there; otherwise an empty local placeholder is created on first `init`. Common entries: `.env`, `CLAUDE.local.md`, `.mcp.json`. Run `worm sync` after changing this list.
- **`hooks`** — `on_create` runs inside a slot to warm it up: when Slot 0 is bound (`init` / `clone`), when a sibling is created (`universe add`), and on `switch`. `on_remove` runs before a slot is removed. The default `on_create` invokes `.worm/scripts/setup.sh` — drop your install commands there (`npm install`, `pip install -r requirements.txt`, …) instead of editing the JSON. A non-zero `on_create` warns but doesn't abort; a non-zero `on_remove` aborts the removal unless `--force`. Pass `--skip-hook` to any of these commands to bind/switch without running the hook (e.g. on an already-warm checkout).
- **`recipes`** — composable capabilities, keyed by name (provider-style). A recipe is **enabled iff its key is present**; each value is validated by that recipe's own schema. `init`/`sync`/`universe add` materialize every enabled recipe's artifacts under `.worm/recipes/<name>/` and merge its per-slot hook entries into each slot's `.claude/settings.local.json` (the gitignored, per-slot file). Recipes compose — worm namespaces the entries it owns (their commands reference the `.worm/recipes/` tree), so re-running only strips and re-adds worm's own hooks. Artifacts are materialized **non-clobbering** (so you can edit a generated file and keep it): `worm sync` re-applies hook *wiring* every run, but it will **not** overwrite an existing artifact. To pull in a recipe/engine update, delete the stale artifact (e.g. `rm .worm/recipes/sandbox/Dockerfile`) and re-run `worm sync`. (A dedicated regenerate/upgrade command is on the roadmap — see [docs/recipes-roadmap.md](docs/recipes-roadmap.md).) Recipe hooks (which run silently inside Claude sessions) write to **`.worm/logs/`** — `<container>.log` for the container's `up`/`down` output (including the first build), `<container>-redirect.log` for the sandbox's allow/deny decisions, and `sync-permissions.log` for the permission sync. `tail -f` them to see what fired.
  Built-in recipes (enable by adding the key, e.g. `"recipes": { "sandbox": {}, "syncPermissions": {} }`):
  - **`sandbox`** — `{ "backend": "docker", "image": "node:22-bookworm", "tools": [], "neverSandbox": [...], "exemptDirs": [], "autostart": true, "autostop": false }`. Generates a Dockerfile (from `image` + `tools`), a compose file, and a `redirect-to-sandbox.js` interceptor, then wires each slot so its container auto-starts (`autostart`) and filesystem-mutating commands are redirected into it (mounted at the same path via `$SANDBOX_DIR`). See [docs/strategy-3-spec.md](docs/strategy-3-spec.md) §6.
  - **`syncPermissions`** (`{}`) — wires `SessionStart`/`SessionEnd` hooks that union the `permissions` block of each slot's `settings.local.json` with a canonical store shared across slots (approve a command once, every slot learns it). Merge-preserving — it never touches other recipes' hooks.
  - **`shareHistory`** (`{}`) — symlinks each sibling slot's Claude history dir (`~/.claude/projects/<slot-slug>`) to Slot 0's, so all slots share one conversation history. Refuses to clobber a real history dir (warns instead).

### Hook environment

Hook commands (and any script they invoke, like `setup.sh`) receive:

| Variable | Value |
|---|---|
| `WORM_PROJECT_ROOT` | Absolute path to Slot 0 (the primary working tree). |
| `WORM_SLOT` | Slot name being acted on (`main` for Slot 0, `<N>` for siblings). |
| `WORM_SLOT_INDEX` | The numeric, 0-based slot index. Handy for derived values: `PORT=$((8080 + WORM_SLOT_INDEX))`. |
| `WORM_BRANCH` | Branch name. |
| `WORM_WORKTREE` | This slot's worktree path (equals `WORM_PROJECT_ROOT` for Slot 0). |

### Templates

On first run, `~/.worm/templates/default/` is seeded with a `config.json` and `scripts/setup.sh`. New projects are bootstrapped from that template — edits to it apply to projects created afterwards (existing projects are untouched). Pass `--template <dir>` to bootstrap from a custom directory; it must contain a `config.json`, with an optional `scripts/` subdirectory.

## Environment

| Variable | Effect |
|---|---|
| `WORM_HOME` | Override the global root (default: `~/.worm`). Useful for sandboxes, CI, or multiple worm "homes". |
| `WORM_DEBUG` | Set to `1` to print stack traces on error. |

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test           # runs node:test against the built CLI
pnpm demo           # visual walkthrough in an isolated sandbox
```

See [src/README.md](src/README.md) for architecture and [CLAUDE.md](CLAUDE.md) for agent contributor guidelines.
