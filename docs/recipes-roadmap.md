# Recipes & file-generation — improvement roadmap

> Status: **design notes, nothing implemented.** Captured 2026-06-01 from a working session.
> These are known warts in the recipe engine and a sketch of where to take it. Treat as a
> backlog/brain-dump, not a spec. Revisit before the next big recipe change.

## Why this exists

The recipe engine shipped with Strategy 3 (see [strategy-3-spec.md](strategy-3-spec.md) §6) works, but
authoring and maintaining recipes is not pleasant, and propagating changes is manual and error-prone.
This doc lists the pain points and possible directions so a future pass has a starting point.

## Current state (so the next reader has context)

- **Recipes are hardcoded.** [src/core/recipes.ts](../src/core/recipes.ts) defines a fixed `REGISTRY`
  array of three built-ins (`sandbox`, `syncPermissions`, `shareHistory`). A recipe is a TS object
  implementing the `Recipe` interface (`select` / `artifacts` / `wireSlot` / `onSlotCreate`).
- **Recipe config is part of that TS.** Each recipe's options are a zod schema in
  [src/types.ts](../src/types.ts) (`SandboxRecipeSchema`, …). Enabling a recipe = adding its key to a
  project's `recipes: {}` config.
- **Script artifacts are embedded strings.** The `.js` files a recipe writes (the sandbox interceptor,
  the permission-sync script) live as `String.raw` template literals in
  [recipes.ts](../src/core/recipes.ts) (e.g. the interceptor at ~L454–598). They are NOT real source
  files — no syntax highlighting, no linting, no tests against them directly, and the `String.raw`
  "no backticks / no `${}`" constraint is a foot-gun.
- **Artifacts are materialized non-clobbering.** `materializeRecipes` uses `writeTextIfMissing`, so once
  an artifact exists in a project's `.worm/recipes/<name>/`, `worm sync` will **not** overwrite it. The
  hook *wiring* in `.claude/settings.local.json` IS re-applied declaratively every sync; only artifact
  *content* is sticky.
- **Two parallel file-generation systems exist.** Recipe artifacts (above) AND ad-hoc profile templates
  like `~/.worm/multiverses/mkpc/scripts/docker-compose.override.template.yml`, which uses hand-rolled
  `{{NAME}}` / `{{PORT}}` placeholders rendered by the project's `setup.sh`. Same underlying problem
  ("write a file that depends on parameters"), solved twice, differently.

---

## 1. Third-party / shareable recipes

**Problem.** Recipes are baked into the `REGISTRY` in this repo. A user can't write their own recipe or
share one without forking wormhole.

**Why it matters.** Recipes are pitched as "composable capabilities" — that only pays off if the set is
open. The interesting recipes are org-specific (a company's sandbox image, a custom permission policy, a
secrets-injection step).

**Possible direction.**
- A recipe-discovery mechanism: load recipes from `~/.worm/recipes/<name>/` (and/or a project-local
  dir) in addition to built-ins, so a recipe is just a directory you can copy/git-clone/share.
- Define a recipe as **data + assets** (see §2 and §3) rather than compiled TS, so loading a
  third-party recipe doesn't mean executing arbitrary TS from the engine's process. If recipes can run
  logic, sandbox/trust them deliberately.
- Open question: distribution. npm packages? A `worm recipe add <git-url>`? A registry?

## 2. Recipe config as data (JSON/YAML), not TS

**Problem.** A recipe's shape and defaults are TS/zod in this repo. Adding or tweaking a recipe means
editing typed code and rebuilding.

**Why it matters.** Couples every recipe change to a wormhole release; blocks §1 (third-party recipes
shouldn't need a TS toolchain).

**Possible direction.**
- A recipe manifest file (`recipe.json` / `recipe.yaml`) declaring: name, config schema (JSON Schema),
  artifacts (templates + outputs), hook contributions, and any imperative steps.
- Keep zod validation, but generate/load schemas from the manifest rather than hand-writing per recipe.
- Open question: how much *logic* can be declarative before a recipe needs real code (e.g.
  `shareHistory`'s symlink-and-skip-if-real-dir behavior). Maybe: declarative for the common case,
  escape hatch to a script for the rest.

## 3. Real script files + one templating engine (for recipes AND setups)

**Problem.** Generated `.js`/config files are `String.raw` strings in TS — unmaintainable. Quote from
the session: *"really not clean, I'll never want to maintain that."*

**Why it matters.** The interceptor is non-trivial logic (quote-aware command parsing). It deserves to
be a real file with linting and tests. The `String.raw` constraints actively invite bugs.

**Possible direction.**
- Ship recipe artifacts as **actual files** in the recipe's directory (e.g.
  `recipes/sandbox/templates/redirect-to-sandbox.js`), copied/rendered into `.worm/recipes/` at
  materialize time. They can be real, lintable, testable source.
- Adopt **one templating engine from npm** (candidates: `eta` — tiny, `mustache`, `handlebars`,
  `nunjucks`) for any file whose content depends on parameters. Replaces both the `String.raw` renderers
  (`renderDockerfile`/`renderCompose`) and the ad-hoc `{{...}}` in profile templates like
  `docker-compose.override.template.yml`.
- **Generalize "render a parameterized file" as a first-class primitive** shared by recipes and setups.
  Both are the same operation: (template + variables) → file. A single renderer + a documented variable
  set (the `WORM_*` env, slot index, ports, project name…) would unify them.
- Constraint to respect: wormhole keeps deps intentionally small (commander, execa, picocolors, zod —
  see [CLAUDE.md](../CLAUDE.md)). Pick a minimal engine and justify it. `eta` is ~1 file.

## 4. Automatic logging plumbing in the engine

**Problem.** A recipe hook that wants its output logged must hand-build the redirect. Today the
`logged()` helper wraps a command in `{ …; } >> file 2>&1` and each recipe must remember to use it; the
log dir, filename, and dated banner are all manual. Quote: *"the logging part should be done
automatically by the recipes engine."*

**Why it matters.** Boilerplate that's easy to forget (and which we *did* get wrong — recipe hooks that
didn't log were invisible). Logging is a cross-cutting concern the engine should own.

**Possible direction.**
- An **AgentAdapter** abstraction (name TBD) that sits between a recipe's *declarative* hook
  ("run this command on SessionStart, label it `up`") and the concrete agent's settings format
  (Claude Code's `settings.local.json` today; Roo/Cody/etc. later — see the multi-agent pitch in
  [README.md](../README.md)). It would expose something like
  `addRecipeHook(event, command, { log })` that handles: namespacing (so recipes compose), the log
  redirect + banner, and the agent-specific JSON shape. Recipes stop knowing about
  `settings.local.json` or `>>` redirects entirely.
- This also decouples recipes from Claude Code specifically, which is a prerequisite for supporting
  other agents.

## 5. Propagation ergonomics (the "twice" problem + missing command)

**Problem.** Changing a recipe today means propagating through layers by hand:
1. Edit the engine in `~/git/wormhole` → `pnpm build` → the global `worm` binary updates.
2. For each project, the generated artifact in `.worm/recipes/` must be regenerated — but because
   materialization is **non-clobbering**, `worm sync` alone does nothing. You must `rm` the stale
   artifact, then `worm sync`.

And recipe *config* changes (e.g. sandbox `tools`) live in `~/.worm/multiverses/<name>/config.json`,
which then has to reach every universe — again via delete-artifact + sync. Quote: *"when I change a
recipe I have to propagate it twice … not convenient at all."*

**Direct answer to the session question** ("how to apply a recipe change in `~/.worm`? `worm sync`
didn't work — is there a dedicated command?"): **No, there isn't.** `worm sync` re-applies hook wiring
and shared-path links declaratively and creates *missing* artifacts, but it will not overwrite existing
recipe artifacts. The current workaround is `rm .worm/recipes/<name>/<file>` (or `rm -rf
.worm/recipes`) then `worm sync`.

**Why it matters.** Every recipe iteration is a multi-step manual chore across N projects; easy to leave
a project on a stale artifact (exactly the class of bug we spent this session cleaning up).

**Possible direction.**
- A dedicated command, e.g. `worm recipes sync` / `worm sync --recipes` / `worm sync --force`, that
  **re-renders managed artifacts** rather than skipping existing ones.
- To preserve the "user can edit a generated artifact" property, track whether an artifact is still
  pristine (checksum/lockfile, or a "managed region" marker) and only overwrite untouched ones; **diff
  + warn** on user-edited ones instead of clobbering (see §6 — this is the same machinery).
- Consider an all-projects fan-out (`worm recipes sync --all`) so one command updates every universe,
  not one project at a time.

## 6. Version updates / upgrades (Terraform-inspired)

**Problem.** No upgrade story. Dev installs worm 1.0.0; we ship 1.1.0 with improved recipes. How does
the dev's *already-generated* artifacts get updated — automatically on version bump, manually, or via an
explicit command?

**Why it matters.** This is the general form of §5. Without it, recipe fixes (like this session's
interceptor fix) silently fail to reach existing installs; every user is frozen at whatever recipe
version first generated their files.

**Possible direction — borrow from Terraform.**
- **Versioned recipes + constraints.** Recipes carry a version; a project pins/contrains it.
- **Explicit, planned upgrades, not silent auto-update.** Terraform doesn't rewrite your world on a
  provider bump — you run `terraform init -upgrade` then `plan`/`apply`. A `worm recipes plan` could
  show what would change (which artifacts re-render, which you've edited) before `worm recipes apply`.
- **A lockfile + state.** Analogous to `.terraform.lock.hcl`: record which recipe version generated each
  artifact and a checksum of the pristine output. On upgrade: re-render artifacts that are unchanged
  since generation; for user-edited ones, show a diff and require opt-in (merge/overwrite/keep).
- **Migrations.** Some upgrades need data changes, not just file regen (this session migrated config
  schemas + the permission canonical by hand). A recipe could ship a migration step keyed by version,
  run during `apply`.
- Open question: where "state" lives. Project-local `.worm/` is ephemeral/gitignored; the durable home
  is the `~/.worm` profile. Probably the lockfile belongs with the profile (committed), per project.

---

## Cross-cutting theme

§5 and §6 are the same root tension: **artifacts are "user-owned after generation" (non-clobbering), which
directly conflicts with "propagate engine/recipe updates."** Any real fix needs a model that distinguishes
*managed* from *user-modified* content — a lockfile + checksums, a managed-region marker, or
Terraform-style state + plan/apply. Solve that once and both the "apply my recipe change" command and the
"upgrade across a version bump" story fall out of it.

§2, §3, and §4 together would turn a recipe from "a TS object in this repo with embedded string blobs"
into "a shareable directory of data + real template files, rendered by a common engine, wired through an
agent-agnostic adapter that handles logging" — which is also what unblocks §1 (third-party recipes) and
multi-agent support.
