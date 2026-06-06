# Multi-agent support — roadmap

> Status: **design notes.** Captured 2026-06-06. Companion to
> [recipes-roadmap.md](recipes-roadmap.md) (the recipe engine) and
> [architecture-roadmap.md](architecture-roadmap.md) (the linking layer). This doc is about making the
> recipe engine wire **any** coding agent, not just Claude Code.

## Why this exists

The README pitches worm as *"a hub for your coding agents … on a deliberately agent-agnostic core."*
That's already **true of the substrate** and **not yet true of the recipes**. Splitting those two cleanly
is the whole job.

- **Agent-agnostic today (no work needed):** the warm worktree pool, the `shared_paths` / stores
  tunnels, worm's *own* lifecycle hooks (`on_create` / `on_remove`, fired by `worm` commands — not by
  any agent), and the **instructions file** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` are just shared
  paths). None of this knows which agent you run.
- **Claude-bound today (the recipe engine):** every recipe wires Claude Code specifically — its settings
  file, its hook events, its permission-decision protocol, its history store.

So "support other agents" ≠ rewrite worm. It's: **pull the Claude-specific knowledge out of the recipe
engine into two seams — a shared *adapter* for the universal plumbing, and per-agent *providers* for the
capability mechanisms that genuinely differ — then ship a second agent.** The guiding rule throughout: a
recipe is **agnostic in intent, per-agent in mechanism**.

## Current state — the coupling inventory (audited 2026-06-06)

Every place the recipe engine assumes Claude Code, and what it generalizes to:

| # | Coupling | Where | Claude-specific bit | Generalizes to |
|---|---|---|---|---|
| 1 | Hook-event names | [`HOOK_EVENTS`](../src/core/recipes.ts#L107-L111) | maps to `PreToolUse` / `SessionStart` / `SessionEnd` + the `Bash` matcher | worm **already** has normalized `pre-tool-use` / `session-start` / `session-end`; only the `claudeEvent` + `matcher` mapping is Claude's |
| 2 | Settings file + schema | [`writeSlotHooks`](../src/core/recipes.ts#L441) → `.claude/settings.local.json`; entry shape `{ matcher, hooks:[{type:"command",command}] }` built at [L333-L337](../src/core/recipes.ts#L333-L337) | the file path **and** the JSON schema worm writes a dispatcher entry into | "install ONE dispatch entry for normalized event *E* into agent *A*'s config" |
| 3 | Deny protocol | [`runRecipeFilters`](../src/core/recipes.ts#L415) sniffs `"permissionDecision":"deny"`; [`redirect-to-sandbox.js`](../src/recipes/sandbox/redirect-to-sandbox.js#L83-L85) emits Claude's deny JSON | the allow/deny contract on stdin→stdout | encode/decode a **normalized** allow/deny decision |
| 4 | Project-dir env | [`hook.ts`](../src/commands/hook.ts#L57) + both recipe scripts read `CLAUDE_PROJECT_DIR` | the env var name the agent sets to locate the slot | adapter declares which env var locates the slot (fallback `cwd`) |
| 5 | History store | [`shareHistory`](../src/core/recipes.ts#L233-L255) → `~/.claude/projects/<slug>` + [`claudeSlug`](../src/core/recipes.ts#L229) | history dir location **and the mechanism** (symlink a jsonl dir) | a **recipe provider** (not adapter data) — mechanism varies: symlink a dir / merge a db / nothing |
| 6 | Permission store | [`sync-claude-settings.js`](../src/recipes/syncPermissions/sync-claude-settings.js) merges the `permissions` block of `settings.local.json` | the allowlist file + its `permissions.allow` shape | a **recipe provider** — only agents with a file-based allowlist have one |

The good news the table makes obvious: **worm already normalized the events** (#1) and **already centralized
dispatch** behind `worm hook trigger`. The remaining five couplings are all reachable from a handful of
functions — there's no Claude assumption smeared across the codebase.

## The decoupling unit — adapter plumbing vs. recipe providers

The seam isn't one object — it's **two layers**, and which layer a coupling belongs in is decided by one
question: *what varies across agents?*

- **A value** (where's the settings file, which env var names the slot, how is "deny" spelled) — the
  recipe body is identical, only a datum changes → a shared **`AgentAdapter`**: the universal plumbing
  every hook-capable agent needs.
- **The whole mechanism** (symlink a jsonl dir vs. merge a sqlite db vs. nothing) → a **per-agent provider
  inside the recipe**. The recipe owns the *intent* + config; each agent plugs in *how*.
- **Whether the need exists at all** → a `requires` / `agents` gate that cleanly skips (both layers need it).

Mapping the inventory: **#1–#4 are adapter plumbing** (events, settings shape, deny protocol, slot env);
**#5–#6 are recipe providers** (history, permissions) — their *mechanism*, not just a path, is
agent-shaped, so they must **not** sit on the adapter. (An earlier draft of this doc hung `historyDir()` /
`permissionsFile()` on the adapter — that's the leaky seam: it presumes "history is a symlinkable dir,"
true only for Claude.)

### The adapter — universal plumbing only

Consulted by the wiring (`applyRecipeWiring`) and the dispatcher (`runRecipeHooks` / `runRecipeFilters`):

```ts
interface AgentAdapter {
  readonly name: string;                       // "claude" | "cursor" | "gemini" | ...
  readonly capabilities: AgentCapability[];    // coarse: "pre-tool-hook" | "session-hooks" | "deny-protocol"
  /** Env var the agent sets to the slot dir (dispatcher falls back to cwd). */
  readonly projectDirEnv?: string;             // "CLAUDE_PROJECT_DIR"

  /** Map a normalized event to the agent's native event(s); null → unsupported. */
  nativeEvent(event: HookEvent): NativeEventSpec | null;
  /** Install / strip ONE dispatch entry per supported event in the agent's config. */
  installDispatch(slotPath: string, events: HookEvent[]): Promise<boolean>;
  stripDispatch(slotPath: string): Promise<boolean>;

  /** Filter protocol — only for agents whose capabilities include "pre-tool-hook". */
  encodeDeny?(reason: string): string;         // what an interceptor prints
  isDeny?(stdout: string): boolean;            // how the dispatcher reads it
}
```

Nothing recipe-specific lives here — no `historyDir`, no `permissionsFile`. The adapter knows how to wire a
normalized event and speak the agent's allow/deny protocol, full stop. `HOOK_EVENTS`, `writeSlotHooks`, the
deny-sniff in `runRecipeFilters`, and the `CLAUDE_PROJECT_DIR` reads collapse into a built-in
**`claudeAdapter`** that reproduces today's behavior *verbatim* — so step one is a pure refactor and the
existing tests (which pin the Claude shape) stay green.

### The recipe — intent + config + per-agent providers

The capability-specific mechanism lives in the recipe, keyed by agent:

```ts
interface Recipe<C> {
  name: string;                                // the capability, e.g. "shareHistory"
  requires: AgentCapability[];                 // what an agent must offer to support it
  providers: Record<string /* agent */, RecipeProvider<C>>;  // missing key = unsupported for that agent
}
```

`providers.claude` for shareHistory does today's `~/.claude/projects/<slug>` symlink; an agent with no
local history simply has no provider (→ clean skip), and one that stores history in a db gets a *different*
provider — not a path-getter pretending the operation is the same.

### Where today's three recipes land

- **`sandbox`** — **agnostic recipe + adapter.** The interceptor *code* is portable; only "register a
  pre-tool gate" and "spell deny" are per-agent, and those are adapter plumbing. `requires:
  ["pre-tool-hook"]`; an agent without it is skipped. The poster child for an agnostic recipe.
- **`syncPermissions`** — **single-agent provider.** Only meaningful for an agent with a local, file-based
  allowlist; the union-the-`permissions`-block mechanism is Claude-shaped. `providers: { claude }` until a
  comparable allowlist appears.
- **`shareHistory`** — **single-agent provider, maybe forever.** A pure function of how the agent stores
  history. `providers: { claude }`.

So "**agnostic or one-per-agent?**" is a false choice: a recipe is **agnostic in intent, per-agent in
mechanism**, and may have exactly one provider. That collapses to "fully agnostic" (sandbox — the per-agent
part is pure adapter data) or "Claude-only" (shareHistory — one provider) without changing the model.

### Hook events are a growing union, not a fixed trinity

`pre-tool-use` / `session-start` / `session-end` aren't canonical — they're *Claude's* three. Another agent
may expose events with no worm name (post-edit, subagent-spawn) or lack one of these. So:

- A recipe binds to a **normalized** event; the adapter maps it via `nativeEvent()` and advertises support
  through `capabilities`. "No `session-start` equivalent" → that event is unsupported → recipes needing it
  skip for that agent (the tier boundary).
- "You'd want different behavior per agent" is **native** to the provider model — what runs on a normalized
  event is the agent's provider, so it can legitimately differ or be empty. The event is only the trigger.
- The normalized vocabulary therefore **grows as agents are added** (a union over supported agents), rather
  than being frozen at three.

## Two tiers — be honest about the ceiling

Not every agent exposes a programmable pre-tool hook like Claude's `PreToolUse`. Support is therefore
**tiered**, and worm should say so out loud rather than appear to support a recipe it can't wire:

- **Tier 1 — hook-capable agents** (Claude Code today; any agent with pre-tool + session lifecycle hooks
  that can shell out to `worm hook trigger`): **full** recipe support — sandbox interception, permission
  sync, session start/stop.
- **Tier 0 — no-hook agents:** worm still delivers the **substrate** — warm pool, tunnels, the shared
  instructions file, and history sharing *if* the agent stores history somewhere known. But **no live
  pre-tool sandboxing**: there is no interception point to redirect a command before it runs.

Mechanically: a recipe declares a `requires: AgentCapability[]`, an adapter advertises `capabilities`, and
**enablement = config key present AND every enabled agent's adapter satisfies `requires`.** When it
doesn't, worm prints a clean skip (`sandbox needs a pre-tool hook; cursor exposes none — skipping for
cursor`) instead of silently wiring nothing. This is the same "no silent caps" discipline the rest of the
tool follows.

## The instructions file is already multi-agent (free win)

The highest-value portability — *one set of project instructions, every agent obeys it* — needs **no new
engine code**. Each agent reads a differently-named file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`.cursorrules`, …); point them all at one canonical source via `shared_paths` (or symlink each
agent-specific name to a single profile/store file). The emerging **`AGENTS.md`** convention is the
natural canonical target. Worth documenting as a first-class pattern, and possibly a tiny built-in recipe
that fans one instructions file out to each agent's expected filename.

## Multiple agents, one slot

Adapters aren't mutually exclusive — Claude **and** Cursor can target the same worktree, each wired into
its own config file. So config likely grows an explicit list:

```jsonc
// project config.json
{ "agents": ["claude", "cursor"] }   // default ["claude"]
```

Wiring then runs, for each enabled agent, every recipe that **has a provider for it** and whose `requires`
it satisfies — installing that agent's dispatch entries via its adapter. **Explicit over auto-detect:**
listing agents is reproducible and fits worm's git-tracked ethos better than sniffing what's installed on
the box (which differs per machine).

## Synergy with shareable recipe packages (recipes-roadmap §1/§2)

These two roadmap items are two halves of the same idea. Once a recipe is **data** (recipes-roadmap §2),
its *(event → command)* table is exactly what an adapter renders into a specific agent's settings shape:

> **recipe = agent-agnostic intent + config + per-agent providers;
> adapter = the universal wiring (events, settings shape, deny protocol) every agent needs.**

Build the **adapter seam first** — it's internal, low-risk, immediately lets a second agent reuse *every*
built-in recipe, and it's the precondition that makes third-party recipes (recipes-roadmap §1) portable
across agents by construction rather than Claude-only.

## Sequencing (by leverage ÷ risk)

1. **Extract `AgentAdapter`; ship `claudeAdapter` as a no-behavior-change refactor.** Move couplings #1–#4
   (the plumbing) behind it; leave #5–#6 as Claude providers on their recipes. Tests stay green (they
   already pin the Claude shape). Lowest risk, unblocks everything.
2. **Add `capabilities` / `requires` + clean skip messaging.** Makes the tier boundary explicit and
   honest before any second agent exists.
3. **Add a second built-in adapter** (whichever agent is used next) — the proof the seam is real.
4. **`agents: [...]` config + multi-agent wiring** — wire N agents into one slot.
5. **Instructions-file fan-out pattern / recipe** (`AGENTS.md` canonical) — the free portability win,
   documented and optionally automated.
6. **Layer recipe packages** (recipes-roadmap §1/§2) on top, so third-party recipes are agent-portable by
   construction.

## Open questions

- **Trust** (shared with recipes-roadmap §1). Third-party recipe code already runs in worm's dispatcher on
  the hot path; a second agent doesn't change that, but more adapters + shareable recipes widen the blast
  radius. The sandbox/trust model is still open.
- **Capability mechanisms may not port.** History (#5) and permission (#6) are recipe *providers*, not
  adapter data — for an agent that stores history in a db or has no allowlist, the right answer is "no
  provider for that agent" (a documented, logged skip), not a path-getter pretending the operation is the
  same.
- **Invokability.** Tier 0 agents can't call `worm hook trigger` at all — that *is* the tier boundary, so
  detection is "does the adapter expose a hook capability," nothing subtler.
