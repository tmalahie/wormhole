# Recipes & file-generation — improvement roadmap

> Status: **design notes + decisions.** Captured 2026-06-01 (brain-dump), reviewed and partly
> **decided** 2026-06-06. Sections marked ✅ are decided directions; the rest are still open backlog.
> Companion docs: [architecture-roadmap.md](architecture-roadmap.md) covers the *linking layer* (where
> worm state lives, stores, scopes) — several decisions here depend on it;
> [multi-agent-roadmap.md](multi-agent-roadmap.md) covers wiring agents other than Claude Code.
>
> **Active next items (2026-06-06):** §1 + §2 — *shareable recipe packages* (the "Next up" plan at the
> bottom of this doc), and the agent-adapter seam in
> [multi-agent-roadmap.md](multi-agent-roadmap.md). They're synergistic: a recipe-as-data format (§2) is
> what an agent adapter renders per agent.

## Why this exists

The recipe engine shipped with Strategy 3 (see [strategy-3-spec.md](strategy-3-spec.md) §6) works, but
authoring and maintaining recipes is not pleasant, and propagating changes is manual and error-prone.
This doc lists the pain points and the directions we settled on so a future pass has a starting point.

## Current state (so the next reader has context)

- **Recipes are hardcoded.** [src/core/recipes.ts](../src/core/recipes.ts) defines a fixed `REGISTRY`
  array of three built-ins (`sandbox`, `syncPermissions`, `shareHistory`). A recipe is a TS object
  implementing the `Recipe` interface (`select` / `artifacts` / `wireSlot` / `onSlotCreate`).
- **Recipe config is part of that TS.** Each recipe's options are a zod schema in
  [src/types.ts](../src/types.ts) (`SandboxRecipeSchema`, …). Enabling a recipe = adding its key to a
  project's `recipes: {}` config.
- **Script artifacts are embedded strings.** The `.js` files a recipe writes (the sandbox interceptor,
  the permission-sync script) live as `String.raw` template literals in
  [recipes.ts](../src/core/recipes.ts) (e.g. the interceptor at ~L454–613). They are NOT real source
  files — no syntax highlighting, no linting, no tests against them directly, and the `String.raw`
  "no backticks / no `${}`" constraint is a foot-gun.
- **Artifacts are materialized non-clobbering.** `materializeRecipes` uses `writeTextIfMissing`, so once
  an artifact exists in a project's `.worm/recipes/<name>/`, `worm sync` will **not** overwrite it. The
  hook *wiring* in `.claude/settings.local.json` IS re-applied declaratively every sync; only artifact
  *content* is sticky.
- **The drift is already real (concrete evidence, 2026-06-06).** `sync-claude-settings.js` is
  byte-identical across the `arcads-monorepo` and `mkpc` projects, but `redirect-to-sandbox.js` has
  **silently diverged**: mkpc is frozen on an older version (`neverSandbox: ['npm', …]`, `FILE_OPS`
  still listing `mkdir/touch/ln/chmod`) while arcads got re-materialized after the engine changed. Same
  script, two versions, purely because each project froze its own copy and nobody `rm`'d the stale one.
  This is the propagation bug below (§5/§6) caught in the wild — and the motivation for the spine.
- **Two parallel file-generation systems exist.** Recipe artifacts (above) AND ad-hoc profile templates
  like `~/.worm/projects/mkpc/scripts/docker-compose.override.template.yml`, which uses hand-rolled
  `{{NAME}}` / `{{PORT}}` placeholders rendered by the project's `setup.sh`. Same underlying problem
  ("write a file that depends on parameters"), solved twice, differently.

---

## ⭐ The spine: three artifact kinds + inverted dispatch (decided 2026-06-06)

The engine today conflates three fundamentally different "generated things." Separating them dissolves
most of the pain in §3–§6. **A generated artifact is exactly one of:**

1. **Worm-owned code** — the sandbox interceptor, the permission-sync script. These are
   **config-independent** (they read their parameters at run time from argv/env/a sibling JSON) and so
   are **byte-identical across projects**. ✅ **They live ONCE** — shipped inside the `worm` package for
   built-ins, or under `~/.worm/recipes/<name>/` for third-party (see §1). They are **never copied
   per-project.** Fixing the code = upgrading worm (or the one shared copy) = instant propagation to
   every project. The mkpc/arcads drift above is the proof this is the right model: there was never a
   reason for two copies, and having two is what let them diverge.
   **Status: SHIPPED 2026-06-06** for built-ins — the interceptor + sync script now live in
   `src/recipes/` → `dist/recipes/` (`packagedRecipeScript()`); hooks pass per-project bits as args +
   `WORM_RECIPE=`/`WORM_LOG_DIR` env, with a transitional `/.worm/recipes/` marker for clean upgrades.
   (Third-party loading from `~/.worm/recipes/` is still §1; the inverted dispatcher below is still
   future — recipes currently still emit their own per-recipe settings entries, just repointed.)

2. **Runtime config** — the container name, `docker compose -p` project, `SANDBOX_DIR`, and the sandbox
   policy's `neverSandbox`/`exemptDirs`. This **already lives in `config.json`.** ✅ It is
   **computed/read at trigger time and injected** by the dispatcher (below) as env/args — *not* rendered
   to a per-project file. (`sandbox-policy.json` becomes redundant; the dispatcher passes the policy, or
   the script reads the profile config live.) Recomputing identifiers each run also fixes a latent bug:
   today `arcads-monorepo-main-sandbox` is frozen into `settings.local.json` at materialize time and
   goes stale on a rename/slot move.

3. **Templated, user-owned scaffolding** — the `Dockerfile` (and arguably `compose.yml`): content
   genuinely varies per project **and** the user is meant to edit it afterward. This is the **only** kind
   that needs a templating engine (§3) and a propagation/versioning story (§6). After (1) and (2) are
   pulled out, **this set is tiny** — basically the Dockerfile.

### Inverted dispatch ✅

`settings.local.json` gets **one static worm entry per hook event** — `worm hook trigger <event>` —
installed once at init and **never rewritten**. Recipes declare their per-event commands as **data**
(part of the recipe manifest, §2). At trigger time worm resolves the current slot, computes identifiers
fresh, injects env, runs each enabled recipe's command for that event, and owns logging centrally (§4).

**Why this over per-recipe commands baked into settings** (decided after challenge):
- **Enable/disable/update a recipe is a pure `config.json` edit.** `settings.local.json` never churns,
  and the fragile [`isWormManaged`](../src/core/recipes.ts#L264-L274) logic — which today guesses which
  hook entries are worm's by sniffing for the `.worm/recipes/` substring — can largely be **deleted**.
- **Identifiers stay correct.** They're recomputed each trigger, so a rename or slot reshuffle can't
  leave a stale `…-main-sandbox` string behind.
- **Logging/env stop being copy-pasted** into every command (§4).

**The accepted cost:** worm's health now gates the hot path (`PreToolUse` fires on *every* Bash command).
So the dispatcher must:
- (i) reference the worm binary by **absolute path**, not `PATH`, so a shell-env change can't silently
  disable the sandbox;
- (ii) have **defined failure semantics** — dispatcher *infra* failures (can't resolve the project /
  load config) **fail OPEN** and append to `.worm/logs/dispatch.log`, because a worm bug must not block
  every command; the interceptor's own decision logic is unchanged (it already allows on malformed
  input). Session hooks swallow errors (never block a session);
- (iii) faithfully pass **stdin→stdout** for the interceptor (its stdout *is* the permission decision);
- (iv) use a **minimal-load fast path** (don't boot the whole CLI on every Bash).

The latency objection to wrapping the hot path was judged **premature**: tens of ms, optimizable, and
dwarfed by the agent's per-command LLM round-trip. The update/uninstall cleanliness wins easily.

**Status: SHIPPED 2026-06-06.** `worm hook trigger <event>` ([src/commands/hook.ts](../src/commands/hook.ts))
is the dispatcher; recipes declare `hooks(ctx, cfg): HookContribution` (data), and
[applyRecipeWiring](../src/core/recipes.ts) installs ONE static `node "<cli>" hook trigger <event>` entry
per event. (i)/(ii)/(iii) are done; the `isWormManaged` substring logic shrank to a single
`hook trigger` marker plus two transitional legacy markers for one-sync migration. **Not yet done:**
(iv) the fast path — each hot-path call still boots the full CLI + does ~2 git calls; acceptable for now
(dwarfed by the LLM loop) but the obvious next optimization. Recipes-as-shareable-data (§1/§2) is still
future; today the recipe set is still the hardcoded built-in `REGISTRY`.

---

## 1. Third-party / shareable recipes

**Problem.** Recipes are baked into the `REGISTRY` in this repo. A user can't write their own recipe or
share one without forking wormhole.

**Why it matters.** Recipes are pitched as "composable capabilities" — that only pays off if the set is
open. The interesting recipes are org-specific (a company's sandbox image, a custom permission policy, a
secrets-injection step).

**Direction.**
- Load recipes from `~/.worm/recipes/<name>/` (and/or a project-local dir) in addition to built-ins, so
  a recipe is a directory you can copy/git-clone/share. This is also where spine-bucket-1 **code** lives
  once.
- A recipe is **data + assets** (see §2) — a manifest plus real code/template files — not compiled TS,
  so loading one doesn't mean compiling TS in the engine's toolchain.
- **Trust caveat:** with inverted dispatch, third-party recipe code runs **in worm's dispatcher process,
  on the hot path.** A trust/sandbox model for untrusted recipe code is an open question, sharper now
  than before.
- Open question: distribution. npm packages? `worm recipe add <git-url>`? A registry?

## 2. Recipe config as data (JSON/YAML), not TS

**Problem.** A recipe's shape and defaults are TS/zod in this repo. Adding or tweaking a recipe means
editing typed code and rebuilding.

**Why it matters.** Couples every recipe change to a wormhole release; blocks §1.

**Direction.**
- A recipe manifest (`recipe.json` / `recipe.yaml`) declaring: name, config schema (JSON Schema),
  artifacts (which are spine-bucket-3 templates), the **(event → command) table** the dispatcher reads,
  and any imperative steps.
- Keep zod validation, but generate/load schemas from the manifest rather than hand-writing per recipe.
- Open question: how much *logic* can be declarative before a recipe needs real code (e.g.
  `shareHistory`'s symlink-and-skip-if-real-dir behavior). Likely: declarative for the common case, with
  an escape hatch to a spine-bucket-1 script for the rest.

## 3. One templating primitive — ✅ SHIPPED 2026-06-06

**Status: SHIPPED — homemade, not a library.** After the spine shrank templating to plain `{{var}}`
substitution (no user-facing logic), a ~25-line [utils/template.ts](../src/utils/template.ts)
`renderTemplate` won over `eta`: zero deps (honoring the small-deps rule), and converting `compose.yml`
to a real template **killed the `\${VAR}` escaping foot-gun** (`{{…}}` and `${…}` don't collide). The
sandbox `Dockerfile`/`compose.yml` are now real `.tmpl` files under `src/recipes/sandbox/templates/`
(rendered at materialize time; the lone conditional — the apt-get block — is precomputed and passed as a
`{{tools}}` var). Exposed as **`worm template render <file> KEY=VALUE …`** so user setups (`setup.sh`) can drop
their hand-rolled sed. (`eta` remains the escape hatch if logic in user-editable templates is ever wanted.)

**Problem (original).** Generated `.js`/config files are `String.raw` strings in TS — unmaintainable.
Quote: *"really not clean, I'll never want to maintain that."*

**Resolution.** The spine splits this in two:
- **Code is no longer templated at all.** The interceptor / sync script become **real source files** in
  the package (or recipe dir), linted and tested, that live once and read params at run time. The
  `String.raw` foot-gun disappears for code because there are no embedded code strings anymore.
- **Templating applies only to spine-bucket-3 scaffolding** (the Dockerfile, maybe compose). For that
  small set, adopt **one minimal engine** — `eta` (~1 file) fits the small-deps rule
  ([CLAUDE.md](../CLAUDE.md): commander/execa/picocolors/zod). It also replaces the ad-hoc `{{…}}` in
  profile templates like `docker-compose.override.template.yml`, unifying the "two parallel systems."
- **Generalize "render a parameterized file"** as a first-class primitive shared by recipes and setups:
  (template + the documented `WORM_*` variable set) → file. One renderer, one variable vocabulary.

## 4. Automatic logging — owned by the dispatcher (revised 2026-06-06)

**Problem.** A recipe hook that wants its output logged must hand-build the redirect. The
[`logged()`](../src/core/recipes.ts#L120-L122) helper wraps a command in `{ …; } >> file 2>&1` and each
recipe must remember to use it; log dir, filename, and dated banner are all manual. Quote: *"the logging
part should be done automatically by the recipes engine."*

**Resolution ✅.** This is now the **inverted dispatcher's** job (the concrete form of the old, abstract
"AgentAdapter"). A recipe declares `(event, command, { log })`; the dispatcher does the redirect, the
dated banner, the log path, and the agent-specific settings shape. Recipes stop knowing about
`settings.local.json` or `>>` redirects entirely — which also decouples them from Claude Code, a
prerequisite for other agents.

> Note this kills a latent bug: `sync-claude-settings.js` currently hardcodes its log path as
> `__dirname/../../logs`, which only resolves *because the script is copied into `.worm/`*. Moving it to
> live-once (spine-bucket-1) would break that — which is exactly why the **log location must be injected
> by the dispatcher, not hardcoded in the script.**

## 5. Propagation ergonomics — largely dissolved (revised 2026-06-06)

**Problem (original).** Changing a recipe meant propagating by hand: rebuild the engine, then for each
project `rm` the stale artifact (materialization is non-clobbering) and `worm sync`. Quote: *"when I
change a recipe I have to propagate it twice … not convenient at all."*

**Resolution.** The spine removes most of this:
- **Code (bucket 1) propagates for free** — one copy; upgrading worm (or the single shared copy) updates
  every project. No per-project re-materialize.
- **Runtime config (bucket 2) is read live** — nothing to propagate.
- **Only bucket-3 scaffolding** (the Dockerfile-class files) still needs a re-render. So the "twice"
  problem shrinks to a single, small command (`worm recipes sync` / `--force`) over a handful of files,
  governed by §6's managed/user-edited distinction. Consider an all-projects fan-out
  (`worm recipes sync --all`).

**Direct answer to the original session question** ("is there a command to apply a recipe change?"):
today, **no** — the workaround is `rm .worm/recipes/<name>/<file>` then `worm sync`. After the spine,
that need mostly evaporates (code/config) and is a deliberate `--force` re-render for scaffolding.

## 6. Version updates / upgrades (Terraform-inspired) — scoped down (revised 2026-06-06)

**Problem.** No upgrade story for already-generated artifacts.

**Why it still matters (narrowed).** Code and hook-wiring now update for free (one copy; static
dispatcher entry). What remains is **bucket-3 scaffolding** the user has edited, plus **data
migrations** (config-schema bumps, moving a canonical store — done by hand this session).

**Direction — borrow from Terraform, for the small remaining surface.**
- **Versioned recipes + constraints**; explicit **plan/apply**, not silent auto-update
  (`worm recipes plan` → `apply`).
- **A lockfile + state**: record which recipe version generated each *scaffolding* artifact + a checksum
  of the pristine output. On upgrade: re-render untouched ones; for user-edited ones, show a diff and
  require opt-in. The lockfile/state lives **with the profile** (committed) — consistent with the
  consolidation in [architecture-roadmap.md](architecture-roadmap.md) (Decision 1).
- **Migrations** keyed by version, run during `apply`, for the data changes file-regen can't cover.

---

## Cross-cutting theme (revised)

The original tension was: *artifacts are "user-owned after generation" (non-clobbering), which conflicts
with "propagate engine/recipe updates."* **The spine shrinks that conflict to a corner.** Code and
hook-wiring are now purely worm-owned (no user edits expected) and update freely; runtime config is read
live. Only the handful of **bucket-3 scaffolding** files are "user-owned after generation," so the
managed-vs-user-modified machinery (lockfile + checksums / plan-apply, §6) only has to cover *them* — not
the whole artifact set.

§1 + §2 still describe the open work to make recipes **shareable directories of data + real files**; the
spine (live-once code + inverted dispatch) is the architecture they plug into, and is also what unblocks
multi-agent support ([multi-agent-roadmap.md](multi-agent-roadmap.md)) — logging/wiring already moved
behind the dispatcher.

---

## Next up (2026-06-06): shareable recipe packages — the §1 + §2 plan

§1 (third-party recipes) and §2 (recipe-as-data) ship together: you can't load a recipe from a folder
until a recipe is *expressible* as a folder. This is the concrete, phased plan, grounded in today's code.

**Where the seams already are.** Built-ins are the `REGISTRY` array
([recipes.ts#L257](../src/core/recipes.ts#L257)); everything downstream consumes them only through
[`enabledRecipes`](../src/core/recipes.ts#L259-L266) (`materializeRecipes` / `applyRecipeWiring` /
`runRecipeHooks` / `runRecipeFilters`). So the loader's whole job is to **return a longer `REGISTRY`** —
built-ins plus whatever it discovered on disk. Nothing downstream needs to change. Two real blockers stand
between here and that:

1. **Config is `.strict()` zod** ([types.ts#L36-L43](../src/types.ts#L36-L43)). `RecipesSchema` enumerates
   exactly `sandbox` / `syncPermissions` / `shareHistory`, so an unknown recipe key is a hard *Invalid
   config* error. A loaded recipe must be able to register its own key + schema.
2. **Recipe code resolves from the package** ([`packagedRecipeScript`](../src/core/paths.ts) →
   `dist/recipes/`). A third-party recipe's scripts/templates must resolve from *its* directory instead.

### Phase 1 — a recipe is a directory (define the format)

A recipe becomes a folder with a manifest + real files, loadable without compiling TS:

```
<name>/
  recipe.json        # name, config JSON Schema, the (event → command) table, requires[], onSlotCreate?
  *.js               # worm-owned, config-independent scripts (live-once; read params at run time)
  templates/*.tmpl   # bucket-3 scaffolding rendered with renderTemplate
```

- The `recipe.json` *(event → command)* table is precisely what `Recipe.hooks()` returns today, as data.
  Commands reference `{{recipeDir}}` / the documented `WORM_*` vars; the dispatcher still injects env and
  owns logging, so the manifest stays declarative.
- The **built-ins migrate to this format first** (dogfood it) — `sandbox` is the stress test (it has a
  script, two templates, a policy, and a conditional). Keep `Recipe` as the in-memory shape; add a
  `recipeFromManifest(dir): Recipe` that adapts a folder to it. Built-ins stay in `dist/recipes/`; the
  interface the engine sees is unchanged.

### Phase 2 — load recipes from disk (open the set, §1)

- Discover folders in `~/.worm/recipes/<name>/` (global) and optionally a project-local dir; merge with
  built-ins (project/global override a built-in of the same name — same precedence rule as stores).
- `REGISTRY` becomes `loadRecipes()` = built-ins ++ discovered. `packagedRecipeScript` generalizes to
  `recipeAsset(recipe, rel)` resolving against the recipe's own dir.
- **Config validation goes dynamic (§2).** `RecipesSchema` stops being a fixed `.strict()` object: build
  the recipe map's schema from the union of loaded recipes' JSON Schemas. Keep zod under the hood (compile
  each manifest's JSON Schema → a validator); unknown key = "no such recipe `foo`; is it installed under
  `~/.worm/recipes/`?" with a hint, *not* a raw strict-parse failure.
- **Distribution** (open): `worm recipe add <git-url>` cloning into `~/.worm/recipes/<name>/` is the
  smallest thing that works and matches the stores clone-on-demand pattern. npm / a registry are heavier
  and can wait.

### Phase 3 — trust (the sharp new question)

With inverted dispatch, a third-party recipe's code runs **in worm's dispatcher process, on the hot path**
(every Bash command). Before recipes are casually shareable:

- At minimum: **explicit opt-in per recipe source** (a loaded recipe from outside the package is inert
  until trusted — `worm recipe trust <name>`), recorded in the profile.
- Consider running recipe hook commands themselves through the sandbox, or a capability allowlist in
  `recipe.json` the user reviews on `add`. This is genuinely open — flag it loudly, don't hand-wave it.

### What this deliberately is *not*

Not a plugin system with arbitrary TS compiled in the engine's toolchain (§2 keeps recipes *data + assets*,
not code linked into worm). Not the versioning/plan-apply story (§6, still deferred) — a loaded recipe's
scaffolding obeys the same non-clobbering rule as today until §6 lands.
