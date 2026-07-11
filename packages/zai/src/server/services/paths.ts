import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Centralized path constants for zai's persistent data directory.
 *
 * Layout:
 *   ~/.zai/
 *   ├── manifest.json
 *   └── zn-assets/
 *       ├── 1.2.3/                          (cached @zn-ai/plugin v1.2.3)
 *       │   ├── agents/<name>/...
 *       │   ├── commands/<name>.toml
 *       │   ├── skills/<name>/...
 *       │   └── extensions/<name>/...
 *       └── 1.3.0/
 *           └── ...
 *
 * The flat layout (no `extracted/@zn-ai/plugin/assets/` chain) makes
 * the directory scannable from a shell and matches what the user
 * types when debugging — `ls ~/.zai/zn-assets/`.
 */
export const ZAI_DIR = join(homedir(), '.zai');
export const ZN_ASSETS_DIR = join(ZAI_DIR, 'zn-assets');
export const PLUGIN_PKG = '@zn-ai/plugin';

/** ~/.zai/zn-assets/<version> */
export function versionDir(version: string): string {
  return join(ZN_ASSETS_DIR, version);
}

/** ~/.zai/zn-assets/<version>/<type> */
export function resourceTypeDir(version: string, type: string): string {
  return join(versionDir(version), type);
}