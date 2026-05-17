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

These four pnpm scripts are pre-approved in [.claude/settings.local.json](.claude/settings.local.json) so they run without permission prompts. Always reach for them first:

- Correctness checks → `pnpm test` (and `pnpm typecheck` for type-only changes).
- Eyeballing themed CLI output → `pnpm demo`. Edit [scripts/demo.sh](scripts/demo.sh) if you want to extend the walkthrough; do not re-derive it as an ad-hoc bash heredoc.
- Running `worm` directly against the built CLI → `pnpm worm -- <args>` (e.g. `pnpm worm -- scan --json`). This is also whitelisted.

If you genuinely need a new repeatable workflow, add a pnpm script + a file under `scripts/`. One-shot bash heredocs are slow to approve and leave no artifact for the next agent.

## Project intent

`worm` orchestrates `git worktree` to give parallel agents warm, isolated environments. Everything else (anchors, shared files, hooks) exists in service of two goals: **(a)** warps must be fast (anchors stay hot across cycles), **(b)** the same branch never lives in two slots.

Keep that in mind when reviewing changes: a "clever" addition that breaks idempotency or pollutes anchors is a regression even if it passes typecheck.

## Conventions

### Errors
- Throw `WormError` (from `src/utils/errors.ts`) for any failure caused by the user or environment. Always pass a `hint:` with the next action they should take. The global handler in `cli.ts` renders it cleanly.
- Let unexpected errors (bugs) bubble up — they'll be printed with a stack trace when `WORM_DEBUG=1`.

### User-facing output
- Every line of CLI output goes through `logger.*`. Do not call `console.log` / `console.error` directly outside of `cli.ts` and the json branch of `scan.ts`.
- Tone: `info` for intent, `step` for substeps, `success` at the end, `warn` for recoverable issues, `error` only via thrown `WormError`.
- **Vocabulary is themed.** Keep it consistent: `🪐` multiverse, `🌌` universe / available, `🚀` warp / active, `💫` collapse, `⚓` anchor, `🔗` shared "anomaly", `🪢` worktree, `⚡` hook, `🎯` target, `🛸` register, `💥` broken / error, `✨` success, `💡` hint. New messages should pick from this palette rather than introducing a new emoji per command.

### Paths
- All filesystem locations come from `src/core/paths.ts`. If you need a new one, add a function there — never concatenate path segments at the call site.
- `globalRoot()` honours `WORM_HOME`. Tests rely on this; don't bypass it with direct `os.homedir()` calls.

### Symlinks
- Use `ensureSymlink()` from `src/core/symlinks.ts`. It's idempotent and refuses to clobber real files. Don't call `fs.symlink` directly.
- Inside a worktree (`src/`), links must be **relative**. Across repos (project ↔ global), links are **absolute**. The default for `ensureSymlink` is relative — pass `{ relative: false }` for the cross-repo case.

### Worktree edge case
- Before creating a symlink at `src/<anchor>`, ensure the anchor directory exists at `slot/<anchor>` — a symlink to a missing target breaks writes on some platforms. See `warp.ts:prepareAnchorDirs`.
- Before calling `git worktree remove`, strip the symlinks wormhole injected (`collapse.ts:removeInjectedSymlinks`). Git treats them as untracked files and refuses removal otherwise.

### Idempotency
- `register`, `warp`, and `collapse` may be re-run after partial failure. Always reach for `ensureDir`, `ensureSymlink`, and `writeTextIfMissing` rather than raw create operations. If you write something destructively, gate it behind `--force`.

### Hooks
- User-supplied commands always run through `runShell()` (not `run()`), with `inheritStdio: true`. They get the full shell, including pipes and `&&`.
- A non-zero exit from `on_collapse` aborts the collapse unless `--force` is set. `on_warp` failures are warned but not fatal — the worktree exists either way.

## Don'ts

- Don't add deps casually. The footprint is intentionally small (commander, execa, picocolors, zod). Justify any new one.
- Don't introduce a new layer or move logic up the stack. `core/` must not import from `commands/`; `utils/` must not import from `core/`.
- Don't write to the project's real `~/.worm` from tests — always use `WORM_HOME`.
- Don't suppress git's stderr. `runOrThrow` already surfaces it inside `WormError`; users need it to debug.
