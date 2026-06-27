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
//
// Order of operations matters. We FETCH FIRST (the slow network round-trip to the
// remote), THEN commit local work, THEN rebase immediately. A dirty working tree
// is harmless during fetch (it only updates remote-tracking refs/objects), so
// keeping the slow part out of the commit→rebase window leaves a concurrent writer
// almost no room to dirty the tree between our commit and the rebase. Such writers
// DO exist and are NOT covered by our lock: the `syncGlobalPermissions` recipe and
// Claude's own permission dialog both write tracked files inside ~/.worm
// (settings.json / settings.local.json) at arbitrary moments. If one lands mid-
// rebase, `git rebase` bails non-zero with NO real content conflict — so we
// re-absorb the change (re-commit) and retry the rebase a few times before giving
// up. We COMMIT local work (never `--autostash`, whose pop can conflict and strand
// changes in refs/stash with no marker — a committed change is always recoverable).
//
// Genuine conflicts are NEVER auto-resolved: a clean `git rebase --abort` restores
// the repo (HEAD back on our commit), then a durable marker (.autosync-conflict.json,
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

// A rebase that bails because a concurrent writer (syncGlobalPermissions, a
// permission-dialog write through a tunnel) dirtied the tree is transient — we
// re-commit the racing change and retry. Bounded so a genuinely stuck state can't
// spin: each retry's rebase is purely local (no fetch), so a few attempts is cheap.
const REBASE_ATTEMPTS = 3;

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
 * Rebase our committed work onto the ALREADY-FETCHED remote ref (the caller fetches
 * first, then commits, then calls this — so the slow network round-trip is out of
 * the dirty-sensitive window and the tree is clean going in). Returns:
 *   "ok"           — in sync (rebase clean / nothing to replay)
 *   "conflict"     — genuine content conflict: aborted cleanly, marker recorded
 *   "commit-failed"— a re-commit failed (unset identity, failing hook); caller bails
 *
 * A concurrent writer (another session's syncGlobalPermissions, or a Claude
 * permission-dialog write arriving through a tunnel symlink) can dirty the tree in
 * the narrow window before the rebase, making `git rebase` bail non-zero with NO
 * real conflict. We absorb that write (re-commit) and retry. Only a rebase that
 * still fails with a clean tree — nothing new to re-commit — is treated as a real
 * conflict; `rebase --abort` has by then restored HEAD to our commit either way.
 */
function rebaseOnto(ref) {
  if (git(["rev-parse", "--verify", "--quiet", ref]).status !== 0) {
    return "ok"; // remote branch doesn't exist yet — nothing to rebase onto
  }
  for (let attempt = 1; attempt <= REBASE_ATTEMPTS; attempt++) {
    if (git(["rebase", ref]).status === 0) return "ok";
    git(["rebase", "--abort"]); // no-op (harmless non-zero) if a dirty preflight blocked the rebase
    if (attempt === REBASE_ATTEMPTS) break;
    // Re-absorb a racing write and retry. If there's nothing new to commit, the
    // tree is clean and the failure is a genuine conflict — stop and record it.
    const c = commitWork();
    if (c === "failed") return "commit-failed";
    if (c === "clean") break;
    // c === "committed" → a racing write was absorbed; loop and retry the rebase.
  }
  recordConflict(`rebase onto ${ref} hit conflicts`);
  return "conflict";
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

// Stage and commit any local work. Returns "clean" (nothing to commit), "committed"
// (the commit landed), or "failed" (the commit errored — unset git identity, a
// failing commit hook). The caller must bail on "failed" rather than push a half-
// integrated HEAD and stamp success over un-committed work.
function commitWork() {
  git(["add", "-A"]);
  // `diff --cached --quiet` exits non-zero when there ARE staged changes.
  if (git(["diff", "--cached", "--quiet"]).status === 0) return "clean";
  return git(["commit", "--quiet", "-m", `worm autosync ${new Date().toISOString()} on ${os.hostname()}`])
    .status === 0
    ? "committed"
    : "failed";
}

function sync(branch) {
  // Push debounces first (cheap) so a busy session doesn't run git every turn.
  if (mode === "push" && debounced()) return;

  // FETCH FIRST (the slow part). A dirty tree is harmless during fetch — it only
  // updates remote-tracking refs/objects — so doing it before the commit keeps the
  // network round-trip OUT of the commit→rebase window a concurrent writer could
  // slip into. commit + rebase then run back-to-back.
  git(["fetch", remote, branch]);
  const ref = `${remote}/${branch}`;

  // COMMIT BEFORE REBASING (both modes): a committed change survives a rebase
  // conflict (we abort and it's still on HEAD), whereas an autostash pop-conflict
  // would strand it. A failed commit aborts the whole run — never push over it.
  // NOTE: this means even pull (session-start) no-ops on a commit failure (e.g.
  // unset git identity) where the old `rebase --autostash` pull fetched regardless.
  if (commitWork() === "failed") return;

  if (mode === "pull") {
    // A clean rebase (or nothing remote yet) → in sync; clear any stale marker.
    if (rebaseOnto(ref) === "ok") clearConflict();
    return;
  }

  // push: rebase our commit onto the latest remote (if any), then push.
  if (rebaseOnto(ref) !== "ok") return; // conflict/commit-fail: handled, repo restored
  if (git(["push", remote, branch]).status === 0) {
    clearConflict();
    stamp();
    return;
  }
  // Push rejected → another MACHINE advanced the remote since our fetch (the local
  // lock can't serialize across hosts). Re-fetch, re-commit, re-rebase, retry once.
  git(["fetch", remote, branch]);
  if (commitWork() === "failed") return;
  if (rebaseOnto(ref) !== "ok") return;
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
