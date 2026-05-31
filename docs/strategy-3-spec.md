# Strategy 3 — Implementation Spec

> Status: **design / pre-implementation**. No code changed yet. This is the agreed plan from the
> architecture review. Build against isolated `WORM_HOME` sandboxes (the e2e harness already does
> this); do **not** run the live migration against `~/.worm` / real projects without a clear runway
> (see §10).

## 1. Philosophy

The value of `worm` has migrated from **filesystem topology** (git worktrees) to the **cognitive
layer** (the Manifest: per-project Claude config, skills, commands, settings sync, and the sandbox
guardrails). Strategy 3 demotes topology to a *backend* and makes the cognitive layer the product.

Three axes were previously conflated; we resolve each:

| Axis | Old | New |
|---|---|---|
| **Repo shape** | bare clone (`.git`→`./.bare`) | **normal clone** (`.git` dir); no bare container |
| **Tree count** | N ephemeral worktrees | **permanent pool**; Slot 0 = primary working tree, siblings = `uni1..uniN` |
| **Slot lifecycle** | spawn-on-warp / teardown-on-collapse | **branch-switch in place**; slots are permanent |

Permanent slots are "warm" as a steady state — `node_modules`/build state simply persists per slot.
No per-switch warm-up is required. Plain `git switch` is the daily driver; `worm` is reconcile/setup
infrastructure, not an inner-loop command.

## 2. Repository topology

**Uniform normal clone for all pool sizes.** Slot 0 is the primary working tree (`~/git/<proj>/`,
never renamed). Extra slots are standard linked worktrees, placed as **true siblings one level up**
so Slot 0's git never sees them as untracked directories.

```
~/git/
├── my-project/              ← Slot 0 (primary working tree; .git is a normal directory)
│   ├── .git/                 ← standard git dir (the common dir for all slots)
│   └── .worm/                ← Manifest local wiring + config.json + .managed-links.json
│                               (no universes/ anchors dir — anchors removed)
├── my-project-1/            ← permanent linked worktree (sibling of Slot 0, not nested)
└── my-project-2/            ← permanent linked worktree
```

- **No `.bare`, no pointer file, no `uni0`.** Slot 0 *is* the main checkout; sibling indices start at 1.
- **`.worm/` always lives at Slot 0.** Sibling worktrees reach it through git (`--git-common-dir`), never by guessing `../`.
- **Layout decision:** true siblings (chosen) over nesting `<proj>-N/` inside Slot 0 + a `.git/info/exclude` entry. Siblings keep `git status` in Slot 0 clean and match the conventional `git worktree add ../…` layout.
- **Naming:** sibling dirs are `<repo>-<N>` (no `uni` token), centralised on the `SLOT_DIR_INFIX` constant in `paths.ts`. Slot display names are `main` / `<N>`.

**Root resolution (replaces `findContainerRoot`/`isBareCloneContainer`):**

```
slot0Root = dirname( git rev-parse --path-format=absolute --git-common-dir )   # git ≥ 2.31
# validate <slot0Root>/.worm/ exists; else "not a worm project" WormError(hint: worm init)
```

From any worktree, `--git-common-dir` resolves to `<slot0>/.git`, so its parent is Slot 0. This is
strictly more robust than the old upward-walk for a pointer file, and works identically from Slot 0
or any sibling.

A **legacy detector** is retained only to recognise the old bare-container shape and route the user
to `worm migrate` (see §9).

**Constraint — Manifest paths are a stable API surface.** `~/.worm/shared/` and
`~/.worm/multiverses/<name>/` are hardcoded in **≥62 places across ~29 files** (skills, slash
commands, scripts, `CLAUDE.local.md`, `settings.json`). Strategy 3 does **not** relocate them, and
nothing should without a full reference sweep. Only the secret-handling change (§11) edits the
*contents* of scripts under those paths (credential sourcing), never their locations.

## 3. Command surface

`warp`, `collapse`, and `universes <count>` are **removed**. Slot lifecycle is imperative and
branch-keyed (a slot is always born with an explicit branch, which dissolves the "what branch does a
new slot get?" problem). The cognitive layer is declarative via `sync`. **Pool size is emergent** —
there is no `universes_count` driver; you add a slot when you want one.

| Command | Behaviour |
|---|---|
| `worm init` | Bind Slot 0 (the current normal clone). Provision `.worm/`, structural links, default sandbox recipe (`none`), empty managed-links manifest. Idempotent. No `--universes`. |
| `worm universe add <branch>` | Create a permanent sibling worktree on `<branch>` (`-c`/`--track` if it doesn't exist). Refuse if the branch is already in a slot. Run `on_create` hook once, then `sync` the new slot. |
| `worm universe rm <slot>` | Remove a slot. **Refuse if `slot == 0`**; refuse if dirty/untracked unless `--force`. Run `on_remove`, strip managed links, `git worktree remove` + prune. |
| `worm switch <branch>` | In the current slot: `git switch [-c] <branch>` + re-run `on_create` (warm-up). Optional sugar over plain `git switch`. |
| `worm sync` | Reconcile the cognitive layer across **existing** slots: links (via manifest), sandbox provisioning + Claude wiring, settings. Idempotent, crash-safe. **Never creates/removes slots.** |
| `worm destroy` | Full teardown. Slot 0 guarded (git refuses to `worktree remove` the primary; never `rm -rf` Slot 0). |

> Alternative considered: keep `universes_count` as a declared *target* and have `sync` hint
> `worm universe add <branch>` per missing slot. Rejected for the count↔reality drift it introduces;
> emergent pool is cleaner. If revisited, only `sync` and the schema change.

## 4. Config schema changes (`src/types.ts`)

```ts
const HooksSchema = z.object({
  on_create: z.string().optional(),   // was on_warp — runs once at slot creation / on `switch`
  on_remove: z.string().optional(),   // was on_collapse — runs at slot removal
}).strict();

const SandboxSchema = z.object({
  recipe:        z.enum(["none", "docker"]).default("none"),  // opt-in; default inherits NOTHING
  // docker-recipe fields (ignored when recipe === "none"):
  tools:         z.array(z.string()).default([]),             // apt packages → one RUN line
  neverSandbox:  z.array(z.string()).default(["node","npm","npx","pnpm","yarn"]),
  exemptDirs:    z.array(z.string()).default([]),
  promptShaping: z.boolean().default(false),                  // block-prompt-forcing middleware
  autostart:     z.boolean().default(true),                   // SessionStart: docker compose up -d
  autostop:      z.boolean().default(false),                  // SessionEnd: docker compose down
}).strict();

const ConfigSchema = z.object({
  shared_paths:  z.array(z.string()).default([]),             // the "wormholes"/tunnels into the Manifest
  hooks:         HooksSchema.default({}),
  sandbox:       SandboxSchema.default({ recipe: "none" }),
}).strict();   // pool size is fully emergent — no count, no cap
```

**Removed:** `anchors` (legacy ephemeral-warmth concept), `universes_count` (pool is emergent).

**Backward-compat (critical):** the schema is `.strict()`, so existing configs that still carry
`anchors` / `universes_count` / `on_warp` / `on_collapse` will *fail to load*. The loader must
**tolerate-and-migrate** legacy keys (strip + warn, mapping `on_warp→on_create`, `on_collapse→on_remove`),
or `worm migrate` rewrites them. Do not let `.strict()` hard-error on a pre-migration config.

## 5. The `sync` convergence algorithm

State of record for links is a **managed-link manifest** at `.worm/.managed-links.json`:
`{ "<slot-rel-path>": ["<link-rel-path>", ...] }`. `sync` only ever touches links it recorded —
no blind "is it pointing into the Manifest?" heuristics (which would nuke the structural
`config.json`/`scripts` links).

```
worm sync:
  root  = findSlot0Root()
  cfg   = loadConfig(root)                 # tolerate-and-migrate legacy keys
  slots = listWorktrees(root)              # slot0 + siblings, from `git worktree list`
  mf    = readManagedLinks(root)           # {} if absent

  for slot in slots:
    desired = shared_paths.map(p => link@<slot>/p  ->  <root>/.worm/shared/p)
    for link in desired:                   ensureSymlink(link)            # idempotent
    for link in (mf[slot] ?? []) \ desired:
      if isSymlink(link):                  unlink(link)
      else:                                warn("managed link at <link> is now a real file — skipped")  # deref edge case
    mf[slot] = desired
  writeManagedLinks(root, mf)

  if cfg.sandbox.recipe != "none":
    recipe = loadRecipe(cfg.sandbox.recipe)
    for slot in slots:                     recipe.provision(slot, cfg.sandbox)   # per-slot Dockerfile/compose
    generateClaudeWiring(root, slots, cfg.sandbox)                              # per-slot .claude/settings.json hooks

  # invariants: never creates/removes a slot; never writes destructively to slot0
```

- **Idempotent / crash-safe:** re-running after an interrupted run converges. `ensureSymlink`,
  `ensureDir`, `writeTextIfMissing` only.
- **Prune safety:** scoped to the manifest set + `isSymlink` guard → can't delete real user files or
  the structural `.worm/` wiring links.

## 6. Sandbox recipe / middleware model

Opt-in. Default `none` emits **no** hooks and **no** Docker, so open-source adopters inherit nothing.

**Registry** (`src/core/sandbox/recipes/`): built-ins `none`, `docker`. A recipe exposes:

```ts
interface SandboxRecipe {
  classifyCommand(cmd: string, ctx: SlotCtx): "allow" | "redirect" | "deny";  // policy as data, not hardcoded Sets
  remediation(cmd: string, ctx: SlotCtx): string;                              // transport: docker exec | podman | bubblewrap | …
  provision(slot: Slot, cfg: SandboxConfig): { dockerfile: string; compose: string };
}
```

The current `redirect-to-sandbox.js` (already well-factored) becomes the body of the `docker`
recipe, with `FILE_OPS`/`INTERPRETERS`/`neverSandbox`/`exemptDirs` read from `cfg.sandbox` instead of
hardcoded constants, and `bash -lc` remediation moved behind `remediation()`.

**Per-slot, not per-project** (parallel agents must not share a mount):
- Container/image/compose-project name derive from the slot: `<project>-uniN-sandbox`.
- Mount = that slot's worktree path (not a single `WORM_PROJECT_ROOT`).
- `provision()` and the wiring generator are **slot-aware**.

**Auto-lifecycle (no manual `docker start`):** `worm` *generates* per-slot `.claude/settings.json`
hook blocks during `sync`/`universe add`:
- `SessionStart` → `docker compose -p <project>-uniN up -d` (idempotent; opening the slot's
  editor/Claude session starts its container).
- `SessionEnd` → `down` iff `autostop` (default off = leave warm).
- `PreToolUse(Bash)` → `redirect-to-sandbox` (+ `block-prompt-forcing` iff `promptShaping`).

This replaces the hand-copied per-multiverse wiring with one generated source of truth (paths.ts).

## 7. Code-level refactor map

| File | Change |
|---|---|
| `src/core/paths.ts` | Remove `worktreeDir` bare/`-uni0` assumptions; slot 0 = root (no suffix), siblings = `<proj>-uni{1..N}`. Drop `slotPath`/`slotAnchorPath`/`localUniversesDir` (anchors gone). Add `managedLinksFile()`. Fix stale comment at `:97-98`. |
| `src/core/project.ts` | Replace `isBareCloneContainer`/`findContainerRoot` with `findSlot0Root` (via `git rev-parse --git-common-dir`). Keep a legacy bare detector that routes to `worm migrate`. |
| `src/core/git.ts` | Add `switchBranch(repoRoot, branch, {create, track})` → `git switch [-c] [--track]`. Add `addPermanentWorktree`. |
| `src/core/universe.ts` | `scanUniverses` enumerates from `git worktree list` (not a count). Slot 0 = primary. Drop `universes_count` loop. Rework `classifySlot` (no ephemeral STABLE/ACTIVE-by-worktree-existence). Fix `:65` stale message; `universeLabel` regex. |
| `src/commands/clone.ts` | Remove `--bare` path. Either delete (use `git clone` + `worm init`) or make a thin normal-clone wrapper. |
| `src/commands/init.ts` | Bind Slot 0 only; drop `--universes` slot pre-creation; seed `.managed-links.json`; default sandbox `none`. |
| `src/commands/warp.ts`, `collapse.ts` | Remove. Logic re-homed into `universe add`/`rm` + `sync`. Keep the symlink injection helpers (now manifest-driven). |
| `src/commands/universe.ts` (new) | `add <branch>` / `rm <slot>` per §3. |
| `src/commands/switch.ts` (new) | `git switch` + re-run `on_create`. |
| `src/commands/sync.ts` (new) | §5 algorithm. |
| `src/commands/destroy.ts` | Slot-0 guard; never `rm -rf` the primary. |
| `src/commands/completion.ts` | Stop grepping `-uniN` from worktree porcelain; drive from `worm status --json`. |
| `src/core/hooks.ts` | Rename env consumers; `WORM_SLOT`/`WORM_SLOT_INDEX` sentinels for Slot 0; export `WORM_WORKTREE`/`WORM_SANDBOX_CONTAINER`/`WORM_SANDBOX_COMPOSE`. Guard `slotIndex` NaN. |
| `src/types.ts` | §4 schema. |
| `tests/cli.test.mjs` | Rewrite layout fixtures (no `.bare`, no `-uni0`, Slot 0 = clone root). Authoritative — change in lockstep. |
| `src/README.md`, `CLAUDE.md` | Reconcile the stale `src/` trick / bare-clone vocabulary. |

## 8. Cleanups (fold in while touching these files)

- Rename per-project `loadGlobalConfig` → `loadGlobalProjectConfig` (collides with machine-level `loadGlobalConfig`).
- Single-source the `1..64` bound (now just `max_universes` in the zod schema; delete the `universes.ts` `MIN/MAX` consts).
- `removeInjectedSymlinks`/prune: handle the "link was dereferenced into a real dir by an external tool" edge case — `isSymlink` guard + warn, never blow away real contents.

## 9. Migration & rollback (non-destructive)

Existing projects are bare containers today (`~/git/mkpc`, `~/git/arcads-monorepo`). Migrate
**alongside**, verify, then remove the old container — so rollback is "delete the new clone."

```
Per project:
  0. Ensure all commits pushed (already true); snapshot dirty working files (see backup).
  1. git clone <origin-url> ~/git/<proj>-v2     # fresh NORMAL clone (Slot 0)
  2. cd ~/git/<proj>-v2 && worm init            # binds Slot 0, links, default sandbox
  3. for each non-default branch you had a slot on:  worm universe add <branch>
  4. re-apply the snapshotted dirty files into the matching slot
  5. verify (build, sandbox up, settings sync); then retire the old bare container
Rollback at any point before step 5: rm -rf ~/git/<proj>-v2 ; keep using the old container.
```

A `worm migrate` command can automate this later; do the first one manually to validate the shape.

Concrete current state to migrate:
- `mkpc`: branches `development` (uni0), `master` (uni1). 23 GB `shared-uploads` lives in the Manifest and is **untouched** by migration.
- `arcads-monorepo`: branches `feat/video-editing-agent` (uni0, **16 dirty files**), `feat/ENG-1847-magic-link` (uni1, **1 dirty file**), `main` (uni2). Re-apply the 17 dirty files after re-creating those slots.

## 10. Build sequencing & safety

- **Spec + CLI code are zero-risk to your live setup.** The e2e suite runs against an isolated
  `WORM_HOME` per case ([tests/helpers.mjs](../tests/helpers.mjs)); CLI development never touches
  `~/.worm` or your projects. Half-finished *code* is safe.
- **Only the live migration (§9) is risky**, and it's decoupled from code. Don't run it without a
  runway. There is no half-finished-migration state to fear as long as you don't start §9.

## 11. Security pre-reqs (before sharing anything)

- Purge tracked secrets from `~/.worm` history (`.env`, `scripts/{dev,prod,test}/.env`, `.ngrok`);
  rotate the production credentials regardless (remote is your own Pi, so cleanup not crisis).
- `shared_paths` should reference a secret store (sops/age, 1Password CLI, or a gitignored file), not
  commit plaintext.
- The shareable default template ships a strict `.gitignore` (`.env`, `*.pem`, native creds) and must
  **not** carry your `shared_paths` secret list.

## 12. Open decisions

1. Emergent pool (recommended) vs declared `universes_count` target — §3.
2. `autostop` default (leave containers warm vs reclaim on SessionEnd) — §6.
3. Whether `worm switch` is worth shipping vs relying on plain `git switch` — §3.
4. `worm migrate` automation now, or manual non-destructive migration first — §9.
