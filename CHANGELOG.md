# Changelog

All notable changes to `worm` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/tmalahie/wormhole/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tmalahie/wormhole/releases/tag/v0.2.0
