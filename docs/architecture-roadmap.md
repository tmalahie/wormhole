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

## Decision 1 — consolidate the project-local `.worm/` (symlink-into-global) ✅

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
| `.managed-links.json` | real, local | keep local (per-checkout link state) — see open question |
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

**Open question:** should `.managed-links.json` also move to the profile (durable, survives a slot-0
reclone) or stay local (it describes *this* checkout's links)? It's already keyed by absolute slot path,
so either works. Lean: keep the link records authoritative in one place; decide during impl.

## Decision 2 — named stores (external + team resources) ✅

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

## Decision 3 — global (home-scope) setups [the manual `~/.claude` symlinks] ✅

Same primitive at **`HOME` scope** with the **global-shared store** (`~/.worm/shared/`). This replaces
the symlinks you currently make by hand: `~/.claude/{commands,skills,scheduled-tasks}` →
`~/.worm/shared/.claude/…`.

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
2. **Inverted dispatcher** (recipes-roadmap spine). Removes `settings.local.json` churn and the
   `isWormManaged` substring fragility; unblocks clean enable/disable/update.
3. **Consolidate `.worm/`** (Decision 1) — mostly mechanical once code lives once.
4. **Named stores (Decision 2) + global scope (Decision 3)** — the linking-layer generalization. These
   are **independent of recipes** and can proceed in parallel with 1–3.
5. **Templating + versioning** for the small bucket-3 set (recipes-roadmap §3/§6).

## Open cross-cutting questions

- **Where stores are declared.** Likely: global stores in `~/.worm/config.json`, project stores in the
  profile; a project `shared_paths` entry can reference either. Needs a resolution order.
- **Trust.** With inverted dispatch, third-party recipe **code runs in worm's dispatcher process on the
  hot path** — the sandbox/trust model is an open question (recipes-roadmap §1).
- **Failure semantics on the hot path.** The dispatcher gates every Bash command, so: absolute-path
  worm binary, interceptor fails *safe*, session hooks fail *open*, minimal-load fast path
  (recipes-roadmap spine).
