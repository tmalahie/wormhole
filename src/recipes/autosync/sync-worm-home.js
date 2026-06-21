#!/usr/bin/env node
// The autosync recipe's worker, shipped WITH worm. Invoked by the GLOBAL hook
// dispatch (`worm hook trigger --global <session-start|stop|session-end>`, wired
// into ~/.claude/settings.json by `worm sync --global`). Keeps the ~/.worm
// meta-repo synced across machines — pull on session start, push (debounced) on
// each turn's Stop, flush on session end.
//
// Config-independent worm-owned code: ONE copy lives in dist/recipes/, never
// materialized per project. It always acts on ~/.worm (WORM_HOME or the default),
// regardless of which session triggered it.
//
// Usage:  node sync-worm-home.js <remote> <debounceMinutes> <notify 0|1> <pull|push>
//
// Runs are SERIALIZED by a machine-local lock: many VS Code windows firing
// SessionStart/Stop at once must not run git on ~/.worm concurrently (that races
// on .git/index.lock and self-inflicts divergence). A held lock → skip this run.
// On push it integrates (fetch + rebase) BEFORE committing, so serialized sessions
// build on the latest state instead of diverging.
//
// Conflicts are NEVER auto-resolved: a clean `git rebase --abort` restores the
// repo, then a durable marker (.autosync-conflict.json, surfaced by `worm
// status`) plus an OS notification tell the human. The next clean sync clears it.
// Always exits 0 — a sync hiccup must never block a session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { notify as osNotify } from "../_lib/notify.js";

const remote = process.argv[2] || "origin";
const debounceMin = Number(process.argv[3] || "0");
const notify = process.argv[4] === "1";
const mode = process.argv[5]; // "pull" | "push"

const home =
  process.env.WORM_HOME && process.env.WORM_HOME.trim()
    ? path.resolve(process.env.WORM_HOME)
    : path.join(os.homedir(), ".worm");

// Kept in sync with src/core/paths.ts (AUTOSYNC_CONFLICT_FILE_NAME).
const CONFLICT_FILE = path.join(home, ".autosync-conflict.json");
const STAMP_FILE = path.join(home, ".autosync-last-push");

// Cross-process lock so concurrent sessions (many VS Code windows all firing
// SessionStart/Stop at once) never run git on ~/.worm in parallel — that races on
// .git/index.lock and produces half-applied rebases / spurious divergence. Lives
// in the OS temp dir (machine-local, never touched by `git add -A`), keyed by the
// worm home so a custom WORM_HOME (tests) gets its own lock. Held only for the
// duration of one run; stale locks (a crashed process) are stolen after a grace.
const LOCK_DIR = path.join(os.tmpdir(), `worm-autosync-${home.replace(/[^a-zA-Z0-9]/g, "_")}.lock`);
const LOCK_STALE_MS = 120000;

function git(args) {
  return spawnSync("git", ["-C", home, ...args], { encoding: "utf8" });
}

function isRepo() {
  return fs.existsSync(path.join(home, ".git"));
}

function currentBranch() {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function clearConflict() {
  try {
    fs.unlinkSync(CONFLICT_FILE);
  } catch {
    // not present — fine
  }
}

function recordConflict(detail) {
  try {
    fs.writeFileSync(
      CONFLICT_FILE,
      JSON.stringify(
        { at: new Date().toISOString(), machine: os.hostname(), mode, remote, detail },
        null,
        2
      ) + "\n"
    );
  } catch {
    // best effort
  }
  console.error(`autosync: CONFLICT — ${detail}. ~/.worm left clean; resolve by hand.`);
  if (notify) osNotify({ title: "worm autosync conflict", message: `${detail}. Run: cd ${home} && git status` });
}

/**
 * Integrate the remote branch by rebasing onto it (autostash for any local edits).
 * Returns true when in sync (or there's nothing remote to integrate yet); false
 * when it hit a conflict — in which case it has already aborted cleanly and
 * recorded the marker.
 */
function integrate(branch) {
  git(["fetch", remote, branch]);
  const ref = `${remote}/${branch}`;
  if (git(["rev-parse", "--verify", "--quiet", ref]).status !== 0) {
    return true; // remote branch doesn't exist yet — nothing to integrate
  }
  if (git(["rebase", "--autostash", ref]).status === 0) return true;
  git(["rebase", "--abort"]);
  recordConflict(`rebase onto ${ref} hit conflicts`);
  return false;
}

function debounced() {
  if (!debounceMin) return false;
  try {
    const ageMin = (Date.now() - fs.statSync(STAMP_FILE).mtimeMs) / 60000;
    return ageMin < debounceMin;
  } catch {
    return false;
  }
}

function stamp() {
  try {
    fs.writeFileSync(STAMP_FILE, "");
  } catch {
    // best effort
  }
}

// mkdir is atomic across processes: it succeeds for exactly one racer. If the
// lock is held we SKIP this run (another session is syncing — the shared ~/.worm
// will be up to date either way; the next Stop re-syncs). A stale lock left by a
// crashed run is stolen after LOCK_STALE_MS.
function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          fs.mkdirSync(LOCK_DIR);
          return true;
        }
      } catch {
        // lost the steal race — treat as held
      }
    }
    return false;
  }
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function commitIfDirty() {
  git(["add", "-A"]);
  // `diff --cached --quiet` exits 1 when there ARE staged changes.
  if (git(["diff", "--cached", "--quiet"]).status === 0) return;
  git(["commit", "--quiet", "-m", `worm autosync ${new Date().toISOString()} on ${os.hostname()}`]);
}

function sync(branch) {
  if (mode === "pull") {
    if (integrate(branch)) clearConflict();
    return;
  }

  // push. Debounce first (cheap), then INTEGRATE BEFORE COMMITTING so we always
  // build on the latest remote state — serialized sessions linearize instead of
  // each committing a divergent snapshot of the same churning files.
  if (debounced()) return;
  if (!integrate(branch)) return; // conflict: marker written, repo restored
  commitIfDirty();
  if (git(["push", remote, branch]).status === 0) {
    clearConflict();
    stamp();
    return;
  }
  // Push still rejected → another MACHINE pushed since our fetch (the local lock
  // can't serialize across hosts). Integrate again and retry once.
  if (!integrate(branch)) return;
  if (git(["push", remote, branch]).status === 0) {
    clearConflict();
    stamp();
  }
}

function main() {
  if (!mode || !isRepo()) return;
  if (git(["remote", "get-url", remote]).status !== 0) {
    console.log(`autosync: no remote "${remote}" on ${home}; skipping.`);
    return;
  }
  const branch = currentBranch();
  if (!branch) {
    console.log("autosync: detached HEAD; skipping.");
    return;
  }

  // Serialize against other sessions; skip this run if one is already syncing.
  if (!acquireLock()) {
    console.log("autosync: another sync is in progress; skipping.");
    return;
  }
  try {
    sync(branch);
  } finally {
    releaseLock();
  }
}

try {
  main();
} catch (err) {
  console.error(`autosync: unexpected error: ${String(err)}`);
}
process.exit(0);
