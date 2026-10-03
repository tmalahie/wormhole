import path from "node:path";
import { WormError } from "../utils/errors.js";
import { fs, pathExists, writeTextChanged } from "../utils/fs.js";
import { ensureGitExclude } from "./git.js";
import type { Config } from "../types.js";

/**
 * Per-worktree env generation. A worktree that has a runtime slot (slots.json)
 * gets a dotenv file rendered from the project's `env.vars`, with `index` = its
 * slot number — so slot N's ports are e.g. `{{ 3000 + index * 100 }}`. A worktree
 * without a slot has no env file at all (it is removed on release).
 *
 * The file is the user's window into this: `vars` live as a few lines in
 * config.json and worm renders + gitignores the result. The general
 * `renderTemplate` primitive is untouched; this evaluator is dedicated to the env
 * block and is the only place that evaluates expressions inside `{{ … }}`.
 *
 * `offset` / `hash` (branch-stable, derived from the branch name) remain for
 * projects that prefer values tied to the branch rather than to a slot.
 */

/** Span of stable offsets (so `{{ port 8080 }}` lands in 8080..9079). */
export const PORT_RANGE = 1000;

/**
 * Deterministic 32-bit FNV-1a hash → unsigned int. Stable across machines and
 * runs (no Math.random / Date), which is the whole point — the same branch must
 * hash identically everywhere so its assigned ports never drift.
 */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The per-worktree port offset for a branch, in [0, PORT_RANGE). */
export function portOffset(branch: string): number {
  return stableHash(branch) % PORT_RANGE;
}

export interface EnvContext {
  /** The assigned slot number. */
  index: number;
  /** Worktree name ("main" for the main worktree). */
  name: string;
  branch: string;
  /** Full 32-bit stable hash of the branch. */
  hash: number;
  /** Stable port offset for the branch, in [0, PORT_RANGE). */
  offset: number;
  /** The project's profile dir (`~/.worm/projects/<name>`). */
  profile: string;
  /** The main worktree's path. */
  root: string;
  /** This worktree's path. */
  worktree: string;
}

export function buildEnvContext(fields: {
  index: number;
  name: string;
  branch: string;
  profile: string;
  root: string;
  worktree: string;
}): EnvContext {
  return { ...fields, hash: stableHash(fields.branch), offset: portOffset(fields.branch) };
}

const ENV_EXPR_HINT =
  "Expressions use {{ index }} (slot number), {{ offset }} / {{ hash }} (branch-stable), the text vars name / branch / profile / root / worktree, 'quoted strings', + - * / %, == / != and cond ? a : b — e.g. {{ 3000 + index * 100 }} or {{ index == 0 ? 'app' : 'app-' + index }}.";

type Value = number | string;

/**
 * Render one `env.vars` value: substitute every `{{ … }}` token with the value of
 * its expression. A typo or a type mismatch is a hard error — a stray `{{ … }}`
 * must never reach a dotenv file.
 */
export function renderEnvValue(value: string, ctx: EnvContext): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw: string) =>
    String(evalExpr(raw.trim(), ctx))
  );
}

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPERATORS = ["==", "!=", "+", "-", "*", "/", "%", "(", ")", "?", ":"];

function tokenize(expr: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr.charAt(i);
    if (c === " " || c === "\t") {
      i++;
    } else if (c >= "0" && c <= "9") {
      let j = i;
      while (j < expr.length && expr.charAt(j) >= "0" && expr.charAt(j) <= "9") j++;
      toks.push({ t: "num", v: Number.parseInt(expr.slice(i, j), 10) });
      i = j;
    } else if (c === "'" || c === '"') {
      const end = expr.indexOf(c, i + 1);
      if (end === -1) {
        throw new WormError(`Unterminated string in env expression "{{ ${expr} }}".`, {
          hint: ENV_EXPR_HINT,
        });
      }
      toks.push({ t: "str", v: expr.slice(i + 1, end) });
      i = end + 1;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /\w/.test(expr.charAt(j))) j++;
      toks.push({ t: "id", v: expr.slice(i, j) });
      i = j;
    } else {
      const op = OPERATORS.find((o) => expr.startsWith(o, i));
      if (!op) {
        throw new WormError(`Invalid character "${c}" in env expression "{{ ${expr} }}".`, {
          hint: ENV_EXPR_HINT,
        });
      }
      toks.push({ t: "op", v: op });
      i += op.length;
    }
  }
  return toks;
}

/**
 * Evaluate an env expression (recursive descent, no `eval`). Grammar, loosest
 * first:
 *   cond   := equal ('?' cond ':' cond)?
 *   equal  := sum (('==' | '!=') sum)*
 *   sum    := term (('+' | '-') term)*      '+' concatenates when either side is text
 *   term   := factor (('*' | '/' | '%') factor)*   numbers only; truncating
 *   factor := number | 'string' | ident | '(' cond ')' | '-' factor
 */
function evalExpr(expr: string, ctx: EnvContext): Value {
  const toks = tokenize(expr);
  let pos = 0;
  const fail = (msg: string): never => {
    throw new WormError(`${msg} in env expression "{{ ${expr} }}".`, { hint: ENV_EXPR_HINT });
  };
  const isOp = (v: string): boolean => {
    const tok = toks[pos];
    return tok !== undefined && tok.t === "op" && tok.v === v;
  };
  const num = (v: Value, op: string): number =>
    typeof v === "number" ? v : fail(`"${op}" needs numbers, got text "${v}"`);

  const parseCond = (): Value => {
    const test = parseEqual();
    if (!isOp("?")) return test;
    pos++;
    const yes = parseCond();
    if (!isOp(":")) fail("expected ':' after '?'");
    pos++;
    const no = parseCond();
    return test !== 0 && test !== "" ? yes : no;
  };

  const parseEqual = (): Value => {
    let left = parseSum();
    while (isOp("==") || isOp("!=")) {
      const op = String(toks[pos++]!.v);
      const right = parseSum();
      left = (left === right) === (op === "==") ? 1 : 0;
    }
    return left;
  };

  const parseSum = (): Value => {
    let left = parseTerm();
    while (isOp("+") || isOp("-")) {
      const op = String(toks[pos++]!.v);
      const right = parseTerm();
      if (op === "+" && (typeof left === "string" || typeof right === "string")) {
        left = String(left) + String(right);
      } else {
        left = op === "+" ? num(left, op) + num(right, op) : num(left, op) - num(right, op);
      }
    }
    return left;
  };

  const parseTerm = (): Value => {
    let left = parseFactor();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = String(toks[pos++]!.v);
      const l = num(left, op);
      const r = num(parseFactor(), op);
      if ((op === "/" || op === "%") && r === 0) fail("division by zero");
      left = op === "*" ? l * r : op === "/" ? Math.trunc(l / r) : l % r;
    }
    return left;
  };

  const parseFactor = (): Value => {
    const tok = toks[pos];
    if (!tok) return fail("unexpected end of expression");
    if (tok.t === "op" && tok.v === "-") {
      pos++;
      return -num(parseFactor(), "-");
    }
    if (tok.t === "op" && tok.v === "(") {
      pos++;
      const v = parseCond();
      if (!isOp(")")) fail("missing closing ')'");
      pos++;
      return v;
    }
    pos++;
    if (tok.t === "num" || tok.t === "str") return tok.v;
    if (tok.t === "id") {
      switch (tok.v) {
        case "index":
          return ctx.index;
        case "offset":
          return ctx.offset;
        case "hash":
          return ctx.hash;
        case "name":
          return ctx.name;
        case "branch":
          return ctx.branch;
        case "profile":
          return ctx.profile;
        case "root":
          return ctx.root;
        case "worktree":
          return ctx.worktree;
        default:
          return fail(`unknown variable "${tok.v}"`);
      }
    }
    return fail(`unexpected "${tok.v}"`);
  };

  const result = parseCond();
  if (pos < toks.length) fail(`unexpected "${toks[pos]!.v}"`);
  return result;
}

/** Render the full dotenv file body for a slot. */
export function renderEnvFile(vars: Record<string, string>, ctx: EnvContext): string {
  const lines = [
    "# Generated by worm for this worktree's slot — do not edit (re-rendered on assign/sync).",
  ];
  for (const [key, raw] of Object.entries(vars)) {
    lines.push(`${key}=${renderEnvValue(raw, ctx)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * A managed env `file` must not also be a `shared_path` — one would symlink an
 * identical source everywhere while the other writes a per-worktree file, and
 * they'd clobber each other on every sync. Refuse cleanly instead.
 */
export function assertNoEnvCollision(config: Config): void {
  if (!config.env) return;
  // Normalize both sides so cosmetic differences (`./x` vs `x`, a trailing slash)
  // can't slip an identical path past the guard and clobber on sync.
  const norm = (p: string): string => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const tails = config.shared_paths.map((e) => norm(typeof e === "string" ? e : e.path));
  if (tails.includes(norm(config.env.file))) {
    throw new WormError(
      `env.file "${config.env.file}" is also listed in shared_paths.`,
      {
        hint: "A path can't be both a per-worktree env file and a shared (symlinked) file. Rename env.file or drop it from shared_paths.",
      }
    );
  }
}

export interface EnvApplyResult {
  /** "written" (created or changed), "unchanged", or "removed" (no slot). */
  change: "written" | "unchanged" | "removed";
  file: string;
}

/**
 * Bring a worktree's env file in line with its slot: render it when `ctx` is
 * given (the worktree has a slot), delete it when `ctx` is null. Ensures the file
 * is git-excluded either way. Returns null when the project has no `env` block or
 * an empty `vars`. Silent — the caller logs.
 */
export async function applyEnv(
  worktreePath: string,
  config: Config,
  ctx: EnvContext | null
): Promise<EnvApplyResult | null> {
  const env = config.env;
  if (!env || Object.keys(env.vars).length === 0) return null;
  assertNoEnvCollision(config);

  const target = path.join(worktreePath, env.file);
  // Anchor the pattern to the worktree root so it ignores exactly this file
  // (the common info/exclude is shared across worktrees, so one entry covers all).
  await ensureGitExclude(worktreePath, "/" + env.file.replace(/^\/+/, ""));

  if (!ctx) {
    if (!(await pathExists(target))) return { change: "unchanged", file: env.file };
    await fs.rm(target, { force: true });
    return { change: "removed", file: env.file };
  }
  const content = renderEnvFile(env.vars, ctx);
  const written = await writeTextChanged(target, content);
  return { change: written ? "written" : "unchanged", file: env.file };
}
