import path from "node:path";
import { WormError } from "../utils/errors.js";
import { writeTextChanged } from "../utils/fs.js";
import { ensureGitExclude } from "./git.js";
import type { Config } from "../types.js";

/**
 * Per-worktree env generation. Worm writes a DIFFERENT dotenv file into each
 * worktree, with values derived from a STABLE hash of the branch — so a given
 * branch always gets the same port/offset regardless of slot order or whether
 * the worktree is permanent or ephemeral (matches the worktrunk/Conductor model,
 * unlike the positional WORM_SLOT_INDEX which only stabilises for a fixed pool).
 *
 * The generated file is the user's window into this: it never authors a template
 * file — `vars` live as a few lines in config.json and worm renders + gitignores
 * the result. The general `renderTemplate` primitive is untouched; this evaluator
 * is dedicated to the env block and is the only place that does arithmetic inside
 * `{{ … }}` (e.g. `{{ 3000 + index * 10000 }}`).
 *
 * Two offset bases, so both worlds are covered without choosing:
 * - `index` (POSITIONAL): the slot number. `{{ 3000 + index * 10000 }}` →
 *   3000/13000/23000. Clean & sequential; stable for a fixed pool, drifts if
 *   worktrees are ephemeral (the slot number isn't tied to the branch).
 * - `offset` / `hash` (BRANCH-STABLE): derived from the branch. `{{ 8080 + offset }}`
 *   → the same port for a given branch on any machine and any slot order, at the
 *   cost of non-sequential values (the worktrunk/Conductor model).
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
  /** Slot name (`main` for Slot 0, `<N>` for siblings, or a wired worktree's label). */
  slot: string;
  /** Numeric slot index (0 for Slot 0). */
  index: number;
  branch: string;
  /** Full 32-bit stable hash of the branch. */
  hash: number;
  /** Stable port offset for the branch, in [0, PORT_RANGE). */
  offset: number;
}

export function buildEnvContext(
  slot: { name: string; index: number },
  branch: string
): EnvContext {
  return {
    slot: slot.name,
    index: slot.index,
    branch,
    hash: stableHash(branch),
    offset: portOffset(branch),
  };
}

const ENV_EXPR_HINT =
  "Use arithmetic over {{ index }} (slot number), {{ offset }} (stable per-branch, 0–999) or {{ hash }} — e.g. {{ 3000 + index * 10000 }} or {{ 8080 + offset }} — or the text vars {{ slot }} / {{ branch }}.";

/**
 * Render one `env.vars` value: substitute every `{{ … }}` token against the
 * context. A token is either a bare text var (`slot` / `branch`) or an integer
 * ARITHMETIC expression over `index` / `offset` / `hash` with `+ - * / %` and
 * parentheses. A typo or a text var used in arithmetic is a hard error — a stray
 * `{{ … }}` must never reach a dotenv file.
 */
export function renderEnvValue(value: string, ctx: EnvContext): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw: string) => {
    const expr = raw.trim();
    if (expr === "slot") return ctx.slot;
    if (expr === "branch") return ctx.branch;
    return String(evalArith(expr, ctx));
  });
}

type ArithToken =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function tokenizeArith(expr: string): ArithToken[] {
  const toks: ArithToken[] = [];
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
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /\w/.test(expr.charAt(j))) j++;
      toks.push({ t: "id", v: expr.slice(i, j) });
      i = j;
    } else if ("+-*/%()".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
    } else {
      throw new WormError(`Invalid character "${c}" in env expression "{{ ${expr} }}".`, {
        hint: ENV_EXPR_HINT,
      });
    }
  }
  return toks;
}

/**
 * Evaluate a small integer arithmetic expression (recursive descent, no `eval`).
 * Grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/'|'%') factor)* ;
 * factor := number | ident | '(' expr ')' | '-' factor. `/` and `%` truncate
 * toward zero. Identifiers resolve to the numeric context vars only.
 */
function evalArith(expr: string, ctx: EnvContext): number {
  const toks = tokenizeArith(expr);
  let pos = 0;
  const fail = (msg: string): never => {
    throw new WormError(`${msg} in env expression "{{ ${expr} }}".`, { hint: ENV_EXPR_HINT });
  };

  const parseExpr = (): number => {
    let left = parseTerm();
    for (let tok = toks[pos]; tok && tok.t === "op" && "+-".includes(tok.v); tok = toks[pos]) {
      pos++;
      const right = parseTerm();
      left = tok.v === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    for (let tok = toks[pos]; tok && tok.t === "op" && "*/%".includes(tok.v); tok = toks[pos]) {
      pos++;
      const right = parseFactor();
      if ((tok.v === "/" || tok.v === "%") && right === 0) fail("division by zero");
      left = tok.v === "*" ? left * right : tok.v === "/" ? Math.trunc(left / right) : left % right;
    }
    return left;
  };

  const parseFactor = (): number => {
    const tok = toks[pos];
    if (!tok) return fail("unexpected end of expression");
    if (tok.t === "op" && tok.v === "-") {
      pos++;
      return -parseFactor();
    }
    if (tok.t === "op" && tok.v === "(") {
      pos++;
      const v = parseExpr();
      const close = toks[pos++];
      if (!close || close.t !== "op" || close.v !== ")") fail("missing closing ')'");
      return v;
    }
    if (tok.t === "num") {
      pos++;
      return tok.v;
    }
    if (tok.t === "id") {
      pos++;
      switch (tok.v) {
        case "index":
          return ctx.index;
        case "offset":
          return ctx.offset;
        case "hash":
          return ctx.hash;
        case "slot":
        case "branch":
          return fail(`"${tok.v}" is text, not a number — use it alone, e.g. {{ ${tok.v} }}`);
        default:
          return fail(`unknown variable "${tok.v}"`);
      }
    }
    return fail(`unexpected "${tok.v}"`);
  };

  const result = parseExpr();
  if (pos < toks.length) fail(`unexpected "${toks[pos]!.v}"`);
  return result;
}

/** Render the full dotenv file body for a slot. */
export function renderEnvFile(vars: Record<string, string>, ctx: EnvContext): string {
  const lines = [
    "# Generated by worm — do not edit (regenerated on sync/switch, per-worktree).",
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
  written: boolean;
  file: string;
}

/**
 * Generate (or refresh) the per-worktree env file for one slot and ensure it's
 * git-excluded. No-op (returns null) when the project has no `env` block or an
 * empty `vars`. Idempotent: only reports `written: true` when the content
 * actually changed. Silent — the caller logs.
 */
export async function applyEnv(
  slotPath: string,
  config: Config,
  slot: { name: string; index: number },
  branch: string
): Promise<EnvApplyResult | null> {
  const env = config.env;
  if (!env || Object.keys(env.vars).length === 0) return null;
  assertNoEnvCollision(config);

  const ctx = buildEnvContext(slot, branch);
  const content = renderEnvFile(env.vars, ctx);
  const written = await writeTextChanged(path.join(slotPath, env.file), content);

  // Anchor the pattern to the worktree root so it ignores exactly this file
  // (the common info/exclude is shared across slots, so one entry covers all).
  await ensureGitExclude(slotPath, "/" + env.file.replace(/^\/+/, ""));

  return { written, file: env.file };
}
