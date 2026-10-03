# wormhole

> A hub for your coding agents — one git-tracked home for their config and instructions, the tooling to maintain it, and worktrees with their own ports to run several at once.

A coding agent is only as good as its setup: the right instructions and skills, an allowlist of commands it may run unattended, a sandbox around the ones you don't fully trust, and room to work without colliding with the next agent. That setup is usually ad-hoc, trapped on one machine, and untracked — and it falls apart the moment you run more than one agent on a project.

`worm` turns it into a managed, version-controlled layer with three parts:

- **A meta-repo for your agents — `~/.worm`.** A single git repository holds the config and instructions for every project's agents: `CLAUDE.md`, skills, slash commands, settings, the permission allowlist, the sandbox policy. Because it's just git, your agent setup is reviewable, shareable, and portable — re-clone a machine and your agents come back configured.
- **Tooling to maintain that config — recipes.** Composable capabilities you switch on per project: a Docker **sandbox** that keeps filesystem-mutating commands off the host, **permission sync** so approving a command in one worktree teaches every agent, **shared history** across worktrees. `worm sync` reconciles everything declaratively; templates seed new projects.
- **Tooling to run agents in parallel — worktrees and slots.** Every branch in progress gets a `git worktree` under `<repo>/.claude/worktrees/<name>` — the same place Claude Code and Claude Desktop put theirs, and worm is the hook they call to create one, so every worktree comes out set up and wired with the same shared config via tunnels (this is where `wormhole` gets its name from). To *run* something, a worktree borrows a **slot**: a number that becomes its ports (`3000 + 100 × slot`, …) through a generated env file, and goes back to the pool when you're done.

The worktrees used to be the whole story; now they're the backend. The product is the cognitive layer they serve — the git-tracked home that keeps your agents consistent, contained, and reproducible across every worktree.

> Built around **Claude Code** today (the recipes wire Claude's hooks and settings) on a deliberately agent-agnostic core — worktrees, slots, tunnels, and lifecycle hooks don't care which agent you run. Opening the recipe set and wiring other agents are the next iterations — see [Roadmap](#roadmap).

## Video - Overview & Demo

_(in French, English version incoming!)_

<p>
  <a href="https://youtu.be/0i4cv8mDx18">
    <img src="https://github.com/user-attachments/assets/1fd2e1f7-8fc8-4a80-951c-95c536c36d32" alt="Watch the video" width="600">
  </a>
</p>

---

## Install

```bash
npm install -g worm-cli    # exposes the `worm` binary
```

Requires Node ≥ 20 and git ≥ 2.31.

<details>
<summary>From source</summary>

```bash
pnpm install
pnpm build
pnpm link --global    # exposes the `worm` binary
```

</details>

### Shell integration (recommended)

Add this to your `~/.zshrc` (or `~/.bashrc`):

```bash
eval "$(worm shell-init)"
eval "$(worm completion zsh)"    # or `bash`
```

- `worm shell-init` installs a `worm()` wrapper so `worm cd <worktree>` actually changes your shell's working directory.
- `worm completion <shell>` registers tab completion: subcommand names (`worm sta<tab>` → `worm status`) and worktree/branch completion for `cd` / `path`.

## Quick start

```bash
# Clone a repo and bind it (a normal clone — no bare container).
worm clone https://github.com/you/mkpc.git ~/git/mkpc
cd ~/git/mkpc

# A worktree per branch in progress, under .claude/worktrees/ (runs setup.sh).
worm worktree add feat/my-feature        # → ~/git/mkpc/.claude/worktrees/my-feature
worm cd my-feature

# Give it ports when you want to run it: the lowest free slot, or a number.
worm slot assign                          # renders .env.slot (slot 0 → 3000, slot 1 → 3100, …)
worm slot ls

# See every worktree and its slot.
worm status

# Done? Release the slot and remove the worktree (the branch stays).
worm worktree rm my-feature
```

Claude Code does the same for you: after `worm sync --global`, `EnterWorktree`, `claude --worktree` and Claude Desktop's worktree option all go through worm (`worm hook worktree-create`, installed in `~/.claude/settings.json`), so their worktrees land in the same place, set up and wired. In a repo worm doesn't manage, the hook does what Claude does on its own.

`worm sync` reconciles your shared-file tunnels, env files and hooks across every worktree (run it after editing the config). `worm sync --global` does the HOME-scope equivalent **and** installs any global recipes (`autosync`) from `~/.worm/config.json` into `~/.claude/settings.json`. Drop your install commands into [.worm/scripts/setup.sh](#configuration) — it runs when a worktree is created.

## Commands

| Command | What it does |
|---|---|
| `worm clone <url> [path] [--name X] [--template <dir>] [--skip-hook]` | Recommended entry point. Normal-clones `<url>`, binds it, and sets up the main worktree via `on_create`. |
| `worm init [--name X] [--template <dir>] [--skip-hook]` | Bind the current git clone (its main worktree) and set it up via `on_create`. Lazily creates `~/.worm/` on first use. Idempotent. |
| `worm status [--json]` | List every worktree (main first) with its branch and slot. |
| `worm worktree add <branch> [--name <dir>] [--base <ref>] [--no-setup] [--json]` | Create `<root>/.claude/worktrees/<name>` (name = the branch's last segment, `-2`, `-3` on a clash) on `<branch>` — checked out if it exists locally or on a remote, else created from `--base` (default `origin/<baseBranch>`, not tracking it). Wires it (tunnels, Claude project dir, hooks) and runs `on_create`. Refuses a branch already checked out elsewhere. Prints the path. |
| `worm worktree rm <ref> [--force] [--delete-branch] [--skip-hook]` | Remove a worktree (name, branch, path or slot number): releases its slot (`on_release`), runs `on_remove`, strips worm's links, removes the worktree and its Claude project-dir link. Refuses the main worktree, and uncommitted changes unless `--force`. Keeps the branch unless `--delete-branch` (which still refuses an unmerged one). |
| `worm worktree ls [--json]` / `worm worktree path <ref>` | List worktrees with branch, uncommitted changes and slot / print one's path. |
| `worm slot ls [--json]` | Which worktree holds each slot, and which are free. |
| `worm slot assign [<worktree>] [<N>]` | Give a worktree (default: the current one) a slot (default: the lowest free). Records it in the profile's `slots.json`, renders the `env` file, runs `on_assign`. Idempotent. |
| `worm slot release [<worktree>\|<N>]` | Run `on_release`, delete the env file, free the slot. |
| `worm slot current` | Print the current worktree's slot; exit 1 when it holds none. |
| `worm sync` | Declaratively reconcile every worktree: create missing tunnels, prune removed ones, render/remove env files, rewire hooks, clone any missing store; write `project.json` and the VS Code workspace. Idempotent. |
| `worm wire [path]` | Apply the cognitive layer to one worktree (default: cwd) — for a worktree created by something else (plain `git worktree add`, Conductor, …), or to repair one. Idempotent. |
| `worm detach <file>` | Sever a shared-path tunnel in the **current worktree only** — replace the symlink with an independent local copy. The other worktrees keep the link; `worm sync` won't restore it. Reverse it by deleting the local file and re-running `worm sync`. |
| `worm sync --global` | Reconcile **HOME-scope** links from `~/.worm/config.json`'s `shared_paths` (e.g. `~/.claude/commands` → `~/.worm/shared/.claude/commands`), **and** install/strip global recipes (`autosync`) plus Claude's worktree hooks into `~/.claude/settings.json` — machine-wide setup, independent of any project. (User settings on purpose: Claude Desktop auto-trusts a hook-made worktree only when the hook comes from that tier.) |
| `worm template render <file> [KEY=VALUE …]` | Render a `{{var}}` template file to stdout (worm's templating primitive; leaves shell `${VAR}` untouched). For setup scripts that want to drop hand-rolled sed. |
| `worm cd <ref>` / `worm path <ref>` | Change directory into / print the path of a worktree by name, branch or slot number. `cd` requires the shell-init wrapper. |
| `worm hook worktree-create` / `worktree-remove` | Claude Code's `WorktreeCreate` / `WorktreeRemove` hooks, installed in `~/.claude/settings.json` by `worm sync --global`: JSON on stdin; create prints only the worktree path on stdout. In a repo that isn't a worm project they behave like Claude's built-in (`.claude/worktrees/<name>`, branch `worktree-<name>`, nothing wired). |
| `worm destroy [--force]` | Unbind the project: remove linked worktrees, `.worm/`, and the global profile. **The main worktree (your repo) is left intact.** Prompts unless `--force`. |
| `worm shell-init` | Print the shell function described in [Shell integration](#shell-integration-recommended). |
| `worm completion <bash\|zsh>` | Print a tab-completion script for the chosen shell. |

Run `worm <command> --help` for the full option list. Project-scoped commands resolve the main worktree via git (`--git-common-dir`), so they work from any worktree or subdirectory.

## How it works

For a project named `mkpc` with two worktrees, one of them holding slot 1:

```
~/git/mkpc/                            ← the main worktree (a normal clone, stays on baseBranch)
├── .git/                              ← the common git dir for every worktree
├── .worm/                             ← thin wiring: (almost) all pointers (git-excluded locally)
│   ├── .gitignore                     ← single line: `*`
│   ├── config.json                    → ~/.worm/projects/mkpc/config.json
│   ├── scripts/                       → ~/.worm/projects/mkpc/scripts/   (setup.sh lives here)
│   ├── recipes/                       → ~/.worm/projects/mkpc/recipes/   (materialized artifacts)
│   └── logs/                          → ~/.worm/projects/mkpc/logs/      (recipe-hook logs)
├── .env                               → ~/.worm/projects/mkpc/.env       (a tunnel)
└── .claude/worktrees/                 ← git-excluded
    ├── my-feature/                    ← `worm worktree add feat/my-feature`
    │   ├── .env                       → ~/.worm/projects/mkpc/.env
    │   ├── .env.slot                  ← rendered for slot 1 (absent without a slot)
    │   └── .worktree-keep             ← tells Claude Desktop's worktree GC to leave it alone
    └── brave-otter-1a2b/              ← created by Claude (`EnterWorktree`) through worm's hook

~/.worm/                               ← your agents' meta-repo (a git repo)
└── projects/mkpc/                     ← mkpc's PROFILE — the durable state, survives a reclone
    ├── config.json  .env  scripts/  recipes/  logs/
    ├── slots.json                     ← which worktree holds which slot
    ├── project.json                   ← { "root": "~/git/mkpc" }
    ├── mkpc.code-workspace            ← VS Code workspace (written once by `worm sync`)
    └── .managed-links.json            ← manifest of the symlinks worm created per worktree
```

Worktrees are **long-lived** — they stay set up (your `node_modules`, build state, etc. persist in each one) until you remove them. `.claude/worktrees/` and `.worm/` are hidden from git locally. A project's `.worm/` is almost entirely **symlinks into its profile** (`~/.worm/projects/<project>/`), where the durable state lives; each worktree's shared files link **straight at the profile** (absolute, one hop), recorded in the profile's manifest so `worm sync` can add/prune them safely. Every worktree's Claude project dir (`~/.claude/projects/<slug>`) is a symlink to the main worktree's, so a repo has one conversation history and one auto-memory however many worktrees it has.

## Configuration

Each project gets a config at `~/.worm/projects/<project-name>/config.json`. The built-in default is intentionally minimal — projects start with no shared files, so worm doesn't presume your stack:

```json
{
  "baseBranch": "main",
  "shared_paths": [],
  "stores": {},
  "hooks": {
    "on_create": "bash \"$WORM_PROJECT_ROOT/.worm/scripts/setup.sh\""
  },
  "slots": { "step": 100, "max": 9 },
  "recipes": {}
}
```

Edit the file (or pre-seed a `--template <dir>`) to add what your project needs.

> 💡 **A complete real-world example:** [`worm-mkpc`](https://github.com/tmalahie/worm-mkpc) is the full profile behind the [demo video](#video---overview--demo) — `config.json`, `setup.sh`, a per-worktree `env` block, the recipe set, and the docker/`CLAUDE.local.md` templates for a real project. A good setup to crib from.

- **`baseBranch`** — the branch the main worktree stays on, and the default start point (`origin/<baseBranch>`) for a new branch created by `worm worktree add` or Claude's hook.
- **`shared_paths`** — files tunnelled into every worktree. Each entry is either a bare path, pulled from the project **profile** (`~/.worm/projects/<project>/<path>`, sprouting an empty placeholder if absent), or `{ "path": ".claude/docs", "store": "team" }` to pull it from a named **store** instead. Each worktree gets an absolute symlink straight at the source. Common entries: `.env`, `CLAUDE.local.md`, `.mcp.json`. A tail ending in **`/*`** is a *directory glob*: `".claude/skills/*"` links each child of `~/.worm/projects/<project>/.claude/skills/` individually, so the worktree's `.claude/skills/` stays a **real, git-tracked directory** that can also hold entries committed to the repo. Add a skill to the profile and `worm sync` picks it up — no config change; delete one and it's pruned. `*` is only allowed as the whole final segment, dot-prefixed children are skipped (as a shell `*` would), and an entry that's already a real file in a worktree is left alone rather than clobbered. Run `worm sync` after changing this list.
- **`stores`** — named external sources for `shared_paths`, e.g. `{ "team": { "root": "~/git/team-shared", "url": "git@github.com:org/team-shared" } }`. A `shared_paths` entry with `"store": "team"` links from that store's `root` instead of the profile — so team docs/commands can live in a **separate git repo**, shared with your team and editable in place (your edits land as changes in that repo). If `root` is missing and a `url` is given, `worm sync` clones it on demand. Declare stores per project here, or machine-wide in `~/.worm/config.json` (project stores win on a name clash).
- **`slots`** — `{ "step": 100, "max": 9 }`. Slots are numbered runtime environments `0…max`; `step` is the port distance between two slots, for tools that compute ports. Which worktree holds which slot lives in the profile's `slots.json`.
- **`env`** — the env file a worktree gets while it holds a slot (off unless present). Unlike `shared_paths` (one source symlinked identically everywhere), `env` writes a **different** file into each worktree, rendered on `worm slot assign` and on `sync`, deleted on release. Shape: `{ "file": ".env.slot", "vars": { "PORT": "{{ 3000 + index * 100 }}" } }`. `file` (default `.env.slot`) is gitignored automatically. Each value may contain `{{ … }}` expressions over:
  - **`index`** — the slot number. `{{ 3000 + index * 100 }}` → `3000`, `3100`, `3200`.
  - **`offset`** / **`hash`** — derived from a **stable hash of the branch** (`offset` ∈ 0–999), for values that should follow the branch rather than the slot.
  - the text vars **`name`** (the worktree's name, `main` for the main one), **`branch`**, **`profile`** (the profile dir), **`root`** (the main worktree) and **`worktree`** (this worktree's path).

  Operators: `+ - * / %` and parentheses on numbers, `+` concatenates when either side is text, `==` / `!=`, and `cond ? a : b`; strings are `'quoted'`. E.g. `"REDIS_PREFIX": "{{ index == 0 ? 'app' : 'app-slot' + index }}"`. A typo or a type error fails loudly rather than reaching the file. The file may not also appear in `shared_paths` (worm refuses the clash). For advanced cases (a real config file with holes) use `worm template render` in an `on_assign` hook.
- **`hooks`** — shell commands run inside a worktree at four moments. `on_create`: the worktree was just created (`worktree add`, Claude's hook, or `init`/`clone` for the main one) — install dependencies here; no slot exists yet. `on_assign`: a slot was assigned and the env file rendered — port-dependent setup goes here. `on_release`: the slot is about to be released (the env file is still there). `on_remove`: the worktree is about to be removed. The default `on_create` invokes `.worm/scripts/setup.sh` — drop your install commands there (`npm install`, `pip install -r requirements.txt`, …) instead of editing the JSON. A non-zero `on_create`/`on_assign`/`on_release` warns but doesn't abort; a non-zero `on_remove` aborts the removal unless `--force`. `--skip-hook` (`--no-setup` for `worktree add`) skips them.
- **`processes`**, **`quickActions`**, **`features`** — validated and stored for tools that drive the worktrees (a dashboard starting each worktree's processes on its slot's ports, one-click actions); worm itself never runs them.
- **`recipes`** — composable capabilities, keyed by name (provider-style). A recipe is **enabled iff its key is present**; each value is validated by that recipe's own schema. Two kinds of thing back a recipe, kept deliberately separate:
  - **Worm-owned code ships with the binary** — config-independent scripts (the sandbox interceptor, the permission-sync script) parameterized at run time, so they live **once** and a fix propagates by upgrading `worm`, with nothing to re-materialize per project.
  - **Genuinely per-project artifacts** (the sandbox `Dockerfile` / `compose.yml` / policy) are **materialized** under `.worm/recipes/<name>/` (→ the profile), **non-clobbering** — edit a generated file and it's kept. To pull a scaffold update, delete it (e.g. `rm .worm/recipes/sandbox/Dockerfile`) and re-run `worm sync`. (A planned regenerate/upgrade command is the last roadmap item — see [docs/recipes-roadmap.md](docs/recipes-roadmap.md).)

  Hooks are **inverted**: each worktree's `.claude/settings.local.json` (gitignored, per-worktree) holds **one static entry per event** — `worm hook trigger <event>` — installed once. At tool/session time that dispatcher resolves the live worktree, runs each enabled recipe's command for the event, injects env, and owns logging. So **enabling, disabling, or updating a recipe is a pure `config.json` edit** — settings never churn, and recipes compose without clobbering each other or your own hooks. Recipe-hook logs land in **`.worm/logs/`** (→ the profile): `<container>.log` for the container's `up`/`down` output, `<container>-redirect.log` for the sandbox's allow/deny decisions, `sync-permissions.log` for permission sync. `tail -f` them to see what fired.

  Built-in recipes (enable by adding the key, e.g. `"recipes": { "sandbox": {}, "syncPermissions": {} }`). Most are **project-scoped** (per-project config, wired per-worktree); **`autosync`**, **`notifyPendingInput`** and **`syncGlobalPermissions`** are **global** — declare them in `~/.worm/config.json` and run `worm sync --global` (they wire into `~/.claude/settings.json` and fire for every Claude session, any project):
  - **`sandbox`** — `{ "backend": "docker", "image": "node:22-bookworm", "tools": [], "neverSandbox": [...], "exemptDirs": [], "autostart": true, "autostop": false }`. Materializes a Dockerfile (from `image` + `tools`), a compose file, and a sandbox policy (the interceptor itself ships with worm), then wires each worktree so its container auto-starts (`autostart`) and filesystem-mutating commands are redirected into it (mounted at the same path via `$SANDBOX_DIR`). See [docs/strategy-3-spec.md](docs/strategy-3-spec.md) §6.
  - **`syncPermissions`** (`{ "keys": ["permissions"] }`) — wires `SessionStart`/`SessionEnd` hooks that keep the `permissions` block of each worktree's `settings.local.json` in step with a canonical store shared across worktrees (approve a command once, every worktree learns it). A **three-way merge** against a per-worktree base snapshot, so a rule you **revoke** in one worktree propagates instead of being resurrected by the union on the next session. Set `keys` to sync more top-level keys (`"*"` for all of them, minus the same denylist as `syncGlobalPermissions`); naming `hooks` syncs your own hook entries only (worm's own entries stay per-worktree). Merge-preserving — it never touches other recipes' hooks or keys.
  - **`shareHistory`** (`{}`) — a `UserPromptSubmit` reminder telling the model when the conversation's working directory changed since the previous prompt (an old conversation resumed from another worktree). Sharing the history itself is core worm behaviour: every worktree's Claude project dir links to the main worktree's.
  - **`shareMemory`** (`{}`) — symlinks the repo's Claude memory dir (`~/.claude/projects/<slug>/memory`) at one canonical store in the profile (`~/.worm/projects/<name>/.claude/memory`), so it's **durable across a reclone** of the main worktree. On first run it seeds the store from an existing memory dir, and refuses to clobber a real one once the store exists (warns instead).
  - **`autosync`** (`{ "remote": "origin", "debounceMinutes": 5, "notify": true }`) — the one **global-scope** recipe: declare it in the **global** `~/.worm/config.json` (`"recipes": { "autosync": {} }`) and run **`worm sync --global`** to wire it into `~/.claude/settings.json`, so it fires for **every** Claude session machine-wide (any project, even non-worm dirs) — not per-worktree. It keeps the `~/.worm` meta-repo synced across machines without manual push/pull on every node: **pull** (`fetch` + `rebase`) on `SessionStart`, **push** (auto-commit + push, debounced) on every turn's `Stop` — the reliable trigger for a session that's never closed — plus a best-effort flush on `SessionEnd`. Runs are **serialized** by a machine-local lock (many open windows all firing `SessionStart`/`Stop` won't run git on `~/.worm` concurrently — a busy run just skips; the lock carries an owner token so a stale-steal can't hand it to two racers). Each sync **commits local work *before* rebasing onto the remote** — a committed change survives a conflict abort (back on `HEAD`), whereas an autostash pop-conflict would strand it invisibly. **Conflicts are never auto-resolved**: a clean `git rebase --abort`, a durable marker that **`worm status`** surfaces, and an OS notification (`notify: false` to silence). Requires a git remote on `~/.worm` (else it no-ops). Machine-local state (`.managed-links.json`, logs, the conflict marker) is gitignored so it never syncs. Remove it from the config + re-run `worm sync --global` to uninstall.
  - **`notifyPendingInput`** (`{ "openOnClick": "" }`, **global**) — fires an OS notification when Claude is waiting on you (your input is pending): *"Response ready"* on `Stop`, *"Waiting for approval"* on `PermissionRequest`. On macOS it uses `terminal-notifier` and falls back to `osascript`; on Linux, `notify-send`. Set `openOnClick` to `"claude-desktop"` to make clicking the notification open the conversation itself in Claude Desktop (`claude://resume?session=<id>` — it imports a CLI-born session or focuses a Desktop one), or to any `open -a` app name (`"Visual Studio Code"`, `"Cursor"`, …) to open the worktree folder there; **default `""` = no click action** (no editor is presumed). Debounces the burst of intermediate `Stop` yields a background-agent turn produces (one notification on the final answer) and ignores sub-agent events. Shares the notification backend (`src/recipes/_lib/notify.js`) with `autosync`.
  - **`syncGlobalPermissions`** (`{ "keys": [...] }`, **global**) — the machine-wide analogue of `syncPermissions`: keeps a configurable set of top-level `~/.claude/settings.json` keys in step with a git-tracked canonical copy in `~/.worm/shared/.claude/settings.json`, so your global settings are version-controlled (and synced across machines once `autosync` pushes them). Omit `keys` for **auto mode** — `permissions` + `sandbox` + every top-level scalar (`effortLevel`, `tui`, …). Name keys explicitly to add structured ones (`autoMode`, `env`, `hooks`, …), or set `"keys": "*"` to sync **every** top-level key except a denylist: **`env`** (where an API key would live, and the canonical copy is committed and pushed) and **`trustedDirectories`** (a per-machine "I vetted this checkout" answer). Name one alongside the wildcard — `["*", "env"]` — to opt it back in. The wildcard also means keys added by future Claude Code versions start syncing on their own; that's the trade. Everything outside the configured set is left untouched in the live file, and the canonical copy holds only that set. Conflicts resolve by **recursive three-way merge** against a machine-local base snapshot: arrays merge as sets (a rule removed on either side propagates), objects merge **per key** (two machines adding different keys both win), and only a scalar edited on both sides falls back to last-edited-file-wins. Naming `hooks` syncs **your own** hook entries only — the `worm hook trigger …` entries are worm's, re-wired per machine by `worm sync --global`, and never reach the canonical copy.

### Hook environment

Hook commands (and any script they invoke, like `setup.sh`) receive:

| Variable | Value |
|---|---|
| `WORM_PROJECT_ROOT` | Absolute path to the main worktree. |
| `WORM_WORKTREE` | This worktree's path (equals `WORM_PROJECT_ROOT` for the main one). |
| `WORM_WORKTREE_NAME` | Its name: `main`, or the directory name under `.claude/worktrees/`. |
| `WORM_SLOT` / `WORM_SLOT_INDEX` | The slot it holds (same number twice; the second name is for older scripts), or empty — always empty in `on_create`. `PORT=$((3000 + WORM_SLOT * 100))` in an `on_assign` hook. |
| `WORM_BRANCH` | Branch name. |
| `WORM_PROFILE` | The project's profile dir (`~/.worm/projects/<name>`). |
| `WORM_BRANCH_HASH` | Stable 32-bit hash of the branch — same value across machines. |
| `WORM_PORT_OFFSET` | Stable per-branch offset in 0–999 (same basis as the `env` block's `{{ offset }}`). |

### Templates

On first run, `~/.worm/templates/default/` is seeded with a `config.json` and `scripts/setup.sh`. New projects are bootstrapped from that template — edits to it apply to projects created afterwards (existing projects are untouched). Pass `--template <dir>` to bootstrap from a custom directory; it must contain a `config.json`, with an optional `scripts/` subdirectory.

## Environment

| Variable | Effect |
|---|---|
| `WORM_HOME` | Override the global root (default: `~/.worm`). Useful for sandboxes, CI, or multiple worm "homes". |
| `WORM_DEBUG` | Set to `1` to print stack traces on error. |

## Roadmap

worm's substrate is already agent-agnostic — worktrees and slots, shared-file tunnels, lifecycle hooks, and your instructions file (`CLAUDE.md` / `AGENTS.md` / …) don't care which agent you run. The **recipe engine** is the part still wired specifically to Claude Code. The next two iterations open both up:

- **Shareable recipe packages** — author a recipe in its own folder (`~/.worm/recipes/<name>/`) or a git repo and drop it in, instead of forking wormhole. A recipe becomes a directory of data + real script files, loaded alongside the built-ins, with its config validated from a manifest. Details: [docs/recipes-roadmap.md](docs/recipes-roadmap.md) §1–§2 and the "Next up" plan.
- **Agents beyond Claude** — an agent-adapter seam so recipes can wire Cursor, Gemini, Codex, … not just Claude Code. Agents with a pre-tool/session hook system get **full** recipe support (sandbox, permission sync); agents without one still get worktrees, slots, tunnels, and shared instructions. Details: [docs/multi-agent-roadmap.md](docs/multi-agent-roadmap.md).

The two halves fit together: a recipe-as-data format is what an agent adapter renders per agent. Earlier iterations — live-once recipe code, the inverted hook dispatcher, named stores, home-scope `worm sync --global`, and `worm template render` — are already shipped (the roadmap docs carry the full history). The one deferred item is a Terraform-style `plan`/`apply` for regenerating scaffolding you've edited.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the release history and any **breaking
changes** (the current release, **0.2.0**, has a few — notably the removal of the
`worm config` command and a hook-dispatch migration). `worm` follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test           # runs node:test against the built CLI
pnpm demo           # visual walkthrough in an isolated sandbox
```

See [src/README.md](src/README.md) for architecture and [CLAUDE.md](CLAUDE.md) for agent contributor guidelines.
