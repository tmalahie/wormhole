# Architecture — the linking layer roadmap

> Status: **design + decisions from the 2026-06-06 review.** Companion to
> [recipes-roadmap.md](recipes-roadmap.md). This doc is about *where worm-managed state lives* and how
> the sharing/symlink layer generalizes. Per [CLAUDE.md](../CLAUDE.md), *"the cognitive layer is the real
> product — the worktree topology exists to serve it"* — so this layer is arguably more on-mission than
> the recipe engine, and these ideas are independent of recipes (they can land in parallel).

## The unifying model: (scope × store)

Almost everything worm does to wire a slot is **one operation**: make `<scope-root>/<tail>` a symlink to
`<store>/<tail>`.

- **Today** there is exactly one scope (a project slot) and one *implicit* store (the project profile,
  `~/.worm/multiverses/<project>/`). `shared_paths` is a list of `<tail>`s.
- **Generalize both axes:**
  - **Scopes:** the project slot (each worktree, as today) **and** `HOME` (`~/`) for machine-global
    setup that belongs to no project.
  - **Stores:** the **profile** (default), the **global shared dir** (`~/.worm/shared/`), and **named
    external repos** (e.g. a team docs repo outside `~/.worm`).

This single generalization absorbs three separate ideas from the session — global `~/.claude` setups,
external/team resources, and the `.worm/` consolidation — into one mechanism reusing the existing
[`reconcileSlotLinks`](../src/core/links.ts#L39) / manifest / [`ensureSymlink`](../src/core/symlinks.ts)
machinery. Only the *source root* and *scope root* vary.

---

## Decision 1 — consolidate the project-local `.worm/` (symlink-into-global) — ✅ SHIPPED 2026-06-06

**Status: SHIPPED.** [core/layout.ts](../src/core/layout.ts) `ensureLocalLayout` makes `.worm/recipes`
and `.worm/logs` symlinks into the profile (migrating an old project's real dirs in place, preserving
edits); the manifest moved to `profile/.managed-links.json` (`readManifest`/`writeManifest`/
`reconcileSlotLinks` now take the project name); slot links point **straight at the profile** (absolute,
one hop) and `removeLegacyShared` sweeps the old `.worm/shared`. Net `.worm/`: `config.json` + `scripts`
+ `recipes` + `logs` (all symlinks) + `.gitignore`. `findSlot0Root` is unchanged (still keys off `.worm/`
+ the `config.json` pointer). Run on init / sync / universe add, idempotent.

> **Cleanup (2026-06-06):** the one-shot migration scaffolding (moving an old project's real
> `.worm/recipes`/`logs` into the profile, relocating a local manifest, `removeLegacyShared`, and the
> transitional `WORM_RECIPE=` / `/.worm/recipes/` hook markers) was **removed** once the sole user's
> projects had migrated — the old layout never shipped a release, so no future install will see it.
> `ensureLocalLayout` now just establishes the symlinks; `isWormManaged` matches only `hook trigger`.

**Decided (Q2):** keep `.worm/` for discoverability, but make it **almost entirely pointers** into the
profile. Not "delete it," not "leave it" — thin it.

**What `.worm/` actually holds today** (audited 2026-06-06):

| Entry | Today | Verdict |
|---|---|---|
| `config.json` | symlink → profile | keep (pointer; its target also encodes the profile name) |
| `scripts/` | symlink → profile | keep (pointer) |
| `shared/` | a dir of symlinks → profile (a **second hop**) | **drop** — redundant indirection |
| `recipes/` | **real copied files** | → symlink to profile; only bucket-3 scaffolding remains there |
| `logs/` | **real files** | → symlink to profile (the profile already has a `logs/`) |
| `.managed-links.json` | real, local | **moved to the profile** (durable; survives a reclone) |
| `.gitignore` = `*` | real, local | keep |

**Target tree:**

```
~/git/<repo>/.worm/
  config.json -> ~/.worm/multiverses/<repo>/config.json     (unchanged pointer)
  scripts     -> ~/.worm/multiverses/<repo>/scripts          (unchanged pointer)
  recipes     -> ~/.worm/multiverses/<repo>/recipes          (was real files → now a symlink)
  logs        -> ~/.worm/multiverses/<repo>/logs             (was real files → now a symlink)
  .managed-links.json                                        (stays local)
  .gitignore = *                                             (unchanged)
```

**Drop the `shared/` hop.** Today a shared path links `slot → .worm/shared/<tail> → profile/<tail>`.
Collapse to `slot → profile/<tail>` directly (the store, per Decision 2). `.worm/shared/` disappears.

**Constraints to preserve:**
- **`findSlot0Root()` must keep working.** It resolves the root via `git --git-common-dir` → parent →
  *checks `.worm/` exists*, and needs the project **name** (which may be a `--name` override, so it
  can't always be derived from the basename). Keeping at least the `config.json` pointer preserves both
  root-detection and name-resolution. **Don't reduce below the config pointer.**
- **Links become absolute.** Collapsing the hop makes slot shared-links cross-repo (absolute, into
  `~/.worm`). This weakens README invariant #3 ("relative links survive a move") — **accepted**, because
  a slot-0 *rename* already breaks the sibling-relative form (`../<repo>/.worm/shared/…`), so the
  invariant is mostly fiction today. Update the invariant text when this lands.

**Net effect:** one source of truth per project (the profile); `.worm/` is a thin, discoverable set of
pointers next to the code; `logs/` and `recipes/` are no longer duplicated; propagation of code/state is
automatic (Decision-1 + recipes-roadmap spine reinforce each other).

**Resolved:** `.managed-links.json` **moved to the profile** (`profile/.managed-links.json`) — durable,
survives a slot-0 reclone, and keyed by absolute slot path so it stays correct. `migrateManifestToProfile`
moves a pre-consolidation local manifest on the next init/sync (profile copy wins if both exist).

## Decision 2 — named stores (external + team resources) — ✅ SHIPPED 2026-06-06

**Status: SHIPPED.** `shared_paths` entries are now `string | { path, store? }` (bare = profile store);
projects/global declare `stores: { <name>: { root, url? } }`. [core/stores.ts](../src/core/stores.ts)
`resolveStoreLinks` maps each entry to a concrete source (profile → `profile/<tail>`, sprouted; named →
`<storeRoot>/<tail>`, never fabricated), resolving each store once and **cloning a missing root from its
`url`** (clean `WormError` if absent and no url). `reconcileSlotLinks` now consumes the resolved
`{tail, source, sprout}` list. Project `stores` override same-named global ones. Fully backward compatible
— existing string `shared_paths` are unchanged.

**Decided (Q3):** a `stores` map plus per-entry `{ path, store }`. The **profile is the default store**;
external/team repos and the global shared dir are **named stores**. (Rejected: docker-volume
`"target:source"` strings — they conflate two paths and don't extend; and a standalone
`externalResources` block — it's a parallel system alongside `shared_paths`.)

```jsonc
// ~/.worm/multiverses/<repo>/config.json
{
  "stores": {
    "team": { "url": "git@github.com:org/shared", "root": "~/git/team-shared" }
  },
  "shared_paths": [
    ".env",                                    // default store = profile
    ".ngrok",
    { "path": ".claude/docs",     "store": "team" },
    { "path": ".claude/commands", "store": "team" }
  ]
}
```

- A store resolves to a **root dir**. Optional `url` → worm offers to `git clone` it when `root` is
  missing; `WormError` + hint if the root is absent and there's no `url`.
- **Backward compatible:** a bare string keeps meaning "the profile store," so existing configs are
  unchanged. Implemented by widening `shared_paths` entries to `string | { path, store }`.
- **Caveats to design for:**
  1. The external root must **exist on every machine** — hence `url` + clone-on-demand + a clean error.
  2. Editing a linked external path writes into **that repo's** working tree. This is *intended* (edit
     in place, commit in the team repo) — but worm is now wiring two git repos together; say so in docs.

## Decision 3 — global (home-scope) setups [the manual `~/.claude` symlinks] — ✅ SHIPPED 2026-06-06

Same primitive at **`HOME` scope** with the **global-shared store** (`~/.worm/shared/`). This replaces
the symlinks you currently make by hand: `~/.claude/{commands,skills,scheduled-tasks}` →
`~/.worm/shared/.claude/…`.

**Status: SHIPPED.** `worm sync --global` ([src/commands/sync.ts](../src/commands/sync.ts) →
[core/global-links.ts](../src/core/global-links.ts)) reconciles `~/<tail>` → `~/.worm/shared/<tail>` for
each tail in the global config's `shared_paths` (added to `GlobalConfigSchema`). Open questions resolved:
**dedicated `worm sync --global`** (kept project `sync` focused); global manifest at
**`~/.worm/.managed-links.json`** (auto-gitignored out of the personal repo). Missing sources are
sprouted as empty dirs; a real path at the target is left untouched with a warning (clobber-safe). It
adopts your existing manual links idempotently (a correct symlink is a no-op).

```jsonc
// ~/.worm/config.json   (today holds only {"editor":"code"})
{
  "editor": "code",
  "shared_paths": [".claude/commands", ".claude/skills", ".claude/scheduled-tasks"]
  // scope = ~ ; store = ~/.worm/shared/ ; → ~/.claude/commands -> ~/.worm/shared/.claude/commands
}
```

- Reconciled by `worm sync` against a **global manifest** (`~/.worm/.managed-links.json`), reusing the
  exact reconcile/prune logic. [`ensureSymlink`](../src/core/symlinks.ts) already refuses to clobber an
  existing real `~/.claude/commands`.
- `~/.worm` is **personal/single-user** — team-shared things belong in an **external store** (Decision
  2), not here. (This is precisely why external stores exist: `~/.worm` can't be shared with a team.)
- **Open questions:** dedicated `worm sync --global` vs folding into `worm sync` (runnable from
  anywhere); and confirming `~/.worm/.managed-links.json` as the global manifest location.

---

## Sequencing (by leverage ÷ risk)

1. **✅ DONE (2026-06-06) — stop copying worm-owned recipe code** (recipes-roadmap spine bucket 1).
   The interceptor + permission-sync scripts now live once in `src/recipes/` → `dist/recipes/`
   (resolved via `packagedRecipeScript()`), referenced by the generated hooks with per-project bits
   (container/compose/policy/log-dir) passed as args + env. New `WORM_RECIPE=` hook marker, with a
   transitional `/.worm/recipes/` matcher so one `worm sync` migrates an existing project cleanly.
   **Follow-up:** existing projects keep orphaned stale copies under `.worm/recipes/{sandbox,syncPermissions}/`
   — harmless (nothing references them) but a `worm sync` could prune worm-owned (un-edited) recipe
   artifacts. Not auto-deleted yet (user-owned-after-generation guard).
2. **✅ DONE (2026-06-06) — inverted dispatcher** (recipes-roadmap spine). `settings.local.json` now
   holds ONE static `node "<cli>" hook trigger <event>` entry per event; recipes declare their commands
   as data (`Recipe.hooks`), and the dispatcher ([src/commands/hook.ts](../src/commands/hook.ts))
   resolves the live slot, injects env, owns logging, and forwards the interceptor's decision.
   Enable/disable/update is now a pure `config.json` edit. **Follow-up:** the hot-path fast path
   (recipes-roadmap spine (iv)) — each `pre-tool-use` still boots the full CLI; fine for now, optimize later.
3. **✅ DONE (2026-06-06) — global (home-scope) setups** (Decision 3). `worm sync --global` links
   `~/<tail>` → `~/.worm/shared/<tail>` from the global config's `shared_paths`; clobber-safe, pruning,
   gitignored manifest. (Done out of nominal order — highest value-per-risk, fully additive, no migration.)
4. **✅ DONE (2026-06-06) — consolidate `.worm/`** (Decision 1). recipes/logs/manifest live in the
   profile; `.worm/` is config/scripts/recipes/logs symlinks + `.gitignore`; the shared/ two-hop is gone
   (slot links are absolute, one hop); old projects migrate in place ([core/layout.ts](../src/core/layout.ts)).
5. **Named stores** (Decision 2) — external/team repos as link sources. Now the natural next step: the
   link source is already a single profile path, so generalizing it to a chosen store is a focused change.
   **✅ DONE (2026-06-06)** — [core/stores.ts](../src/core/stores.ts); see Decision 2.
6. **✅ DONE (2026-06-06) — templating** (recipes-roadmap §3). Homemade `{{var}}` `renderTemplate`
   ([utils/template.ts](../src/utils/template.ts)); sandbox scaffolds are real `.tmpl` files; `worm template render`
   exposes it for user setups. **Versioning (recipes-roadmap §6)** — Terraform-style plan/apply so engine
   updates re-render un-edited bucket-3 artifacts — is the **last open item**, deferred (the artifact set
   is tiny and non-clobbering today, so the pain is low).

## Open cross-cutting questions

- ~~**Where stores are declared.**~~ **Resolved:** global stores in `~/.worm/config.json`, project
  stores in the project config; a `shared_paths` entry can reference either, with **project stores
  overriding** same-named global ones (`resolveStoreLinks` merges global-then-project).
- **Trust.** With inverted dispatch, third-party recipe **code runs in worm's dispatcher process on the
  hot path** — the sandbox/trust model is an open question (recipes-roadmap §1).
- **Failure semantics on the hot path.** The dispatcher gates every Bash command, so: absolute-path
  worm binary, interceptor fails *safe*, session hooks fail *open*, minimal-load fast path
  (recipes-roadmap spine).
