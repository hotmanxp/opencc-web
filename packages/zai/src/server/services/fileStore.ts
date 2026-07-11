import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigFile, ConfigTool } from '../../shared/types.js';

const CONFIG_PATHS: Record<ConfigTool, () => string> = {
  nova: () => join(homedir(), '.nova', 'settings.json'),
  opencode: () => join(homedir(), '.config', 'opencode', 'opencode.json'),
  opencc: () => join(homedir(), '.claude', 'settings.json'),
};

export async function readConfig(tool: ConfigTool): Promise<ConfigFile> {
  const path = CONFIG_PATHS[tool]();
  try {
    const raw = await readFile(path, 'utf-8');
    return { path, exists: true, content: JSON.parse(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: {}, missing: true };
    }
    throw err;
  }
}

export async function writeConfig(
  tool: ConfigTool,
  content: Record<string, unknown>,
): Promise<{ ok: true }> {
  const path = CONFIG_PATHS[tool]();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
  await rename(tmpPath, path);
  return { ok: true };
}
