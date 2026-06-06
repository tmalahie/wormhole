import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import { runOrThrow } from "../utils/exec.js";
import { ensureDir, pathExists } from "../utils/fs.js";
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
 */
export async function resolveStoreLinks(config: Config, projectName: string): Promise<ResolvedLink[]> {
  const globalConfig = await loadGlobalConfig();
  const stores: Record<string, StoreConfig> = { ...(globalConfig.stores ?? {}), ...config.stores };
  const rootCache = new Map<string, string>();
  const out: ResolvedLink[] = [];

  for (const entry of config.shared_paths) {
    const tail = typeof entry === "string" ? entry : entry.path;
    const storeName = typeof entry === "string" ? undefined : entry.store;
    if (!storeName) {
      out.push({ tail, source: globalProjectFile(projectName, tail), sprout: true });
      continue;
    }
    let root = rootCache.get(storeName);
    if (root === undefined) {
      root = await resolveStoreRoot(storeName, stores);
      rootCache.set(storeName, root);
    }
    out.push({ tail, source: path.join(root, tail), sprout: false });
  }
  return out;
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
