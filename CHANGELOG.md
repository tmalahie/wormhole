# Changelog

All notable changes to `worm` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
