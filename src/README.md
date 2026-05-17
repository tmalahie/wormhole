# src/ — architecture

This directory holds the entire `worm` CLI implementation. The code is layered top-down: the entry point parses CLI flags, dispatches to a command, which composes core modules, which lean on utilities. Lower layers never import from higher ones.

```
cli.ts
  └─ commands/        ← one file per `worm <verb>`; orchestration only
       └─ core/       ← domain logic; pure(ish) and reusable
            └─ utils/ ← logger, errors, exec, fs primitives
```

## Layers

### `cli.ts`
Commander setup. Wires each subcommand to its `run*` function and centralises error handling: `WormError` → friendly message + hint; everything else → message (+ stack if `WORM_DEBUG=1`). No business logic lives here.

### `commands/`
One file per command. Each exports a single `runX(args, options)` async function. Commands are the *only* layer that calls `logger.*`; core modules stay silent so they're reusable from tests and future programmatic APIs.

| File | Responsibility |
|---|---|
| `init.ts` | Provision `~/.worm/`, write template config, `git init` the personal repo. |
| `register.ts` | Create/refresh global profile + local layout, write gitignore, provision empty slot folders. Idempotent. |
| `scan.ts` | Walk slots, render table or `--json`. |
| `warp.ts` | Pick free slot → `git worktree add src/` → inject anchor + shared symlinks → run `on_warp`. |
| `collapse.ts` | Run `on_collapse` → strip injected symlinks → `git worktree remove` → prune. |

### `core/`
Domain primitives. Pure functions where possible; the only side effects are filesystem and `git`.

| File | Owns |
|---|---|
| `paths.ts` | **Single source of truth** for every path the CLI touches. If you need a path, get it here — never hardcode. `globalRoot()` honours `WORM_HOME`. |
| `project.ts` | Walk up to find `.git`, derive project name, append entries to `.gitignore`. |
| `config.ts` | Load / save / validate `Config` via zod. Distinguishes global (`~/.worm/multiverses/<name>/config.json`) from local (`.worm/config.json`, which is itself a symlink to global). |
| `git.ts` | Typed wrappers for `git worktree {add,remove,list,prune}`, `branch` lookups. Parses porcelain output. |
| `symlinks.ts` | `ensureSymlink()` — idempotent, prefers relative paths, refuses to overwrite real files. |
| `hooks.ts` | Runs user-supplied shell commands with inherited stdio and a captured exit code. |
| `universe.ts` | Combines `scanUniverses()` with the live git worktree list to classify each slot as `STABLE` / `ACTIVE` / `BROKEN`. Exposes `pickFreeSlot` / `findSlotByBranch`. |

### `utils/`
Cross-cutting helpers. No domain knowledge here.

| File | Owns |
|---|---|
| `errors.ts` | `WormError` with optional `hint`. Throw this for any user-facing failure. |
| `logger.ts` | picocolors-wrapped `info` / `step` / `success` / `warn` / `error` / `hint`. Consistent tone in one place. |
| `fs.ts` | `pathExists`, `isDirectory`, `isSymlink`, `ensureDir`, `readJson` / `writeJson`, `readSymlinkTarget`. |
| `exec.ts` | `run` (no throw), `runOrThrow` (throws `WormError` with stderr), `runShell` (for hooks). |

### `types.ts`
Shared types and the canonical `ConfigSchema` (zod) + `DEFAULT_CONFIG`. Everything that touches config imports from here.

## Key invariants

These are easy to break and hard to debug — keep them in mind when touching the code.

1. **The `src/` trick.** `git worktree add` rejects non-empty targets, so the worktree must live at `slot/src/`. Anchors stay at `slot/<anchor>/` and are linked into `src/` after the worktree is created. See [warp.ts](commands/warp.ts).

2. **Anchor dirs are pre-created before symlinking.** A symlink to a missing target silently breaks writes through it on some systems. `warp.ts:prepareAnchorDirs` runs before any link is made.

3. **Relative vs absolute symlinks.** Links inside `src/` use relative targets (`../node_modules`) so a slot survives being moved. Links that cross repos (`.worm/config.json` → `~/.worm/...`) are absolute because relative paths across repos are fragile.

4. **Collapse strips its own symlinks first.** Otherwise git considers them untracked files and refuses to remove the worktree. The user's real changes are still protected by the `on_collapse` hook (default: `git stash -u`) and the `--force` escape hatch.

5. **All paths route through `core/paths.ts`.** If you need to compute a path, add a function there. No string concatenation of path segments elsewhere.

6. **Commands are idempotent.** Re-running `register` or `warp` on the same input should produce the same end state. `ensureSymlink` and `ensureDir` are the workhorses here.

## Adding a new command

1. Add a file in `commands/` exporting `runX(args, options)`.
2. Register it in `cli.ts` with its commander definition.
3. Throw `WormError` (with `hint`) for any failure that the user might cause; let other errors bubble up to the global handler.
4. Use `logger.*` for output — never `console.log` directly.
5. Add an e2e case in `../tests/cli.test.mjs`.
