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
| **Tree count** | N ephemeral worktrees | **permanent pool**; Slot 0 = primary working tree, siblings = `<repo>-1..<repo>-N` |
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
| `worm init` | Bind Slot 0 (the current normal clone). Provision `.worm/`, structural links, no recipes enabled by default (`recipes: {}`), empty managed-links manifest. Then warm Slot 0 by firing `on_create` (non-fatal, `--skip-hook` to opt out) — `init` is the "create" event for the primary slot. Idempotent. No `--universes`. |
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
  on_create: z.string().optional(),   // was on_warp — warms a slot: init/clone (Slot 0), universe add, switch
  on_remove: z.string().optional(),   // was on_collapse — runs at slot removal
}).strict();

// Recipes are composable capabilities, keyed by name (provider-style). A recipe
// is ENABLED iff its key is present; each value is validated by its own schema.
const SandboxRecipeSchema = z.object({
  backend:       z.enum(["docker"]).default("docker"),        // future: more backends
  image:         z.string().default("node:22-bookworm"),
  tools:         z.array(z.string()).default([]),             // apt packages → one RUN line
  neverSandbox:  z.array(z.string()).default(["node","npm","npx","pnpm","yarn"]),
  exemptDirs:    z.array(z.string()).default([]),
  autostart:     z.boolean().default(true),                   // SessionStart: docker compose up -d
  autostop:      z.boolean().default(false),                  // SessionEnd: docker compose down
}).strict();

const RecipesSchema = z.object({
  sandbox:       SandboxRecipeSchema.optional(),              // present = enabled
}).strict().default({});

const ConfigSchema = z.object({
  shared_paths:  z.array(z.string()).default([]),             // the "wormholes"/tunnels into the Manifest
  hooks:         HooksSchema.default({}),
  recipes:       RecipesSchema,
}).strict();   // pool size is fully emergent — no count, no cap
```

**Removed:** `anchors` (legacy ephemeral-warmth concept), `universes_count` (pool is emergent), the
flat `sandbox` object (folded into `recipes.sandbox`), and `promptShaping` (never wired; a future
recipe). The old `recipe: "none"` sentinel is gone — disabled = key absent.

**No back-compat (single-user tool):** the schema is `.strict()` and configs are parsed **as-is** —
there is no legacy normalizer. An unknown or renamed key (`anchors` / `universes_count` / `on_warp` /
`on_collapse` / a flat `sandbox` object) is a hard `Invalid config` error. When the schema changes,
migrate the on-disk profiles (`~/.worm/multiverses/<name>/config.json`) and the template in the same
change rather than carrying a shim. (The earlier `normalizeLegacyConfig` shim was removed once the
profiles were migrated.)

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

  for recipe in enabledRecipes(cfg.recipes):                                    # key present = enabled
    materialize(recipe, root)                                                   # → .worm/recipes/<name>/
  for slot in slots:
    applyRecipeWiring(root, slot, cfg.recipes)        # merge all enabled recipes' hooks into slot's settings.local.json

  # invariants: never creates/removes a slot; never writes destructively to slot0
```

- **Idempotent / crash-safe:** re-running after an interrupted run converges. `ensureSymlink`,
  `ensureDir`, `writeTextIfMissing` only.
- **Prune safety:** scoped to the manifest set + `isSymlink` guard → can't delete real user files or
  the structural `.worm/` wiring links.

## 6. Recipe engine

The cognitive layer is delivered by **recipes**: composable capabilities keyed by name in
`config.recipes` (provider-style, à la Terraform providers). A recipe is **enabled iff its key is
present** — there is no on/off field and no `none` sentinel — and each value is validated by that
recipe's own zod schema. Open-source adopters inherit nothing: the default config has `recipes: {}`.

### The `Recipe` contract (`src/core/recipes.ts`)

```ts
interface Recipe<C> {
  name: string;
  select(recipes: RecipesConfig): C | undefined;          // its config slice, or undefined = disabled
  artifacts?(projectName: string, cfg: C): RecipeArtifact[];        // files under .worm/recipes/<name>/
  wireSlot?(ctx: RecipeWireContext, cfg: C): SettingsContribution;  // hook entries for settings.local.json
  onSlotCreate?(ctx: RecipeWireContext, cfg: C): Promise<void>;     // imperative per-slot setup
}
```

All three hooks are optional — a recipe implements only what it needs. The engine exposes three
functions, called by `init` / `clone` / `universe add` / `sync` / `destroy`:

- **`materializeRecipes`** — writes each enabled recipe's `artifacts()` under `.worm/recipes/<name>/`,
  non-clobbering (`writeTextIfMissing`), so once generated the files are the user's to edit. Returns
  `<name>/<relPath>` of what it wrote. Also pre-creates `.worm/logs/`.
- **`applyRecipeWiring`** — for one slot: runs each enabled recipe's `onSlotCreate`, then merges their
  `wireSlot` contributions into that slot's `.claude/settings.local.json`.
- **`stripRecipeWiring`** — removes all worm-managed hooks from a slot (used on `destroy`).

### Composition — the settings.local.json merge

Multiple recipes share one `settings.local.json`, so the merge must be **namespaced**: worm owns only
the hook entries whose command references the `.worm/recipes/` tree. On every run it strips its
previous entries and re-adds the current set, reconciling across **any** hook event (not a hardcoded
list) and leaving the user's own hooks — and other recipes' entries — untouched. This is what lets
`sandbox` (PreToolUse + SessionStart/End) and `syncPermissions` (SessionStart/End) coexist; the
`syncPermissions` script is itself merge-preserving (it rewrites only the `permissions` block).

### Built-in recipes

| recipe | config | shape | what it does |
|---|---|---|---|
| `sandbox` | `{ backend, image, tools, neverSandbox, exemptDirs, autostart, autostop }` | artifacts + `wireSlot` | Per-slot Docker sandbox. Artifacts: `Dockerfile`, `compose.yml`, `redirect-to-sandbox.js`, `sandbox-policy.json`. Wires `PreToolUse(Bash)` → the interceptor (redirects fs-mutating commands into the container), `SessionStart` → `compose up -d` (`autostart`), `SessionEnd` → `down` (`autostop`). Policy (`neverSandbox`/`exemptDirs`) is **data** in `sandbox-policy.json`, read by a fixed interceptor. |
| `syncPermissions` | `{}` | artifacts + `wireSlot` | `SessionStart`/`SessionEnd` hooks run a script that **merge-preservingly** unions the `permissions` block of the slot's settings.local.json with a canonical store shared across slots. The canonical is the **persistent global profile** (`~/.worm/multiverses/<project>/.claude/settings.local.json`) — committed in `~/.worm` and surviving re-clones, and the file where a user's accumulated allowlist already lives, so existing permissions are pulled in on first run. |
| `shareHistory` | `{}` | `onSlotCreate` only | Symlinks each sibling slot's Claude history dir (`~/.claude/projects/<slot-slug>`) to Slot 0's canonical one. Idempotent; refuses to clobber a real history dir (warns). |

**Per-slot, not per-project** (parallel agents must not share a sandbox mount): the `sandbox` recipe
derives the container/compose-project name from the slot — `<project>-<slot>-sandbox` /
`<project>-<slot>` — and mounts *that slot's* worktree via `$SANDBOX_DIR`, set per slot in the wiring.
So Slot 0 → `mkpc-main-sandbox`, sibling 1 → `mkpc-1-sandbox`, each isolated.

### Logging

Recipe hooks run silently inside Claude sessions, so they log to **`.worm/logs/`** (a fixed,
discoverable location, à la Terraform's `TF_LOG_PATH`): `<container>.log` for the container's
`up`/`down` output (including the first image build), `<container>-redirect.log` for the interceptor's
allow/deny decisions, and `sync-permissions.log` for the permission sync. The interceptor logs to a
file rather than being output-redirected, because its stdout *is* the permission decision Claude
reads. `.worm/` is gitignored, so logs stay local.

### Remaining gap

The `sandbox` recipe's *backend* is hardcoded to Docker — `wireSlot` emits `docker compose …` and the
interceptor's remediation string is `docker exec …`. The `backend` enum (`"docker"` today) is the
seam for podman/firejail/bubblewrap/remote-VM later; lifting the transport behind it is the open work
in §13.1.

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
| `src/commands/completion.ts` | Stop grepping `-<N>` from worktree porcelain; drive from `worm status --json`. |
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

## 13. Follow-ups (deferred — not in the MVP)

The MVP shipped on `feat/strategy-3`: topology, commands, `sync`, docs/demo, and the sandbox
engine (provision + per-slot `.claude/settings.local.json` wiring). These are the known,
deliberate gaps — none block daily use; each is an additive layer on a clean seam.

1. **True recipe pluggability.** ✅ *Partly landed:* recipes are now a keyed-map plugin engine
   (`core/recipes.ts`, §6) — `recipes` config is a `name → config` map, each recipe exposes
   `select`/`artifacts`/`wireSlot`, and `settings.local.json` is a namespaced merge so multiple
   recipes compose. **Still open:** the `sandbox` recipe's *backend* is hardcoded to Docker — its
   `wireSlot` emits `docker compose … up -d` and the interceptor's `docker exec …` remediation
   string. Lifting those behind a `backend` axis (podman, firejail, bubblewrap, remote VM) is the
   remaining work; the `backend` enum is in the schema as the seam.

2. **Multi-agent `AgentAdapter` axis (orthogonal to the sandbox recipe).** All Claude coupling is
   isolated to `src/core/recipes.ts`; the core (pool, tunnels, hooks, manifest) is already
   agent-neutral. An `AgentAdapter` would own (a) where session/interceptor hooks are installed
   and (b) the deny-output format, so `recipe × adapter` compose. **Capability caveat:** the
   sandbox *redirect* depends on the agent exposing a pre-execution deny hook (Claude Code's
   `PreToolUse` → `permissionDecision: "deny"`). Agents without one still get the pool + tunnels +
   lifecycle hooks, but not command interception.

3. **`shareHistory` — share agent conversation history across slots** (an `AgentAdapter` feature
   for Claude). A managed symlink `~/.claude/projects/<slot-slug>` → `<slot0-slug>` makes every
   slot share Slot 0's timeline (slug = absolute path with `/` and `.` → `-`). Reuse the
   deref-guarded managed-link manifest; strip on `universe rm`/`destroy`. Safe under parallel
   agents (Claude writes one JSONL per session id, no clobber). Caveats: the slug rule is an
   undocumented Claude internal (keep it in the adapter), and it writes into global
   `~/.claude/projects/` state — guard hard, never touch a real history dir. Works **today** via
   the `on_create` hook (`setup.sh`); first-class form is a `claude: { shareHistory: true }` toggle.

4. **`promptShaping`** — wire the reserved `block-prompt-forcing` PreToolUse middleware (deny
   command-substitution / control-flow / inline interpreters so the model restructures into
   allowlistable steps). Schema field exists; default off; not yet emitted.

5. **`worm migrate`** — automate the non-destructive §9 cutover (recognise a legacy bare container
   via the retained `isBareCloneContainer` detector, clone alongside, re-create slots, re-apply
   dirty files). Manual for now.

6. **Secret hygiene (§11)** — purge tracked secrets from `~/.worm` history, move `shared_paths`
   secrets to a store, ship a strict `.gitignore` in the shareable template. Prerequisite before
   the grimoire is shared; independent of the code.
