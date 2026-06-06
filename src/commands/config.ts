import { logger } from "../utils/logger.js";
import { WormError } from "../utils/errors.js";
import {
  GlobalConfigSchema,
  loadGlobalConfig,
  saveGlobalConfig,
  SUPPORTED_GLOBAL_KEYS,
  type GlobalConfig,
  type ScalarGlobalKey,
} from "../core/global-config.js";

export interface ConfigOptions {
  list?: boolean;
  unset?: boolean;
}

export async function runConfig(
  key: string | undefined,
  value: string | undefined,
  options: ConfigOptions = {}
): Promise<void> {
  const config = await loadGlobalConfig();

  if (options.list) {
    if (key !== undefined) {
      throw new WormError("`worm config --list` takes no arguments.");
    }
    const entries = Object.entries(config);
    if (entries.length === 0) {
      logger.raw("(empty)");
    } else {
      for (const [k, v] of entries) logger.raw(`${k} = ${v}`);
    }
    return;
  }

  if (!key) {
    throw new WormError("Missing key.", {
      hint: `Usage: worm config <key> [value]. Known keys: ${SUPPORTED_GLOBAL_KEYS.join(", ")}.`,
    });
  }

  assertKnownKey(key);

  if (options.unset) {
    if (value !== undefined) {
      throw new WormError("`worm config --unset <key>` takes no value.");
    }
    const next = { ...config };
    delete next[key];
    await saveGlobalConfig(next);
    logger.success(`Cleared ${key}.`);
    return;
  }

  if (value === undefined) {
    const current = config[key];
    if (current === undefined) {
      logger.raw("(unset)");
    } else {
      logger.raw(current);
    }
    return;
  }

  const next: GlobalConfig = { ...config, [key]: value };
  GlobalConfigSchema.parse(next);
  await saveGlobalConfig(next);
  logger.success(`Set ${key} = ${value}.`);
}

function assertKnownKey(key: string): asserts key is ScalarGlobalKey {
  if (!(SUPPORTED_GLOBAL_KEYS as readonly string[]).includes(key)) {
    throw new WormError(`Unknown config key: ${key}.`, {
      hint: `Known keys: ${SUPPORTED_GLOBAL_KEYS.join(", ")}. (shared_paths is edited in ~/.worm/config.json directly.)`,
    });
  }
}
