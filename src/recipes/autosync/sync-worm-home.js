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
// We COMMIT local work first, then rebase onto the remote — never `--autostash`,
// whose pop can conflict and strand changes in refs/stash with no marker. A
// committed change is always recoverable; a stashed one silently isn't.
//
// Conflicts are NEVER auto-resolved: a clean `git rebase --abort` restores the
// repo (HEAD back on our commit), then a durable marker (.autosync-conflict.json,
// surfaced by `worm status`) plus an OS notification tell the human. The next
// clean sync clears it. Always exits 0 — a sync hiccup must never block a session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const LOCK_OWNER_FILE = path.join(LOCK_DIR, "owner");
// A per-run id written into the lock dir so we only ever release OUR OWN lock —
// never one a stale-steal handed to another racer (which would un-serialize them).
const LOCK_OWNER = randomUUID();
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
 * Integrate the remote branch by rebasing our commits onto it. The caller commits
 * any local work FIRST, so the tree is clean and no `--autostash` is needed (its
 * pop could conflict and strand changes invisibly). Returns true when in sync (or
 * there's nothing remote to integrate yet); false on a conflict — in which case it
 * has already aborted cleanly (HEAD back on our commit) and recorded the marker.
 */
function integrate(branch) {
  git(["fetch", remote, branch]);
  const ref = `${remote}/${branch}`;
  if (git(["rev-parse", "--verify", "--quiet", ref]).status !== 0) {
    return true; // remote branch doesn't exist yet — nothing to integrate
  }
  if (git(["rebase", ref]).status === 0) return true;
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
// crashed run is stolen after LOCK_STALE_MS — but via an atomic RENAME so two
// racers can't both "steal" it (a plain rm+mkdir lets the loser delete the
// winner's fresh dir). Whoever wins writes its owner id; release only removes a
// lock that still bears OUR id.
function takeLock() {
  fs.mkdirSync(LOCK_DIR); // throws EEXIST unless we won
  try {
    fs.writeFileSync(LOCK_OWNER_FILE, LOCK_OWNER);
  } catch (err) {
    // Owner-write failed — don't leave an ownerless lock dir that release can
    // never reclaim (it'd sit until the stale-steal grace). Roll back and rethrow.
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    throw err;
  }
}

function acquireLock() {
  try {
    takeLock();
    return true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") return false;
  }
  // Held. Only consider stealing once it's been stale past the grace.
  try {
    if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs <= LOCK_STALE_MS) return false;
    // Atomic steal: exactly one racer can rename the stale dir away; the rest get
    // ENOENT and back off. The winner clears it, then re-creates a fresh lock.
    fs.renameSync(LOCK_DIR, `${LOCK_DIR}.stale-${LOCK_OWNER}`);
    fs.rmSync(`${LOCK_DIR}.stale-${LOCK_OWNER}`, { recursive: true, force: true });
  } catch {
    return false; // lost the steal race (or it vanished) — treat as held
  }
  try {
    takeLock(); // a fresh racer may have grabbed it in the gap → EEXIST → back off
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    // Don't delete a lock that's no longer ours (a stale-steal gave it away).
    if (fs.readFileSync(LOCK_OWNER_FILE, "utf8") !== LOCK_OWNER) return;
  } catch {
    return; // owner file gone/unreadable — not safely ours
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// Commit any local work. Returns true when the tree is clean afterwards (nothing
// to commit, or the commit landed); false when the commit FAILED (e.g. unset git
// identity, a failing commit hook) — the caller must then bail rather than push a
// half-integrated HEAD and stamp success over un-committed work.
function commitIfDirty() {
  git(["add", "-A"]);
  // `diff --cached --quiet` exits 1 when there ARE staged changes.
  if (git(["diff", "--cached", "--quiet"]).status === 0) return true;
  return (
    git(["commit", "--quiet", "-m", `worm autosync ${new Date().toISOString()} on ${os.hostname()}`])
      .status === 0
  );
}

function sync(branch) {
  // Push debounces first (cheap) so a busy session doesn't run git every turn.
  if (mode === "push" && debounced()) return;

  // COMMIT BEFORE INTEGRATING (both modes): a committed change survives a rebase
  // conflict (we abort and it's still on HEAD), whereas an autostash pop-conflict
  // would strand it. A failed commit aborts the whole run — never push over it.
  // NOTE: this means even pull (session-start) now no-ops on a commit failure
  // (e.g. unset git identity) where it used to fetch/rebase regardless — safer,
  // but a behavior change from the old `rebase --autostash` pull path.
  if (!commitIfDirty()) return;

  if (mode === "pull") {
    if (integrate(branch)) clearConflict();
    return;
  }

  // push: rebase our commit onto the latest remote, then push.
  if (!integrate(branch)) return; // conflict: marker written, repo restored
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
