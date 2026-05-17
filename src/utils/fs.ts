import { promises as fs } from "node:fs";
import path from "node:path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

export async function writeTextIfMissing(p: string, contents: string): Promise<boolean> {
  if (await pathExists(p)) return false;
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, contents, "utf8");
  return true;
}

export async function readSymlinkTarget(p: string): Promise<string | null> {
  try {
    return await fs.readlink(p);
  } catch {
    return null;
  }
}

export { fs };
