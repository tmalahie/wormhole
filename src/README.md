# src/ — architecture

This directory holds the entire `worm` CLI implementation. The code is layered top-down: the entry point parses CLI flags, dispatches to a command, which composes core modules, which lean on utilities. Lower layers never import from higher ones.

```
cli.ts
  └─ commands/        ← one file per `worm <verb>`; orchestration only
       └─ core/       ← domain logic; pure(ish) and reusable
            └─ utils/ ← logger, errors, exec, fs primitives
```

## The model in one paragraph

A worm project is a **normal git clone**. **Slot 0 is the primary working tree itself** (`~/git/<repo>/`, never renamed). Extra slots are permanent sibling worktrees at `~/git/<repo>-<N>`, added on demand. The pool is **emergent** — it's whatever `git worktree list` reports, not a fixed count. There is no bare container and no spawn/teardown: you `git switch` branches in place. The `.worm/` directory at Slot 0 is (almost) all **pointers into the profile** (`~/.worm/multiverses/<name>/`): `config.json`, `scripts`, `recipes`, and `logs` are symlinks, plus a local `.gitignore`. The durable per-project state (recipe artifacts, logs, the managed-link manifest) lives in the profile and survives a slot-0 reclone.

## Layers

### `cli.ts`
Commander setup. Wires each subcommand to its `run*` function and centralises error handling: `WormError` → friendly message + hint; everything else → message (+ stack if `WORM_DEBUG=1`). No business logic lives here.

### `commands/`
One file per command. Each exports a single `runX(args, options)` async function. Commands are the *only* layer that calls `logger.*`; core modules stay silent so they're reusable from tests and future programmatic APIs.

| File | Responsibility |
|---|---|
| `clone.ts` | `git clone <url>` (normal, non-bare) → `bindProject`. The recommended entry point. |
| `init.ts` | Bind the current clone as Slot 0. Lazily provisions `~/.worm/` on first run, writes the structural symlinks (`config.json`, `scripts/`), provisions `shared_paths`, seeds the managed-link manifest, and excludes `.worm/` via `.git/info/exclude`. Idempotent. |
| `universe.ts` | `add <branch>` — create a permanent sibling worktree + run `on_create`. `rm <ref>` — remove a sibling (Slot 0 protected; refuses dirty without `--force`; runs `on_remove`; strips managed links before `git worktree remove`). |
| `switch.ts` | `git switch <branch>` in the current slot + re-run `on_create`. Sugar over plain `git switch`, plus the "branch held elsewhere" guard. |
| `sync.ts` | Declarative reconcile of shared-path links across all slots via the manifest; prunes removed links; GCs manifest entries for vanished slots. Idempotent. `--global` reconciles HOME-scope links instead (`~/<tail>` → `~/.worm/shared/<tail>`). |
| `status.ts` | Enumerate the pool, render a table or `--json`. |
| `destroy.ts` | Remove sibling universes + `.worm/` + the global profile. **Slot 0 is left intact.** |
| `hook.ts` | `worm hook trigger <event>` — internal recipe-hook dispatcher invoked by each slot's `settings.local.json` (one static entry per event). Resolves the live slot, runs enabled recipes' hook commands with injected env, and owns logging. Must never throw; fails open on the hot path. |
| `template.ts` | `worm template render <file> KEY=VALUE …` — render a `{{var}}` template file to stdout (worm's templating primitive, for user setup scripts). |
| `path.ts` / `shell-init.ts` / `completion.ts` / `config.ts` | Navigation helpers, shell wrapper, tab-completion, and machine-level settings. |

### `core/`
Domain primitives. Pure functions where possible; the only side effects are filesystem and `git`.

| File | Owns |
|---|---|
| `paths.ts` | **Single source of truth** for every path. `globalRoot()` honours `WORM_HOME`. `siblingWorktreeDir`/`SLOT_DIR_INFIX` define the `<repo>-<N>` layout; `globalProject{Recipes,Logs}Dir` the durable profile state; `managedLinksFile(projectName)` the manifest (now in the profile). |
| `layout.ts` | Consolidation: `ensureLocalLayout` makes `.worm/recipes` & `.worm/logs` symlinks into the profile (migrating old real dirs in place) and moves the manifest there; `removeLegacyShared` sweeps the old `.worm/shared`. Run on init/sync/universe-add. |
| `project.ts` | `findSlot0Root()` (via `git rev-parse --git-common-dir`) is the root resolver used by every command but `init`/`clone`, which use `gitToplevel()`. Retains a legacy `isBareCloneContainer` detector for a future `worm migrate`. |
| `config.ts` | Load / save / validate `Config` via zod (`.strict()`, parsed as-is — no legacy normalization). |
| `templates.ts` | Seed `~/.worm/templates/default/` and resolve a template (override → global default → built-in) into a `Config` + `scripts/`. |
| `git.ts` | Typed wrappers for `git worktree {add,remove,list,prune}`, `switchBranch`, `currentBranch`, branch lookups, `dirtyFiles`. Parses porcelain output. |
| `symlinks.ts` | `ensureSymlink()` — idempotent, prefers relative paths, refuses to overwrite real files. |
| `links.ts` | The managed-link manifest (in the profile): `reconcileSlotLinks` (links each slot's tails straight at their resolved source, absolute; sprouts a missing profile source, skips a missing external one; create/prune, deref-guarded) and `stripSlotLinks` (before worktree removal). |
| `stores.ts` | `resolveStoreLinks` maps `shared_paths` to concrete sources: bare/`{path}` → the profile store; `{path, store}` → that named store's `root` (project `stores` override global `~/.worm/config.json` ones), cloning a missing root from its `url` on demand. |
| `global-links.ts` | HOME-scope analogue of `links.ts`: `reconcileGlobalLinks` links `~/<tail>` → `~/.worm/shared/<tail>` for `worm sync --global`, with its own manifest (`~/.worm/.managed-links.json`). |
| `hooks.ts` | Runs `on_create`/`on_remove` with inherited stdio and `WORM_*` env (`hookEnv`). |
| `universe.ts` | `scanUniverses()` builds the slot list from `git worktree list` (Slot 0 + matched siblings); `resolveSlotRef` / `findSlotByBranch` / `nextFreeIndex` / `universeLabel`. |

### `utils/`
Cross-cutting helpers. No domain knowledge here.

| File | Owns |
|---|---|
| `errors.ts` | `WormError` with optional `hint`. Throw this for any user-facing failure. |
| `logger.ts` | picocolors-wrapped `info` / `step` / `success` / `warn` / `error` / `hint`. Consistent tone in one place. |
| `fs.ts` | `pathExists`, `isDirectory`, `isSymlink`, `ensureDir`, `readJson` / `writeJson`, `readSymlinkTarget`. |
| `exec.ts` | `run` (no throw), `runOrThrow` (throws `WormError` with stderr), `runShell` (for hooks). |
| `template.ts` | `renderTemplate(tmpl, vars)` — strict `{{var}}` substitution (worm's one rendering primitive; leaves shell `${VAR}` untouched). Used by recipe scaffolds and `worm template render`. |

### `types.ts`
Shared types and the canonical `ConfigSchema` (zod) + `DEFAULT_CONFIG` + `RecipesSchema` / `SandboxRecipeSchema` + `StoreSchema` / `SharedPathSchema` (the `string | {path, store}` union). Everything that touches config imports from here.

## Key invariants

These are easy to break and hard to debug — keep them in mind when touching the code.

1. **Slot 0 is the primary working tree.** Resolve it via `findSlot0Root` (git common dir → parent). Because Slot 0 is a real checkout, `.worm/` is hidden from `git status` via `.git/info/exclude` (`init.ts:ensureGitExclude`).

2. **The pool is emergent.** `scanUniverses` reads `git worktree list`; a slot is Slot 0 (path === root) or a sibling matching `<repo>-<N>` one level up. No `universes_count`.

3. **Symlinks point at the profile (absolute).** Post-consolidation, `.worm/` is (almost) all pointers into `~/.worm/multiverses/<name>/`: `config.json`, `scripts`, `recipes`, and `logs` are symlinks, and each slot's shared-path tunnels link **straight at the profile source** (`<slot>/<tail>` → `profile/<tail>`, absolute — the old `.worm/shared` two-hop is gone). `core/layout.ts:ensureLocalLayout` establishes this and migrates an old project in place.

4. **The managed-link manifest is the source of truth for injected links.** It lives in the **profile** (`~/.worm/multiverses/<name>/.managed-links.json`), so `readManifest`/`writeManifest` take the project name. `sync`/`rm`/`destroy` only touch links recorded there, and the prune skips a link that became a real file. Strip managed links before `git worktree remove`.

5. **All paths route through `core/paths.ts`.** No string concatenation of path segments elsewhere. The `<repo>-<N>` naming lives on one constant (`SLOT_DIR_INFIX`).

6. **Commands are idempotent.** Re-running `init`, `sync`, or `universe add` on the same input produces the same end state. `sync` is fully declarative.

7. **Templates are seeded, not symlinked.** Each multiverse owns its own copy of `config.json` and `scripts/setup.sh` after creation — editing a template later does not affect existing projects.

8. **Never destroy Slot 0.** `universe rm` refuses it; `destroy` sweeps only siblings.

## Adding a new command

1. Add a file in `commands/` exporting `runX(args, options)`.
2. Register it in `cli.ts` with its commander definition.
3. Throw `WormError` (with `hint`) for any failure that the user might cause; let other errors bubble up to the global handler.
4. Use `logger.*` for output — never `console.log` directly.
5. Add an e2e case in `../tests/cli.test.mjs`.
