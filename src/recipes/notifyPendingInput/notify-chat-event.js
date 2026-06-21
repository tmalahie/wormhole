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

// The live `data.cwd` drifts to subfolders during a session (a `Bash cd`, an
// active file's dir, etc.), so focusing it would spawn a NEW VS Code window rooted
// at that subfolder. The directory the session launched in IS the workspace folder
// VS Code has open, recorded as the first `cwd` entry in the transcript — prefer it.
function workspaceRootFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
  try {
    for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
      } catch {
        // skip non-JSON / partial lines
      }
    }
  } catch {
    // unreadable transcript -> fall back to caller's cwd
  }
  return "";
}

// A turn that launches background agents (Agent with run_in_background, e.g. the
// /review command's parallel reviewers) fires Stop repeatedly: the main agent
// yields and auto-resumes as each agent reports in. Those intermediate yields
// aren't "your turn" — we want a SINGLE notification, on the final response.
// Scoped to the current user turn so it only affects turns that used background
// agents. Signals: launch = "Async agent launched successfully.\nagentId: <id>",
// completion = <task-id><id></task-id>; pending = launched ids with no completion.
function backgroundTurnState(transcriptPath) {
  const none = { usedBg: false, pending: 0, finalText: "" };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return none;
  let records;
  try {
    records = fs
      .readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return none;
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

  const isRealUserPrompt = (r) => {
    if (!r || r.type !== "user") return false;
    const content = r.message && r.message.content;
    const text = textOf(content);
    if (text.includes("<task-notification>")) return false; // background completion injection
    if (Array.isArray(content) && content.every((c) => c && c.type === "tool_result")) return false;
    return text.trim().length > 0;
  };

  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isRealUserPrompt(records[i])) {
      start = i;
      break;
    }
  }
  const blob = records.slice(start).map(textOf).join("\n");

  const launched = new Set();
  const completed = new Set();
  let m;
  const reLaunch = /Async agent launched successfully\.\s*agentId:\s*([0-9a-f]+)/g;
  const reDone = /<task-id>\s*([0-9a-f]+)\s*<\/task-id>/g;
  while ((m = reLaunch.exec(blob))) launched.add(m[1]);
  while ((m = reDone.exec(blob))) completed.add(m[1]);
  let pending = 0;
  for (const id of launched) if (!completed.has(id)) pending++;

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

  return { usedBg: launched.size > 0, pending, finalText };
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

  const cwd = workspaceRootFromTranscript(data.transcript_path) || data.cwd || "";
  const project = cwd ? path.basename(cwd) : "Claude Code";
  const toolName = data.tool_name || "";
  const isPermission = event === "PermissionRequest" || type === "permission_prompt";

  // Collapse the burst of intermediate "Response ready" yields a background-agent
  // turn produces into one notification on the final synthesis (see above). A short
  // (<200 char) final in such a turn is treated as a status yield, not the answer.
  if (!isPermission) {
    const bg = backgroundTurnState(data.transcript_path);
    if (bg.usedBg && (bg.pending > 0 || bg.finalText.trim().length < 200)) return;
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
