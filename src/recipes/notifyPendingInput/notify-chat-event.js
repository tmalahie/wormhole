#!/usr/bin/env node
// The `notifyPendingInput` recipe's worker, shipped WITH worm. An OS notification whose click
// focuses the VS Code window for the originating project. Reads the hook JSON from
// stdin. Invoked by the GLOBAL dispatch (`worm hook trigger --global <stop|
// permission-request>`, wired into ~/.claude/settings.json by `worm sync --global`):
//   - Stop              -> "Response ready" when a turn finishes
//   - PermissionRequest -> "Waiting for approval" on a permission prompt
// Both payloads carry cwd (the workspace folder), used to label the notification
// and to focus the right window. The actual OS call lives in ../_lib/notify.js.
import fs from "node:fs";
import path from "node:path";
import { notify } from "../_lib/notify.js";

// The macOS app a notification click opens the project folder in (passed by the
// recipe from its `openOnClick` config). Empty → no click action.
const OPEN_ON_CLICK = process.argv[2] ?? "";

// Both the workspace lookup and the background-agent state below read the whole
// transcript, which is tens of MB by the end of a long session — parse it once.
function readRecords(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    return fs
      .readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // skip partial / non-JSON lines
        }
      })
      .filter(Boolean);
  } catch {
    return []; // unreadable transcript -> fall back to the payload's own cwd
  }
}

const textOf = (node) => {
  const out = [];
  const walk = (n) => {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(node);
  return out.join("\n");
};

// Turns the HARNESS submitted on the user's behalf: a background agent's
// hand-back (`origin.kind: "peer"`) and its completion notice
// (`"task-notification"`) both land as `type: "user"` records with the same
// shape as a real prompt. Modern transcripts label them; older ones don't, so
// fall back to the text the injections carry.
const isInjectedTurn = (r) => {
  const kind = r.origin && r.origin.kind;
  if (typeof r.turnOrigin === "string") return r.turnOrigin !== "human";
  if (typeof kind === "string") return kind !== "human";
  if (r.promptSource === "system") return true;
  const text = textOf(r.message && r.message.content);
  return text.includes("<task-notification>") || text.includes("<agent-message from=");
};

// A user record the human actually submitted, as opposed to the tool results and
// injections that also land as `type: "user"`.
const isRealUserPrompt = (r) => {
  if (!r || r.type !== "user") return false;
  if (isInjectedTurn(r)) return false;
  const content = r.message && r.message.content;
  const text = textOf(content);
  if (Array.isArray(content) && content.every((c) => c && c.type === "tool_result")) return false;
  return text.trim().length > 0;
};

// A worktree root: a normal checkout (`.git` dir) or a linked worktree (`.git`
// file). The editor window is rooted at one of these, so it is what a
// notification should name and what its click should focus.
const isWorktreeRoot = (dir) => {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
};

// Where the CURRENT turn is being held. Two things make this harder than reading
// `data.cwd`:
//   - the live cwd drifts into subfolders and sibling repos during a session (a
//     `Bash cd`), so focusing it would spawn a NEW editor window rooted there —
//     and naming it announces "src" rather than the worktree;
//   - a session outlives the slot it opened in — resumed or moved, its workspace
//     changes mid-transcript (11% of the transcripts here do this), so the
//     opening `cwd` names the worktree the work STARTED in, not where it is now.
// Every record carries the cwd live at the moment it was written, prompts
// included: a `cd` in one turn leaks into the next prompt. So: the newest user
// prompt whose cwd is a worktree ROOT. Newest answers "which slot now"; the root
// test steps back past a drifted prompt to the last one taken at a workspace,
// which is where the window still is. A session held entirely below a root (an
// editor opened on a subfolder) has no rooted prompt to find and keeps its own
// cwd, so the test only ever discards drift. Returns the anchor index too: the
// newest prompt, rooted or not, starts the turn the background-agent scan below
// is scoped to.
function turnAnchor(records) {
  let start = -1;
  let newest = "";
  let rooted = "";
  for (let i = records.length - 1; i >= 0; i--) {
    if (!isRealUserPrompt(records[i])) continue;
    if (start === -1) start = i;
    const cwd = records[i].cwd;
    if (typeof cwd !== "string" || !cwd) continue;
    if (!newest) newest = cwd;
    if (isWorktreeRoot(cwd)) {
      rooted = cwd;
      break;
    }
  }
  // No prompt in the transcript (e.g. it scrolled out of a compacted/resumed
  // session): the opening cwd is the best remaining guess at the workspace.
  const cwd = rooted || newest || records.find((r) => typeof r.cwd === "string" && r.cwd)?.cwd || "";
  return { start, cwd };
}

// The three markers an agent leaves in the transcript of the session that owns
// it. A launch is "Async agent launched successfully. (…)\nagentId: <id>" (a
// parenthetical metadata note sits between the two, so match non-greedily); the
// agent then HANDS BACK its report (<agent-message from="<id>">) and, a beat
// later, the harness posts its <task-id><id></task-id> notice.
const RE_LAUNCH = /Async agent launched successfully\.[\s\S]*?agentId:\s*([0-9a-f]+)/g;
const RE_HANDBACK = /<agent-message from="([0-9a-f]+)"/g;
const RE_NOTICE = /<task-id>\s*([0-9a-f]+)\s*<\/task-id>/g;

const idsMatching = (re, text) => {
  const out = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
};

// A turn that launches background agents (Agent with run_in_background, e.g. the
// /review command's parallel reviewers) fires Stop repeatedly: the main agent
// yields and auto-resumes as each agent reports in. Those intermediate yields
// aren't "your turn" — we want a SINGLE notification, on the final response.
// Scoped to the current user turn (from `start`) so it only affects turns that
// used background agents. An agent counts as settled on its hand-back OR its
// notice, whichever lands first: the hand-back carries the report and arrives
// first, so waiting for the notice would suppress the very synthesis it triggers.
function backgroundTurnState(records, start) {
  const none = { usedBg: false, pending: 0, finalText: "", launched: new Set(), handedBack: new Set() };
  // No originating user prompt in the transcript. Scanning from 0 would sweep
  // prior turns' agent ids in and wrongly suppress this turn's final
  // notification — so treat it as "no background state" and let it through.
  if (start === -1) return none;
  const blob = records.slice(start).map(textOf).join("\n");

  const launched = idsMatching(RE_LAUNCH, blob);
  const handedBack = idsMatching(RE_HANDBACK, blob);
  const noticed = idsMatching(RE_NOTICE, blob);
  let pending = 0;
  for (const id of launched) if (!handedBack.has(id) && !noticed.has(id)) pending++;

  let finalText = "";
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "assistant" && !r.isSidechain && !r.attributionAgent) {
      const content = r.message && r.message.content;
      if (Array.isArray(content)) {
        finalText = content.filter((c) => c && c.type === "text").map((c) => c.text || "").join(" ");
      }
      break;
    }
  }

  return { usedBg: launched.size > 0, pending, finalText, launched, handedBack };
}

// What resumed the main agent for the turn that just ended. A turn opens on the
// human's prompt, on a background agent's hand-back, or on the notice that
// follows one; tool results interleave as `type: "user"` records too, so skip
// them. Modern transcripts label the opener (`origin.kind`), older ones only
// carry the injected text.
function turnTrigger(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || r.type !== "user") continue;
    const content = r.message && r.message.content;
    if (Array.isArray(content) && content.every((c) => c && c.type === "tool_result")) continue;
    if (isRealUserPrompt(r)) return { kind: "human", id: "" };
    const text = textOf(content);
    const kind = r.origin && r.origin.kind;
    if (kind === "peer" || (!kind && RE_HANDBACK.test(text))) {
      const id = (r.origin && r.origin.senderTaskId) || [...idsMatching(RE_HANDBACK, text)][0] || "";
      return { kind: "handback", id };
    }
    if (kind === "task-notification" || (!kind && text.includes("<task-notification>"))) {
      return { kind: "notice", id: [...idsMatching(RE_NOTICE, text)][0] || "" };
    }
  }
  return { kind: "human", id: "" };
}

function main() {
  let data = {};
  try {
    const raw = fs.readFileSync(0, "utf8");
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  const event = data.hook_event_name || "";
  const type = data.notification_type || "";

  // Sub-agents run their own loop, so events fire from inside Task calls too. We
  // only care about the MAIN agent yielding to the user — sub-agent payloads carry
  // agent_id/agent_type, which top-level events never do. Drop them.
  if (data.agent_id || data.agent_type) return;

  // A bare Notification is a delayed idle nudge we don't want (Stop covers
  // "finished"); only act on its permission_prompt variant.
  if (event === "Notification" && type !== "permission_prompt") return;

  const records = readRecords(data.transcript_path);
  const anchor = turnAnchor(records);
  const cwd = anchor.cwd || data.cwd || "";
  const project = cwd ? path.basename(cwd) : "Claude Code";
  const toolName = data.tool_name || "";
  const isPermission = event === "PermissionRequest" || type === "permission_prompt";

  // Collapse the burst of intermediate "Response ready" yields a background-agent
  // turn produces into one notification on the final synthesis (see above).
  if (!isPermission) {
    const bg = backgroundTurnState(records, anchor.start);
    if (bg.usedBg) {
      const trigger = turnTrigger(records);
      // A report from an agent this turn never launched: agents nest, and a
      // grandchild hands back to the session that owns the whole tree, not to
      // the agent that spawned it. Its parent has already reported, so what the
      // main agent writes now is an addendum — the answer went out with the
      // parent's own report. This is the only marker of a still-growing tree:
      // a grandchild is invisible here until the moment it reports.
      if (trigger.id && !bg.launched.has(trigger.id)) return;
      // The notice that trails a hand-back carries no new content — the report
      // it announces already arrived, and already had its chance to notify.
      if (trigger.kind === "notice" && bg.handedBack.has(trigger.id)) return;
      // An agent is still out, or this is a status yield ("2 of 4 are in")
      // rather than the answer.
      if (bg.pending > 0 || bg.finalText.trim().length < 200) return;
    }
  }

  notify({
    title: `Claude Code — ${project}`,
    message: isPermission ? `Waiting for approval${toolName ? `: ${toolName}` : ""}` : "Response ready",
    sound: true,
    focusPath: cwd,
    focusApp: OPEN_ON_CLICK,
  });
}

main();
