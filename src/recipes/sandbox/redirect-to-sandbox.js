#!/usr/bin/env node
// PreToolUse(Bash) hook shipped WITH worm (sandbox recipe). Denies
// filesystem-mutating commands and ad-hoc script runs on the host, redirecting
// them into a long-running docker sandbox whose blast radius is limited to the
// mounted worktree.
//
// This file is config-independent: every per-project parameter is passed at run
// time, so ONE copy lives in the worm package (dist/recipes/) and is never
// materialized per project. Update it here and rebuild — all projects follow.
//
// Usage:  node redirect-to-sandbox.js <container> <composePath> [policyFile]
//   - policy is read from <policyFile> (defaults to a sibling sandbox-policy.json)
//   - decisions are logged under $WORM_LOG_DIR (defaults to ../../logs)
// Append ' #bypass-hook' to any command to run it on the host anyway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const containerName = process.argv[2] || 'sandbox';
const composePath = process.argv[3] || '';
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const policyFile = process.argv[4] || path.join(__dirname, 'sandbox-policy.json');
let policy = { neverSandbox: ['node', 'npm', 'npx', 'pnpm', 'yarn'], exemptDirs: [] };
try {
  policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
} catch (e) { /* fall back to defaults */ }

function logDecision(decision, cmd) {
  try {
    const dir = process.env.WORM_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = '[' + new Date().toISOString() + '] ' + decision + ' ' + cmd.replace(/\n/g, ' ') + '\n';
    fs.appendFileSync(path.join(dir, containerName + '-redirect.log'), line);
  } catch (e) { /* logging must never break the decision */ }
}

const FILE_OPS = new Set(['rm', 'rmdir', 'mv', 'cp', 'truncate', 'shred', 'install']);
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'perl', 'ruby', 'php']);
const NODE_TOOLS = new Set(policy.neverSandbox || []);

const SCRIPT_TOKEN = /(?:^|[\s='"(])((?:\.{1,2}\/|\/)?[^\s'"()]*\.(?:sh|bash|zsh|py|rb|pl|php)|\.{1,2}\/[^\s'"()]+)(?=$|[\s'")])/;
const READONLY_CHECK = /\bphp\s+-l\b/;

const exemptNames = ['worm', 'claude'].concat(policy.exemptDirs || []);
// Matches a path token whose component is .worm/ .claude/ (or a configured
// exempt dir), in any form: bare ./relative, ~/-rooted, or absolute.
const EXCLUDED_DIR = new RegExp('(?:^|[\\s=\'"(])(?:[^\\s\'"]*/)?\\.(?:' + exemptNames.join('|') + ')/');

function allow() { process.exit(0); }

function shortSeg(seg) {
  const s = seg.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

function triggerReason(t) {
  switch (t && t.kind) {
    case 'file-op': return 'mutates the filesystem';
    case 'node': return 'executes arbitrary code';
    case 'script':
    case 'interpreter-script': return 'runs an ad-hoc script';
    default: return 'mutates the filesystem or runs an ad-hoc script';
  }
}

function deny(trigger) {
  const cause = trigger
    ? 'This command was redirected because the \'' + trigger.program + '\' in segment "' + shortSeg(trigger.segment) + '" ' + triggerReason(trigger) + '. '
    : 'This command mutates the filesystem or runs an ad-hoc script on the host. ';
  const reason =
    cause +
    'Run it inside the \'' + containerName + '\' docker sandbox (already up) so its blast radius stays ' +
    'limited to the mounted worktree. Re-run it as (wrap your command in single quotes):\n' +
    '  docker exec ' + containerName + ' bash -lc \'<your original command>\'\n\n' +
    'The sandbox mounts ' + projectDir + ' read-write at the same absolute path. ' +
    'Allowlisted commands in other segments (e.g. git) run fine on the host on their own, so split them out to keep them there.' +
    '\n\nAppend \' #bypass-hook\' to run on the host anyway.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function baseName(token) { const parts = token.split('/'); return parts[parts.length - 1]; }

// Blank the INTERIOR of single/double-quoted spans (preserving length and the
// quote chars), so shell operators and file-op words inside string literals —
// commit messages, --body text, jq filters — can't be misread as command
// boundaries or programs. Positions are preserved so callers can slice raw.
function maskQuotedSpans(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) { quote = null; out += ch; } else { out += ' '; }
    } else if (ch === '"' || ch === "'") {
      quote = ch; out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// Split on unquoted ; && || and newlines: find the operators in the masked
// string (quoted ones are blanked, so ignored), then slice the RAW command at
// those offsets. Analysing the raw segment keeps quoted script PATHS visible to
// SCRIPT_TOKEN while never splitting inside a quote.
function splitRespectingQuotes(command) {
  const masked = maskQuotedSpans(command);
  const re = /\n|;|&&|\|\|/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(masked)) !== null) {
    out.push(command.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(command.slice(last));
  return out;
}

function findRedirectTrigger(command) {
  if (/#bypass-hook\s*$/.test(command)) return null;
  if (/^\s*(?:sudo\s+)?docker(?:\s|-compose\b|$)/.test(command)) return null;
  for (let raw of splitRespectingQuotes(command)) {
    const display = raw.trim();
    if (!display) continue;
    // Exempt a segment that runs a script under an exempt dir (.worm/.claude/…).
    // Per-SEGMENT (not whole-command) so one exempt clause can't shield a sibling
    // file-op; masked so a quoted path can't spuriously exempt one either.
    if (EXCLUDED_DIR.test(maskQuotedSpans(display))) continue;
    const segment = display.replace(/^(?:\w+=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '').replace(/^sudo\s+/, '');
    const firstToken = segment.split(/\s+/)[0] || '';
    if (!firstToken) continue;
    const program = baseName(firstToken);
    if (NODE_TOOLS.has(program)) continue;
    // node executes arbitrary code (a script, -e/-p, or stdin), so sandbox it
    // unless neverSandbox exempts it (handled above) — except pure inspection
    // flags that don't run user code.
    if (program === 'node') {
      if (/\s--(?:version|check|help)\b|\s-v\b/.test(' ' + segment)) continue;
      return { kind: 'node', program: 'node', segment: display };
    }
    if (INTERPRETERS.has(program) && READONLY_CHECK.test(segment)) continue;
    if (FILE_OPS.has(program)) return { kind: 'file-op', program: program, segment: display };
    if (/^(?:\.{1,2}\/|\/)?[^\s]*\.(?:sh|bash|zsh|py|rb|pl|php)$/.test(firstToken)) return { kind: 'script', program: firstToken, segment: display };
    if (INTERPRETERS.has(program) && SCRIPT_TOKEN.test(segment)) return { kind: 'interpreter-script', program: program, segment: display };
  }
  return null;
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let command = '';
  try { command = (JSON.parse(input).tool_input || {}).command || ''; } catch (e) { allow(); }
  if (!command) allow();
  const trigger = findRedirectTrigger(command);
  if (trigger) { logDecision('DENY ', command); deny(trigger); }
  logDecision('allow', command); allow();
});
