# src/ — architecture

This directory holds the entire `worm` CLI implementation. The code is layered top-down: the entry point parses CLI flags, dispatches to a command, which composes core modules, which lean on utilities. Lower layers never import from higher ones.

```
cli.ts
  └─ commands/        ← one file per `worm <verb>`; orchestration only
       └─ core/       ← domain logic; pure(ish) and reusable
            └─ utils/ ← logger, errors, exec, fs primitives
```

## The model in one paragraph

A worm project is a **normal git clone** — the **main worktree** (`~/git/<repo>/`), kept on `baseBranch`. Work in progress lives in **linked worktrees** under `<root>/.claude/worktrees/<name>`: the layout Claude Code and Claude Desktop use, and worm is the `WorktreeCreate`/`WorktreeRemove` hook they call, so every creator (worm, the CLI, Desktop, a dashboard) converges on one code path. The set of worktrees is **emergent** — whatever `git worktree list` reports. A **slot** is separate: a number (0…`slots.max`) a worktree borrows to run its stack; the profile's `slots.json` is the only record of who holds what, and holding one is what makes a worktree get an env file. The `.worm/` directory in the main worktree is (almost) all **pointers into the profile** (`~/.worm/projects/<name>/`): `config.json`, `scripts`, `recipes`, and `logs` are symlinks, plus a local `.gitignore`. The durable per-project state (recipe artifacts, logs, the managed-link manifest, slots.json) lives in the profile and survives a reclone.

## Layers

### `cli.ts`
Commander setup. Wires each subcommand to its `run*` function and centralises error handling: `WormError` → friendly message + hint; everything else → message (+ stack if `WORM_DEBUG=1`). No business logic lives here.

### `commands/`
One file per command. Each exports a single `runX(args, options)` async function. Commands are the *only* layer that calls `logger.*`; core modules stay silent so they're reusable from tests and future programmatic APIs.

| File | Responsibility |
|---|---|
| `clone.ts` | `git clone <url>` (normal, non-bare) → `bindProject`. The recommended entry point. |
| `init.ts` | Bind the current clone (its main worktree). Lazily provisions `~/.worm/` on first run, writes the structural symlinks (`config.json`, `scripts/`), provisions `shared_paths`, seeds the managed-link manifest, and excludes `.worm/` via `.git/info/exclude`. Idempotent. |
| `worktree.ts` | `add <branch>` / `rm <ref>` / `ls` / `path <ref>` — thin wrappers over `core/worktrees.ts` (create + wire + `on_create`; release + `on_remove` + strip + `git worktree remove`). |
| `slot.ts` | `ls` / `assign [wt] [n]` / `release [ref]` / `current` — over `core/slots.ts` + `assignSlot`/`releaseSlot`. |
| `sync.ts` | Declarative reconcile of every worktree (adoption plan first, then `wireWorktree` each); GCs manifest entries for vanished worktrees; writes `project.json` and the VS Code workspace file (folders never rewritten). Idempotent. `--global` reconciles HOME-scope links (`~/<tail>` → `~/.worm/shared/<tail>`) **and** installs/strips global-scope recipes (`autosync`) into `~/.claude/settings.json` via `applyGlobalRecipeWiring`. |
| `wire.ts` | `worm wire [path]` — `wireWorktree` on one worktree (one worm didn't create, or one to repair). |
| `detach.ts` | `worm detach <file>` — replace a shared symlink with a local real copy in the current worktree, drop it from the manifest, and record it in the detach registry (so adoption/reconcile leave it alone). Reversible by deleting the file + `worm sync`. |
| `status.ts` | List worktrees with their slots, render a table or `--json`. |
| `destroy.ts` | Remove linked worktrees + `.worm/` + the global profile. **The main worktree is left intact.** |
| `hook.ts` | `worm hook worktree-create` / `worktree-remove` — Claude Code's worktree hooks, installed machine-wide by `sync --global` (stdout reserved for the path; logs and child output go to stderr; idempotent by name; Claude's default behaviour in a repo that isn't a worm project). `worm hook trigger <event>` — internal recipe-hook dispatcher invoked by each worktree's `settings.local.json` (one static entry per event). Events: `pre-tool-use` (filter), `user-prompt-submit` (context), `session-start` / `session-end` / `stop` / `permission-request` (run). Resolves the live worktree (cheaply — no `git worktree list`), runs enabled **project-scope** recipes with injected env, and owns logging. `--global` runs **global-scope** recipes (`autosync`, `notifyPendingInput`, `syncGlobalPermissions`) from `~/.worm/config.json` with NO project context (the form `worm sync --global` writes into `~/.claude/settings.json`); it forwards stdin so payload-reading recipes (`notifyPendingInput`) work. Must never throw; fails open on the hot path. Recipe scripts live in `src/recipes/<name>/`; shared script helpers (the notification backend, the three-way settings merge) in `src/recipes/_lib/`. |
| `template.ts` | `worm template render <file> KEY=VALUE …` — render a `{{var}}` template file to stdout (worm's templating primitive, for user setup scripts). |
| `path.ts` / `shell-init.ts` / `completion.ts` | Navigation helpers (`worm path`/`worm cd` by name, branch or slot), shell wrapper, and tab-completion. |

### `core/`
Domain primitives. Pure functions where possible; the only side effects are filesystem and `git`.

| File | Owns |
|---|---|
| `paths.ts` | **Single source of truth** for every path. `globalRoot()` honours `WORM_HOME`. `worktreesDir`/`worktreeDir` define the `.claude/worktrees/<name>` layout; `slotsFile`, `projectFile`, `workspaceFile`, `globalProject{Recipes,Logs}Dir` the durable profile state; `managedLinksFile(projectName)` the manifest; `claudeProjectsDir`/`claudeSlug` Claude's per-project dirs. |
| `layout.ts` | `ensureLocalLayout` makes `.worm/recipes` & `.worm/logs` symlinks into the profile (and gitignores generated logs). Run on init/sync/worktree add. |
| `project.ts` | `findMainRoot()` (via `git rev-parse --git-common-dir`) is the root resolver used by every command but `init`/`clone`, which use `gitToplevel()`. Retains a legacy `isBareCloneContainer` detector for a future `worm migrate`. |
| `config.ts` | Load / save / validate `Config` via zod (`.strict()`, parsed as-is — no legacy normalization). |
| `templates.ts` | Seed `~/.worm/templates/default/` and resolve a template (override → global default → built-in) into a `Config` + `scripts/`. |
| `git.ts` | Typed wrappers for `git worktree {add,remove,list,prune}` (add takes a `base` for new branches), `currentBranch`, branch/ref lookups, `fetchBranch` (bounded), `deleteMergedBranch`, `dirtyFiles`. Parses porcelain output. Also `gitCommonDir` + `ensureGitExclude` (idempotent add to the shared `info/exclude`, used for `.worm/`, `.claude/worktrees/`, `.worktree-keep`, `settings.local.json` and the env file). |
| `env.ts` | The slot env file: `stableHash`/`portOffset` (deterministic, branch-keyed), the expression evaluator (numbers and text over `index`/`offset`/`hash`/`name`/`branch`/`profile`/`root`/`worktree`; `+ - * / %`, `== !=`, `?:`, string `+`), `renderEnvFile`, `applyEnv` (render-if-changed with a context, delete without one; git-exclude), and `assertNoEnvCollision`. Distinct from `utils/template.ts` — only this evaluator does arithmetic inside `{{ … }}`. |
| `symlinks.ts` | `ensureSymlink()` — idempotent, prefers relative paths, refuses to overwrite real files. |
| `links.ts` | The managed-link manifest (in the profile): `reconcileWorktreeLinks` (links each slot's tails straight at their resolved source, absolute; sprouts a missing profile source, skips a missing external one; create/prune, deref-guarded on BOTH sides — a real file is never clobbered, and the manifest stores only tails actually maintained as symlinks) and `stripWorktreeLinks` (before worktree removal). Also the **detach registry** (`.detached-links.json`): `readDetached`/`writeDetached`/`liveDetached` (self-healing — a deleted local file re-attaches). |
| `stores.ts` | `resolveStoreLinks` maps `shared_paths` to concrete sources: bare/`{path}` → the profile store; `{path, store}` → that named store's `root` (project `stores` override global `~/.worm/config.json` ones), cloning a missing root from its `url` on demand. |
| `global-links.ts` | HOME-scope analogue of `links.ts`: `reconcileGlobalLinks` links `~/<tail>` → `~/.worm/shared/<tail>` for `worm sync --global`, with its own manifest (`~/.worm/.managed-links.json`). |
| `hooks.ts` | Runs the four lifecycle hooks with inherited stdio (redirected to stderr when stdout is reserved) and `WORM_*` env (`hookEnv`). |
| `worktrees.ts` | The worktree model: `openProject`, `listProjectWorktrees` (git + slots.json), `resolveWorktreeRef` (name / branch / slot / explicit path), `worktreeNameForBranch`, `wireWorktree` (links, env, Claude project-dir link, keep marker, recipe + worktree hooks), `createWorktree`, `removeWorktree`, `assignSlot` / `releaseSlot`. |
| `slots.ts` | `slots.json` I/O (atomic write; entries whose worktree is gone read as free) and the pure `chooseSlot` (idempotent, explicit, lowest free; range/holder errors). |

### `utils/`
Cross-cutting helpers. No domain knowledge here.

| File | Owns |
|---|---|
| `errors.ts` | `WormError` with optional `hint`. Throw this for any user-facing failure. |
| `logger.ts` | picocolors-wrapped `info` / `step` / `success` / `warn` / `error` / `hint`. Consistent tone in one place. `reserveStdout()` sends everything to stderr for commands whose stdout is a machine answer (`hook worktree-create`, `--json`). |
| `fs.ts` | `pathExists`, `isDirectory`, `isSymlink`, `ensureDir`, `readJson` / `writeJson`, `readSymlinkTarget`. |
| `exec.ts` | `run` (no throw), `runOrThrow` (throws `WormError` with stderr), `runShell` (for hooks). |
| `template.ts` | `renderTemplate(tmpl, vars)` — strict `{{var}}` substitution (worm's one rendering primitive; leaves shell `${VAR}` untouched). Used by recipe scaffolds and `worm template render`. |

### `types.ts`
Shared types and the canonical `ConfigSchema` (zod) + `DEFAULT_CONFIG` + `RecipesSchema` / `SandboxRecipeSchema` + `StoreSchema` / `SharedPathSchema` (the `string | {path, store}` union) + `EnvSchema` (the optional per-worktree `env` block). Everything that touches config imports from here.

## Key invariants

These are easy to break and hard to debug — keep them in mind when touching the code.

1. **The main worktree is the clone itself.** Resolve it via `findMainRoot` (git common dir → parent). `.worm/` and `.claude/worktrees/` are hidden from `git status` via `.git/info/exclude`.

2. **Worktrees are emergent; slots are recorded.** `listProjectWorktrees` reads `git worktree list`; a worktree's slot comes only from `slots.json`. Never derive a slot from a path or a name.

3. **Symlinks point at the profile (absolute).** `.worm/` is (almost) all pointers into `~/.worm/projects/<name>/`, and each worktree's shared-path tunnels link **straight at the profile source**. `core/layout.ts:ensureLocalLayout` establishes this.

4. **The managed-link manifest is the source of truth for injected links.** It lives in the profile; `sync`/`rm`/`destroy` only touch links recorded there, and the prune skips a link that became a real file. Strip managed links before `git worktree remove`.

5. **All paths route through `core/paths.ts`.** No string concatenation of path segments elsewhere.

6. **Commands are idempotent.** Re-running `init`, `sync`, `wire`, `slot assign`, or Claude's `worktree-create` hook with the same input produces the same end state.

7. **stdout is sacred where it's an answer.** `worm hook worktree-create` prints the path and nothing else — Claude reads it. Anything that may log on such a path must go through `logger` (which honours `reserveStdout`) and child processes through `runShell` with inherited stdio.

8. **Templates are seeded, not symlinked.** Each project owns its own copy of `config.json` and `scripts/setup.sh` after creation.

9. **Never destroy the main worktree.** `worktree rm`, `hook worktree-remove` and `destroy` all refuse or skip it.

## Adding a new command

1. Add a file in `commands/` exporting `runX(args, options)`.
2. Register it in `cli.ts` with its commander definition.
3. Throw `WormError` (with `hint`) for any failure that the user might cause; let other errors bubble up to the global handler.
4. Use `logger.*` for output — never `console.log` directly.
5. Add an e2e case in `../tests/cli.test.mjs`.
