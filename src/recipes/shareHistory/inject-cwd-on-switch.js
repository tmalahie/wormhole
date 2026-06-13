#!/usr/bin/env node
// shareHistory recipe — UserPromptSubmit hook.
//
// Because shareHistory makes every slot share ONE conversation history, a single
// chat can hop between worktrees as you `worm switch`. When the conversation's
// working directory changes between two consecutive prompts, this emits a
// reminder so the model knows the active cwd switched (a git worktree switch).
//
// Contract: it prints ONLY the reminder text to stdout (or nothing). The worm
// dispatcher wraps that text in the UserPromptSubmit JSON envelope — this script
// owns WHAT to say, the dispatcher owns the hook protocol. Stays silent on the
// first prompt of a session and on prompts where the cwd is unchanged.
//
// Stateless: the "previous" cwd is read from the last transcript entry that
// predates this prompt, so there is no state file to manage.

import fs from 'node:fs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function entryText(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function findPreviousCwd(transcriptPath, currentPrompt) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  let skippedCurrentPrompt = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (
      !skippedCurrentPrompt &&
      entry.type === 'user' &&
      typeof currentPrompt === 'string' &&
      entryText(entry).trim() === currentPrompt.trim()
    ) {
      skippedCurrentPrompt = true;
      continue;
    }

    if (typeof entry.cwd === 'string' && entry.cwd) {
      return entry.cwd;
    }
  }

  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }

  const cwd = input.cwd;
  const transcriptPath = input.transcript_path;
  if (!cwd || !transcriptPath) {
    process.exit(0);
  }

  const previousCwd = findPreviousCwd(transcriptPath, input.prompt);
  if (!previousCwd || previousCwd === cwd) {
    process.exit(0);
  }

  const context =
    `<system-reminder>Conversation working directory switched to ${cwd} ` +
    `(was ${previousCwd}). This is a git worktree switch — treat ${cwd} as the ` +
    `active cwd from here on.</system-reminder>`;

  process.stdout.write(context);
  process.exit(0);
}

main();
