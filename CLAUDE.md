# Agent guidelines

This file briefs AI coding agents on the conventions of the `worm` codebase. Read [src/README.md](src/README.md) first for the architecture; this doc only covers the non-obvious rules.

## Commands

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/cli.js
pnpm test        # rebuilds then runs e2e tests against the built CLI
pnpm demo        # rebuilds, then runs scripts/demo.sh in an isolated sandbox
```

Tests run the built binary in an isolated `WORM_HOME` per case (see [tests/helpers.mjs](tests/helpers.mjs)). They are the authoritative spec — if you change behaviour, update tests in the same change.

### Testing & demo conventions

These pnpm scripts are pre-approved in [.claude/settings.local.json](.claude/settings.local.json) so they run without permission prompts. Always reach for them first:

- Correctness checks → `pnpm test` (and `pnpm typecheck` for type-only changes).
- Eyeballing themed CLI output → `pnpm demo`. Edit [scripts/demo.sh](scripts/demo.sh) if you want to extend the walkthrough; do not re-derive it as an ad-hoc bash heredoc.
- Running `worm` directly against the built CLI → `pnpm worm -- <args>` (e.g. `pnpm worm -- status --json`). This is also whitelisted.

If you genuinely need a new repeatable workflow, add a pnpm script + a file under `scripts/`. One-shot bash heredocs are slow to approve and leave no artifact for the next agent.

## Project intent

`worm` keeps a **permanent, emergent pool of warm `git worktree` slots** on a normal clone, plus a personal cognitive layer (shared "tunnel" files, hooks, and — opt-in — a command sandbox). **Slot 0 is the primary working tree itself**; extra slots are sibling worktrees added on demand. Goals, in priority order:

- **(a)** slots stay warm — they're permanent, so there is no spawn/teardown cost; `git switch` in place is the daily driver.
- **(b)** the same branch never lives in two slots — git itself enforces this; worm surfaces it as a clean error rather than a raw `fatal:`.
- **(c)** the cognitive layer is the real product — the worktree topology exists to serve it, not the other way around.

Keep that in mind when reviewing changes: a "clever" addition that breaks idempotency, removes Slot 0's protection, or silently mutates the managed-link manifest is a regression even if it passes typecheck.

## Conventions

### Errors
- Throw `WormError` (from `src/utils/errors.ts`) for any failure caused by the user or environment. Always pass a `hint:` with the next action they should take. The global handler in `cli.ts` renders it cleanly.
- Let unexpected errors (bugs) bubble up — they'll be printed with a stack trace when `WORM_DEBUG=1`.

### User-facing output
- Every line of CLI output goes through `logger.*`. Do not call `console.log` / `console.error` directly outside of `cli.ts` and the json branch of `status.ts`.
- Tone: `info` for intent, `step` for substeps, `success` at the end, `warn` for recoverable issues, `error` only via thrown `WormError`.
- **Vocabulary is themed.** Keep it consistent: `🪐` wormhole / global root, `🌌` add a universe, `🚀` active slot / switch, `💫` collapse (remove a universe), `🔗` shared "anomaly"/tunnel, `🪢` worktree, `⚡` hook, `🎯` target, `🛸` init / binding Slot 0, `🌀` adopt (move a real slot file into the profile + link it), `📐` template, `🌱` sprouted local placeholder, `📝` gitignore write, `🧹` swept links, `💥` broken / error, `✨` success, `💡` hint. New messages should pick from this palette rather than introducing a new emoji per command.

### Paths
- All filesystem locations come from `src/core/paths.ts`. If you need a new one, add a function there — never concatenate path segments at the call site. The slot-dir naming (`<repo>-<N>`) is centralised on `SLOT_DIR_INFIX`; the builder (`siblingWorktreeDir`), the parser (`universe.ts`), and shell completion all derive from it.
- `globalRoot()` honours `WORM_HOME`. Tests rely on this; don't bypass it with direct `os.homedir()` calls.

### Root resolution
- Slot 0 is found with `findSlot0Root()` (`core/project.ts`) — it asks git for `--git-common-dir` and takes its parent, then checks `.worm/` exists. This works from any slot. Use it everywhere a command needs the root, EXCEPT `init`/`clone`, which bind a not-yet-`.worm`'d repo and so use `gitToplevel()`.

### Symlinks
- Use `ensureSymlink()` from `src/core/symlinks.ts`. It's idempotent and refuses to clobber real files. Don't call `fs.symlink` directly.
- `.worm/` is (almost) all pointers into the profile (`~/.worm/projects/<name>/`): `config.json`, `scripts`, `recipes`, and `logs` are symlinks; durable state (recipe artifacts, logs, the manifest) lives in the profile. `core/layout.ts:ensureLocalLayout` establishes this; it runs on init/sync/universe-add.
- Each slot's shared-path tunnels link **straight at the profile source** (`<slot>/<tail>` → `profile/<tail>`, **absolute** — the old `.worm/shared` two-hop is gone). All cross-repo links pass `{ relative: false }`.
- Shared-path links are tracked in the **managed-link manifest**, now in the **profile** (`~/.worm/projects/<name>/.managed-links.json`), so `readManifest`/`writeManifest`/`reconcileSlotLinks` take the **project name** (not slot0Root). Reconcile/prune through `core/links.ts` so worm only ever touches links it created — never structural wiring or real user files. Reconcile is deref-guarded on **both** sides: a managed link that became a real file is left alone (prune side), and a real file where a tunnel is desired is skipped instead of clobbered (create side, which would otherwise make `ensureSymlink` throw). The manifest stores only tails actually maintained as symlinks this run.
- **Decoupling from the pool.** `worm wire [path]` (`commands/wire.ts`) applies the cognitive layer — tunnels + `env` + recipe hooks — to a worktree worm didn't create (e.g. a Conductor/worktrunk worktree), reusing the same core primitives against an arbitrary path. `worm detach <file>` (`commands/detach.ts`) is the per-slot inverse of adopt: it turns one slot's tunnel into a local real copy. Detached tails are recorded in the **detach registry** (`.detached-links.json` in the profile; `readDetached`/`writeDetached`/`liveDetached`) so adoption AND reconcile skip them — needed because the manifest alone can't tell an intentional detach from a not-yet-adopted local file. The registry self-heals: delete the local file and `worm sync` re-attaches the tunnel.

### Slot edge cases
- **Slot 0 is a real working tree**, so git would otherwise see `.worm/` as untracked. `init.ts:ensureGitExclude` adds `/.worm/` to `.git/info/exclude` (local, not the tracked `.gitignore`).
- Before `git worktree remove` (in `universe rm`/`destroy`), strip the managed symlinks first (`links.ts:stripSlotLinks`) — git treats them as untracked files and refuses removal otherwise.
- **Never `worktree remove` or `rm -rf` Slot 0.** `universe rm` refuses it explicitly; `destroy` only sweeps siblings. Slot 0 is the user's actual checkout.

### Idempotency
- `init`, `sync`, and `universe add`/`rm` may be re-run after partial failure. Always reach for `ensureDir`, `ensureSymlink`, and `writeTextIfMissing` rather than raw create operations. If you write something destructively, gate it behind `--force`. `sync` is declarative — running it twice is a no-op.
- `worm init` lazily provisions `~/.worm/` on first run (detected via the existence of `~/.worm/projects/`, not the root itself — the root can be pre-created in sandboxes). Do not bypass `ensureGlobalRoot` from other commands; if a future command needs the global root, call it from `init` flows only.

### Hooks
- User-supplied commands always run through `runShell()` (not `run()`), with `inheritStdio: true`. They get the full shell, including pipes and `&&`.
- Lifecycle hooks are `on_create` (a slot is created via `universe add`, and on `switch`) and `on_remove` (a slot is removed). A non-zero exit from `on_remove` aborts the removal unless `--force` is set. `on_create` failures are warned but not fatal — the worktree exists either way.
- Hooks receive `WORM_PROJECT_ROOT` (Slot 0), `WORM_SLOT` (`main` / `<N>`), `WORM_SLOT_INDEX` (0-based numeric), `WORM_BRANCH`, `WORM_WORKTREE` (this slot's path; equals `WORM_PROJECT_ROOT` for Slot 0), `WORM_BRANCH_HASH` / `WORM_PORT_OFFSET` (stable per-branch), and `WORM_PROFILE` (the durable profile dir `~/.worm/projects/<name>/`, honouring `WORM_HOME` — for hooks that reach into profile-owned shared state). Build the env with `hookEnv(slot0Root, slot, branch, projectName)` from `core/hooks.ts` — don't inline the object at the call site.
- The default `on_create` invokes `bash "$WORM_PROJECT_ROOT/.worm/scripts/setup.sh"`. Users edit `setup.sh` rather than the JSON config. Don't change the hook-command default without also updating the seeded `setup.sh` template.
- **Recipe** hook events (distinct from the user lifecycle hooks above) are normalized in `core/recipes.ts:HOOK_EVENTS`: `pre-tool-use`, `user-prompt-submit`, `session-start`, `session-end`, `stop` (Claude's `Stop`, end of each turn). Add a new event there (it maps to a Claude settings key + a `HookKind`) and the dispatcher/wiring pick it up automatically.
- **Recipe scope.** A recipe is `scope: "project"` (default) or `"global"` (`Recipe.scope`). Project recipes are wired per-slot into `settings.local.json` by `worm sync` / `universe add`, and dispatched by `worm hook trigger <event>` (resolves the slot from cwd). Global recipes — **`autosync`**, **`notifyPendingInput`**, **`syncGlobalPermissions`** — are declared in the **global** `~/.worm/config.json` `recipes` block, wired by `worm sync --global` (`applyGlobalRecipeWiring`) into `~/.claude/settings.json`, and dispatched by `worm hook trigger --global <event>` (`runGlobalRecipeHooks`) with **no project context** — so they fire for every Claude session machine-wide. `enabledRecipes(recipes, scope)` filters by scope, so a global recipe is never wired into a slot and vice-versa. The global dispatch forwards stdin, so payload-reading recipes work (`notifyPendingInput` keys off the hook JSON). Worm-owned recipe scripts live in `src/recipes/<name>/`; shared script helpers in `src/recipes/_lib/` (`notify.js`, the OS-notification backend shared by `autosync` and `notifyPendingInput`; `settings-merge.js`, the three-way settings merge shared by `syncPermissions` and `syncGlobalPermissions`) — these are plain ESM copied to `dist/recipes/` by tsup, imported by sibling scripts via relative paths, never bundled (so `settings-merge.js` must stay dependency-free and must not import from `src/core/`). **Both sync recipes run the same merge engine** (`_lib/settings-merge.js`) against a machine-local base snapshot: `syncGlobalPermissions` syncs a configurable set of top-level `~/.claude/settings.json` keys (`keys`; omit for auto mode = `permissions` + `sandbox` + top-level primitives) against `~/.worm/.sync-global-settings.base.json`, and `syncPermissions` syncs a slot's `settings.local.json` (`keys`, default `["permissions"]`) against a **per-slot** snapshot (`syncPermissionsBaseFile` → `projects/<name>/.sync-permissions.base.<slot>.json`) — per-slot because each slot diverges from the canonical store independently. `keys` accepts `"*"` (as the whole value or an entry in the list), expanded by the WORKER — not the wiring — against the live files, so a newly added settings key starts syncing without a re-wire; the wildcard skips `WILDCARD_DENY` (`env`, `trustedDirectories`) while an explicitly named key never is, which is the `["*", "env"]` opt-back-in. Keep that denylist justified in the comment when touching it: it's a security boundary (the canonical copy is committed and pushed by autosync), not a taste call. The merge is **recursive**, so conflict granularity is a leaf: arrays merge as sets (a rule leaving EITHER file propagates as a removal, a rule added to either is kept), objects recurse per key (both sides' additions survive — do NOT "simplify" this back to an opaque value, that silently discards the loser's whole subtree), and only a scalar edited on both sides falls back to last-edited-file-wins by mtime. No base yet → the whole merge degrades to a union, which never loses data. A merged value of `undefined` deletes the key, which is what makes removals propagate. `hooks` may be named in `keys`, but only the USER's entries sync: `splitWormHooks` peels off the `worm hook trigger …` entries (matched by the same marker `writeHooksFile` uses) before merging and `withWormHooks` re-attaches them to the live file in the same order — worm owns that block via `worm sync`/`worm sync --global`, and letting the sync write it too would give it two writers that undo each other. The key set is passed to the standalone workers as CLI args by the recipe wiring. `ensureGlobalRoot` gitignores machine-local state (manifests, logs, the autosync marker, both base snapshots) so it isn't pushed across machines; its `.gitignore` writer reconciles (appends missing lines) so a re-run of `worm init` heals older installs. autosync is **serialized by a machine-local lock** (in the OS temp dir, skip-if-held, with an owner token so a stale-steal can't hand the lock to two racers) and **commits local work before rebasing** onto the remote (never `--autostash` — a committed change survives a conflict abort; an autostash pop-conflict would strand it), so many concurrent sessions/windows never run git on `~/.worm` in parallel or self-diverge.

### Config
- `ConfigSchema` (`src/types.ts`) is `.strict()` and there is **no legacy normalization** — `core/config.ts` parses configs as-is, so an unknown or renamed key is a hard `Invalid config` error. This is a single-user tool; when you change the schema, migrate the on-disk profiles under `~/.worm/projects/<name>/config.json` (and the template) in the same change rather than adding a back-compat shim. The config shape: `{ shared_paths, stores, env?, hooks: { on_create?, on_remove? }, recipes: { <name>: <recipe-config> } }`. `env` (optional) is the per-worktree dotenv block `{ file, vars }` — `core/env.ts` generates a different file per slot, regenerated on init/add/switch/sync and git-excluded; `vars` values are integer arithmetic over `index` (positional) / `offset` / `hash` (branch-stable) plus text `slot`/`branch`. The arithmetic evaluator is dedicated to this block (NOT `utils/template.ts`). A `shared_paths` entry is `string | { path, store? }` (bare = profile store); `stores` is `{ <name>: { root, url? } }` — `core/stores.ts:resolveStoreLinks` maps each entry to a source (profile by default, else the named store's root, cloning from `url` on demand), so `reconcileSlotLinks` consumes resolved `{ tail, source, sprout }` links, not raw paths.

### Templates
- `~/.worm/templates/default/` is seeded on first global init by [src/core/templates.ts](src/core/templates.ts). Each new project is bootstrapped from a template (CLI `--template <dir>` > global default > built-in `DEFAULT_CONFIG`).
- After bootstrap each project owns its files — templates are **copied**, never symlinked. Editing the template later won't affect existing projects. If you need to update an existing project, edit `~/.worm/projects/<name>/` directly. (Template configs are parsed with `ConfigSchema` directly — like every config now — so a template must use the current schema.)

## Don'ts

- Don't add deps casually. The footprint is intentionally small (commander, execa, picocolors, zod). Justify any new one.
- Don't introduce a new layer or move logic up the stack. `core/` must not import from `commands/`; `utils/` must not import from `core/`.
- Don't write to the project's real `~/.worm` from tests — always use `WORM_HOME`.
- Don't suppress git's stderr. `runOrThrow` already surfaces it inside `WormError`; users need it to debug.
