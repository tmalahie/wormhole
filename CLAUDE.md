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
- **Vocabulary is themed.** Keep it consistent: `🪐` multiverse, `🌌` add a universe, `🚀` active slot / switch, `💫` collapse (remove a universe), `🔗` shared "anomaly"/tunnel, `🪢` worktree, `⚡` hook, `🎯` target, `🛸` init / binding Slot 0, `📐` template, `🌱` sprouted local placeholder, `📝` gitignore write, `🧹` swept links, `💥` broken / error, `✨` success, `💡` hint. New messages should pick from this palette rather than introducing a new emoji per command.

### Paths
- All filesystem locations come from `src/core/paths.ts`. If you need a new one, add a function there — never concatenate path segments at the call site. The slot-dir naming (`<repo>-<N>`) is centralised on `SLOT_DIR_INFIX`; the builder (`siblingWorktreeDir`), the parser (`universe.ts`), and shell completion all derive from it.
- `globalRoot()` honours `WORM_HOME`. Tests rely on this; don't bypass it with direct `os.homedir()` calls.

### Root resolution
- Slot 0 is found with `findSlot0Root()` (`core/project.ts`) — it asks git for `--git-common-dir` and takes its parent, then checks `.worm/` exists. This works from any slot. Use it everywhere a command needs the root, EXCEPT `init`/`clone`, which bind a not-yet-`.worm`'d repo and so use `gitToplevel()`.

### Symlinks
- Use `ensureSymlink()` from `src/core/symlinks.ts`. It's idempotent and refuses to clobber real files. Don't call `fs.symlink` directly.
- Post-consolidation, `.worm/` is (almost) all pointers into the profile (`~/.worm/multiverses/<name>/`): `config.json`, `scripts`, `recipes`, and `logs` are symlinks; durable state (recipe artifacts, logs, the manifest) lives in the profile. `core/layout.ts:ensureLocalLayout` establishes this (and migrates an old project's real `.worm/recipes`/`logs` in place); it runs on init/sync/universe-add.
- Each slot's shared-path tunnels link **straight at the profile source** (`<slot>/<tail>` → `profile/<tail>`, **absolute** — the old `.worm/shared` two-hop is gone). All cross-repo links pass `{ relative: false }`.
- Shared-path links are tracked in the **managed-link manifest**, now in the **profile** (`~/.worm/multiverses/<name>/.managed-links.json`), so `readManifest`/`writeManifest`/`reconcileSlotLinks` take the **project name** (not slot0Root). Reconcile/prune through `core/links.ts` so worm only ever touches links it created — never structural wiring or real user files. The prune is deref-guarded: a managed link that became a real file is left alone.

### Slot edge cases
- **Slot 0 is a real working tree**, so git would otherwise see `.worm/` as untracked. `init.ts:ensureGitExclude` adds `/.worm/` to `.git/info/exclude` (local, not the tracked `.gitignore`).
- Before `git worktree remove` (in `universe rm`/`destroy`), strip the managed symlinks first (`links.ts:stripSlotLinks`) — git treats them as untracked files and refuses removal otherwise.
- **Never `worktree remove` or `rm -rf` Slot 0.** `universe rm` refuses it explicitly; `destroy` only sweeps siblings. Slot 0 is the user's actual checkout.

### Idempotency
- `init`, `sync`, and `universe add`/`rm` may be re-run after partial failure. Always reach for `ensureDir`, `ensureSymlink`, and `writeTextIfMissing` rather than raw create operations. If you write something destructively, gate it behind `--force`. `sync` is declarative — running it twice is a no-op.
- `worm init` lazily provisions `~/.worm/` on first run (detected via the existence of `~/.worm/multiverses/`, not the root itself — the root can be pre-created in sandboxes). Do not bypass `ensureGlobalRoot` from other commands; if a future command needs the global root, call it from `init` flows only.

### Hooks
- User-supplied commands always run through `runShell()` (not `run()`), with `inheritStdio: true`. They get the full shell, including pipes and `&&`.
- Lifecycle hooks are `on_create` (a slot is created via `universe add`, and on `switch`) and `on_remove` (a slot is removed). A non-zero exit from `on_remove` aborts the removal unless `--force` is set. `on_create` failures are warned but not fatal — the worktree exists either way.
- Hooks receive `WORM_PROJECT_ROOT` (Slot 0), `WORM_SLOT` (`main` / `<N>`), `WORM_SLOT_INDEX` (0-based numeric), `WORM_BRANCH`, and `WORM_WORKTREE` (this slot's path; equals `WORM_PROJECT_ROOT` for Slot 0). Build the env with `hookEnv(slot0Root, slot, branch)` from `core/hooks.ts` — don't inline the object at the call site.
- The default `on_create` invokes `bash "$WORM_PROJECT_ROOT/.worm/scripts/setup.sh"`. Users edit `setup.sh` rather than the JSON config. Don't change the hook-command default without also updating the seeded `setup.sh` template.

### Config
- `ConfigSchema` (`src/types.ts`) is `.strict()` and there is **no legacy normalization** — `core/config.ts` parses configs as-is, so an unknown or renamed key is a hard `Invalid config` error. This is a single-user tool; when you change the schema, migrate the on-disk profiles under `~/.worm/multiverses/<name>/config.json` (and the template) in the same change rather than adding a back-compat shim. The config shape: `{ shared_paths, stores, hooks: { on_create?, on_remove? }, recipes: { <name>: <recipe-config> } }`. A `shared_paths` entry is `string | { path, store? }` (bare = profile store); `stores` is `{ <name>: { root, url? } }` — `core/stores.ts:resolveStoreLinks` maps each entry to a source (profile by default, else the named store's root, cloning from `url` on demand), so `reconcileSlotLinks` consumes resolved `{ tail, source, sprout }` links, not raw paths.

### Templates
- `~/.worm/templates/default/` is seeded on first global init by [src/core/templates.ts](src/core/templates.ts). Each new multiverse is bootstrapped from a template (CLI `--template <dir>` > global default > built-in `DEFAULT_CONFIG`).
- After bootstrap each multiverse owns its files — templates are **copied**, never symlinked. Editing the template later won't affect existing projects. If you need to update an existing project, edit `~/.worm/multiverses/<name>/` directly. (Template configs are parsed with `ConfigSchema` directly — like every config now — so a template must use the current schema.)

## Don'ts

- Don't add deps casually. The footprint is intentionally small (commander, execa, picocolors, zod). Justify any new one.
- Don't introduce a new layer or move logic up the stack. `core/` must not import from `commands/`; `utils/` must not import from `core/`.
- Don't write to the project's real `~/.worm` from tests — always use `WORM_HOME`.
- Don't suppress git's stderr. `runOrThrow` already surfaces it inside `WormError`; users need it to debug.
