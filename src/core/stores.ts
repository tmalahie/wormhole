import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { runOrThrow } from "../utils/exec.js";
import { ensureDir, fs, pathExists } from "../utils/fs.js";
import { globalProjectFile } from "./paths.js";
import { loadGlobalConfig } from "./global-config.js";
import type { Config, StoreConfig } from "../types.js";

/** One shared_path resolved to a concrete link source. */
export interface ResolvedLink {
  /** Slot-relative path — both the link location AND the path within the store. */
  tail: string;
  /** Absolute source the link points at. */
  source: string;
  /**
   * Profile-store links sprout an empty source when missing; external-store
   * links don't (worm must never fabricate files inside someone's team repo).
   */
  sprout: boolean;
}

/**
 * Resolve a project's `shared_paths` into concrete link sources. A bare string
 * (or an entry with no `store`) comes from the project PROFILE; an entry with a
 * `store` comes from that named store's root — project `stores` override
 * same-named global (`~/.worm/config.json`) stores. A store whose `root` is
 * missing is cloned from its `url` if given, else a clean error. Stores resolve
 * once (and clone at most once) per call.
 *
 * A tail ending in `/*` is a DIRECTORY GLOB: it links each child of that store
 * directory individually instead of the directory itself. Use it when the slot's
 * parent dir must stay a real, git-tracked directory — e.g. `.claude/skills/*`
 * links your personal skills one by one into a `.claude/skills/` that also holds
 * skills committed to the repo. New children are picked up by `worm sync` with
 * no config change; removed ones are pruned.
 */
export async function resolveStoreLinks(config: Config, projectName: string): Promise<ResolvedLink[]> {
  const globalConfig = await loadGlobalConfig();
  const stores: Record<string, StoreConfig> = { ...(globalConfig.stores ?? {}), ...config.stores };
  const rootCache = new Map<string, string>();
  const out: ResolvedLink[] = [];

  for (const entry of config.shared_paths) {
    const tail = typeof entry === "string" ? entry : entry.path;
    const storeName = typeof entry === "string" ? undefined : entry.store;
    let source: string;
    if (!storeName) {
      source = globalProjectFile(projectName, tail);
    } else {
      let root = rootCache.get(storeName);
      if (root === undefined) {
        root = await resolveStoreRoot(storeName, stores);
        rootCache.set(storeName, root);
      }
      source = path.join(root, tail);
    }
    const glob = parseGlob(tail);
    if (!glob) {
      out.push({ tail, source, sprout: !storeName });
      continue;
    }
    // `source` ends with the literal `*` segment — its dirname is the container.
    out.push(...(await expandGlob(glob, path.dirname(source), !storeName)));
  }
  return out;
}

/**
 * A glob tail is `<dir>/*` — `*` is allowed only as the whole final segment.
 * Returns the container tail, or null when the entry is a plain path. Anything
 * else containing `*` is a config mistake worth naming.
 */
function parseGlob(tail: string): string | null {
  const segments = tail.split("/");
  const last = segments[segments.length - 1];
  const isGlob = last === "*" && segments.length > 1;
  if (!isGlob && tail.includes("*")) {
    throw new WormError(`Unsupported wildcard in shared_paths entry "${tail}".`, {
      hint: 'Only a trailing "/*" is supported, e.g. ".claude/skills/*" — it links each child of that directory.',
    });
  }
  return isGlob ? segments.slice(0, -1).join("/") : null;
}

/**
 * Expand a `<dir>/*` entry into one link per direct child of the store's
 * directory. Dot-prefixed children are skipped (as a shell `*` would), which
 * also keeps `.DS_Store` and sync databases out of the slots. Children never
 * sprout — they exist by construction — but a missing PROFILE container is
 * sprouted as an empty dir so it's obvious where to drop new entries.
 */
async function expandGlob(
  containerTail: string,
  containerSource: string,
  isProfile: boolean
): Promise<ResolvedLink[]> {
  let names: string[];
  try {
    names = await fs.readdir(containerSource);
  } catch {
    // Missing container: sprout it in the profile, and expand to nothing either
    // way (worm must never fabricate content inside an external store).
    if (isProfile) await ensureDir(containerSource);
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({
      tail: `${containerTail}/${name}`,
      source: path.join(containerSource, name),
      sprout: false,
    }));
}

async function resolveStoreRoot(
  storeName: string,
  stores: Record<string, StoreConfig>
): Promise<string> {
  const def = stores[storeName];
  if (!def) {
    throw new WormError(`Unknown store "${storeName}" referenced in shared_paths.`, {
      hint: `Declare it under "stores" in this project's config or ~/.worm/config.json.`,
    });
  }
  const root = expandHome(def.root);
  if (await pathExists(root)) return root;
  if (def.url) {
    logger.info(
      `📦 store ${logger.bold(storeName)}: cloning ${logger.dim(def.url)} → ${logger.dim(root)}`
    );
    await ensureDir(path.dirname(root));
    await runOrThrow(
      "git",
      ["clone", def.url, root],
      {},
      `Failed to clone store "${storeName}" from ${def.url}`
    );
    return root;
  }
  throw new WormError(`Store "${storeName}" root not found: ${root}`, {
    hint: `Create or clone it there, or add a "url" to the store so worm can clone it for you.`,
  });
}

/** Expand a leading `~` to the home dir; otherwise resolve to absolute. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
