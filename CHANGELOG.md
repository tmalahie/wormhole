# Changelog

All notable changes to `worm` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — breaking

- **Worktrees live in `<root>/.claude/worktrees/<name>`, and ports come from
  numbered slots.** The sibling pool (`<repo>-1`, `<repo>-2`, …, one folder per
  port namespace) is gone. Worktrees now sit where Claude Code and Claude
  Desktop put theirs, and a **slot** is a number a worktree borrows to run its
  stack: `worm slot assign` records it in the profile's `slots.json`, renders the
  `env` file with `index` = that number, and runs the new `on_assign` hook;
  `worm slot release` runs `on_release` and deletes the file. A worktree has no
  slot (and no env file) until one is assigned.
- **Commands:** `worm universe add|rm` → `worm worktree add|rm` (plus
  `worktree ls` / `worktree path`); new `worm slot ls|assign|release|current`.
  `worm switch` and `worm tp` are removed (plain `git switch` in a worktree is
  fine; `worm cd <name|branch|slot>` replaces `tp`). `worm path` resolves a
  worktree name, a branch or a slot number.
- **`env`**: `file` defaults to `.env.slot`; the text var `slot` is gone (use
  `name`, the worktree's name). Rendered only for a worktree that holds a slot.
- **Hook environment:** `WORM_SLOT` / `WORM_SLOT_INDEX` are the assigned slot
  number (empty when none — always empty in `on_create`); the worktree is
  `WORM_WORKTREE` / new `WORM_WORKTREE_NAME`.
- **`shareHistory`** no longer links project dirs — every wired worktree's
  `~/.claude/projects/<slug>` is linked to the main worktree's by worm itself.
  The recipe now only adds its cwd-switch reminder.

### Added

- **Claude Code's worktree hooks.** `worm sync --global` installs
  `WorktreeCreate` → `worm hook worktree-create` and `WorktreeRemove` →
  `worm hook worktree-remove` in `~/.claude/settings.json`, so `EnterWorktree`,
  `claude --worktree` and Claude Desktop create (and remove) worktrees through
  worm: same place, wired, set up. User settings because Claude Desktop only
  auto-trusts a hook-made worktree when the hook comes from that tier; in a repo
  that isn't a worm project the hooks do what Claude does without one.
- **`env` expressions** gain text values: `'quoted strings'`, `==` / `!=`,
  `cond ? a : b` and string `+`, plus the text vars `name`, `profile`, `root`,
  `worktree`.
- **Config keys** `baseBranch` (default base for new branches), `slots`
  (`{ step, max }`), and `processes` / `quickActions` / `features`, which worm
  validates and stores for tools that drive the worktrees (worm itself never
  runs processes).
- **`worm sync`** also writes `project.json` (`{ root }`) and a VS Code
  `<project>.code-workspace` in the profile (folders are never rewritten once
  it exists).
- **`notifyPendingInput`**: `"openOnClick": "claude-desktop"` opens the
  conversation itself in Claude Desktop (`claude://resume?session=<id>`).

- **Directory globs in `shared_paths`** — a tail ending in `/*` (e.g.
  `".claude/skills/*"`) links each **child** of that store directory
  individually instead of the directory itself, so the slot's parent dir stays a
  real, git-tracked directory that can also hold entries committed to the repo.
  New children are picked up by `worm sync` with no config change; removed ones
  are pruned. `*` is allowed only as the whole final segment (anything else
  raises a clean error), dot-prefixed children are skipped as a shell `*` would,
  and a missing profile container is sprouted as an empty dir. Works with named
  stores too. Motivating case: personal Claude skills sharing `.claude/skills/`
  with skills the team commits to the repo.

### Fixed

- **`notifyPendingInput` fires once per background-agent turn, not once per
  agent.** A `/review` turn yields every time an agent reports in, and the
  debounce that collapses those yields into a single notification was being
  defeated twice over. A background agent's hand-back arrives as an injected
  `type: "user"` record that looked exactly like a prompt the human typed, so it
  re-anchored the turn and pushed the launch records out of the scan window —
  the turn stopped counting as a background turn at the first hand-back. Turns
  are now classified from the transcript's own label for who submitted them
  (`turnOrigin` / `origin.kind`), with the old text match as a fallback for
  transcripts predating those fields. And agents nest: a grandchild hands back to
  the session that owns the tree, not to the agent that spawned it, so reports
  kept arriving — each one long, with nothing pending — after the synthesis had
  gone out. A report from an id this turn never launched is now never the answer.
  A hand-back also settles its agent (its trailing `<task-id>` notice lands a
  beat later, after the synthesis it triggers), and that notice, having no new
  content, never notifies on its own. Replayed against a real nested `/review`:
  10 notifications down to 1, on the final report.

- **`notifyPendingInput` names the worktree the turn is actually in.** A session
  resumed or moved to another slot keeps writing to the same transcript, and the
  notification was labelled (and its click focused) from the transcript's
  *opening* `cwd` — the worktree the work had left. It now reads the cwd of the
  newest user prompt taken at a **worktree root** (`.git` present, so a linked
  worktree counts). Newest picks up a mid-session move; the root test discards a
  cwd the shell wandered to, since every record — prompts included — carries the
  live cwd, so a `Bash cd` leaks into the next prompt and the notification would
  announce "src" and focus a new editor window rooted there. A session held
  entirely below a root (an editor opened on a subfolder) finds no rooted prompt
  and keeps its own cwd. The transcript is also parsed once now instead of once
  per lookup.

## [0.3.0] - 2026-08-19

A "settings sync" release. Both permission-sync recipes graduate from a one-key
union to a **recursive three-way merge over a configurable key set**, so
revocations propagate and two machines editing different keys both win — and
`autosync` stops mistaking a concurrent writer for a merge conflict.

### Added

- **`keys` on `syncGlobalPermissions`** — sync any set of top-level
  `~/.claude/settings.json` keys, not just `permissions`. Omit it for **auto
  mode** (`permissions` + `sandbox` + every top-level scalar, e.g. `effortLevel`,
  `tui`), name keys explicitly to add structured ones (`autoMode`, `env`,
  `hooks`, …), or set `"keys": "*"` for every key except a denylist — **`env`**
  (where an API key would live, and the canonical copy is committed and pushed)
  and **`trustedDirectories`** (a per-machine "I vetted this checkout" answer).
  Name one alongside the wildcard — `["*", "env"]` — to opt it back in.
- **`keys` on `syncPermissions`** (default `["permissions"]`) — the same control
  for a slot's `settings.local.json`, wildcard included.
- **The wildcard is expanded by the worker, not the wiring**, against the live
  files — so a key a future Claude Code version introduces starts syncing on its
  own, with no re-wire.
- **`hooks` may now be synced.** Only *your* entries travel: the
  `worm hook trigger …` entries are peeled off before the merge and re-attached
  afterwards, keeping `worm sync --global` the single writer of that block.
- **A shared merge engine** (`src/recipes/_lib/settings-merge.js`) behind both
  recipes: arrays merge as sets (a rule leaving either file propagates as a
  removal), objects merge **per key** (both sides' additions survive), and only a
  scalar edited on both sides falls back to last-edited-file-wins by mtime. With
  no base snapshot yet the merge degrades to a union, which never loses data.

### Changed

- **`syncPermissions` is a three-way merge, not a union.** It diffs against a
  **per-slot** base snapshot (`.sync-permissions.base.<slot>.json`), so a rule you
  **revoke** in one slot now propagates instead of being resurrected by the union
  on the next session.
- **`syncGlobalPermissions` auto mode reaches past `permissions`.** `sandbox` and
  every top-level scalar now sync too, where 0.2.0 touched `permissions` alone —
  so more of `~/.claude/settings.json` starts flowing to the git-tracked canonical
  copy after this upgrade. Pin `"keys": ["permissions"]` to keep the old, narrower
  behaviour. `sandbox` in particular is now bidirectional (last-edited-wins)
  rather than one-way.
- **`autosync` fetches *before* committing.** The slow network round-trip moves
  out of the commit→rebase window, leaving a concurrent writer almost no room to
  dirty the tree between the two.
- **`worm init` reconciles `~/.worm/.gitignore`** — missing machine-local entries
  are appended rather than written only when the file is absent, so re-running
  `init` heals an older install. Both merge base snapshots are gitignored.
- **`worm --version` reads `package.json` at runtime**, retiring the two-place
  version bump that the 0.2.0 cut needed.

### Fixed

- **`notifyPendingInput` fired on sub-agent turns.** Claude Code now emits a
  parenthetical metadata note between `Async agent launched successfully.` and
  `agentId:`, which the launch-marker regex no longer matched — so a
  background-agent turn looked finished and every intermediate `Stop` yield
  notified. Matched non-greedily now: one notification, on the final response.
- **`autosync` recorded false conflicts when a concurrent writer raced it.** A
  `syncGlobalPermissions` run or a permission-dialog write landing inside
  `~/.worm` mid-rebase makes `git rebase` bail non-zero with **no** real content
  conflict. The racing write is now re-absorbed and the rebase retried (up to
  three times); only a rebase that still fails with a clean tree — nothing new to
  commit — is treated as a genuine conflict and marked for the human.
- **The test suite no longer depends on the ambient environment for colour.**
  Sandboxed CLI runs pin `NO_COLOR`, so output assertions hold whether or not the
  parent process had a TTY, `FORCE_COLOR`, or `CI` set — the last of which broke
  one test in CI.

## [0.2.0] - 2026-06-21

A "flow rework" release: declarative **per-worktree environments**, a seam to use
worm's cognitive layer **without** its worktree topology (`wire` / `detach`), and
machine-wide **global recipes** — including keeping `~/.worm` synced across
machines.

### ⚠ Breaking changes

- **Removed the `worm config` command.** It only ever set a single scalar key
  (`editor`, also removed). Edit `~/.worm/config.json` as plain JSON instead —
  which is already how every other key (`shared_paths`, `stores`, `recipes`) is
  managed.
- **Removed the `editor` key from the global config.** The config schema is
  strict (unknown keys are rejected), so a `~/.worm/config.json` that still
  contains `editor` now fails to load with `Invalid config`. Delete the key. It
  was a vestigial, unused leftover.
- **Hook dispatch now invokes `worm` on your `PATH`**, not a baked-in absolute
  `node "<cli.js>"` path. This survives reinstalls, relocations, and node/nvm
  version switches.
  - **Migration:** existing wired slots keep working until you re-sync. After
    upgrading, run `worm sync` once per project and `worm sync --global` once
    machine-wide to rewrite the hook entries (the old entries are recognized and
    migrated automatically).
  - **Requirement:** `worm` must be on the `PATH` of the environment your agent
    launches in. GUI-launched editors (Finder/Dock) sometimes get a minimal
    `PATH` that excludes nvm/shell shims — ensure `worm` resolves there.

### Added

- **Per-worktree env files** — an optional `env` block in `config.json`
  (`{ file, vars }`). Unlike `shared_paths` (one source symlinked identically
  everywhere), worm writes a **different** dotenv file into each slot,
  git-excluded and regenerated on init/add/switch/sync. Values are integer
  **arithmetic expressions** over `index` (positional), `offset` / `hash` (stable
  per-branch), plus text `slot` / `branch` — e.g. `FRONT={{ 3000 + index * 10000 }}`,
  `PORT={{ 8080 + offset }}`.
- **`worm wire [path]`** — apply the cognitive layer (tunnels + the env file +
  recipe hooks) to a worktree worm **didn't** create (Conductor, worktrunk, plain
  `git worktree`). The seam for using worm without adopting its topology.
- **`worm detach <file>`** — sever one slot's shared-path tunnel into an
  independent local copy; reversible by deleting the file and re-running
  `worm sync`.
- **Global recipes** — declared in `~/.worm/config.json` and wired by
  `worm sync --global` into `~/.claude/settings.json`, firing for every Claude
  session machine-wide:
  - **`autosync`** — keeps the `~/.worm` meta-repo synced across machines (pull on
    session start, debounced push on `Stop`, flush on session end). Serialized by
    a machine-local lock; commits local work before rebasing; **never
    auto-resolves conflicts** (clean abort + a durable marker surfaced by
    `worm status` + an OS notification).
  - **`notifyPendingInput`** — an OS notification when Claude is waiting on you
    ("Response ready" / "Waiting for approval"). Optional `openOnClick` opens the
    project in a chosen editor; cross-platform backend.
  - **`syncGlobalPermissions`** — version-controls the `permissions` block of
    `~/.claude/settings.json` against a git-tracked canonical copy.
- **`WORM_PROFILE` hook env var** — the durable profile dir
  (`~/.worm/projects/<name>/`, honouring `WORM_HOME`), for hooks that reach into
  profile-owned shared state.
- **`worm template render <file> KEY=VALUE …`** documented as worm's templating
  primitive for setup scripts (drop hand-rolled `sed`).

### Changed

- `worm sync --global` now also installs/strips global-scope recipe hooks (in
  addition to reconciling HOME-scope `shared_paths` links).
- Hook dispatch entries are now `worm hook trigger [--global] <event>` (see
  breaking changes above).

[Unreleased]: https://github.com/tmalahie/wormhole/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tmalahie/wormhole/releases/tag/v0.3.0
[0.2.0]: https://github.com/tmalahie/wormhole/releases/tag/v0.2.0
