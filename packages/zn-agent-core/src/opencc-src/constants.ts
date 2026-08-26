/**
 * Centralized constants for hardcoded file and directory names.
 *
 * These values appear frequently throughout the codebase.
 * Import from here instead of hardcoding to ensure consistency.
 */

// ---------------------------------------------------------------------------
// Brand (re-exported from product.ts for centralized access)
// ---------------------------------------------------------------------------

export { BRAND_NAME } from './constants/product.js'

// ---------------------------------------------------------------------------
// Config directory names
// ---------------------------------------------------------------------------

/** Project-level config directory name (dot-prefixed) */
export const CONFIG_DIRNAME = '.zai'

/** User-level config directory name (dot-prefixed, inside home directory) */
export const USER_CONFIG_DIRNAME = '.zai'

// ---------------------------------------------------------------------------
// Settings files
// ---------------------------------------------------------------------------

/** Project-level shared settings file */
export const SETTINGS_FILENAME = 'settings.json'

/** Project-level local (gitignored) settings file */
export const SETTINGS_LOCAL_FILENAME = 'settings.local.json'

/** Full project settings path: .zai/settings.json */
export const SETTINGS_PATH = `${CONFIG_DIRNAME}/${SETTINGS_FILENAME}`

/** Full project local settings path: .zai/settings.local.json */
export const SETTINGS_LOCAL_PATH = `${CONFIG_DIRNAME}/${SETTINGS_LOCAL_FILENAME}`

/** Full user-level settings path: ~/.zai/settings.json */
export const USER_SETTINGS_PATH = `~/${USER_CONFIG_DIRNAME}/${SETTINGS_FILENAME}`

// ---------------------------------------------------------------------------
// Sub-directories
// ---------------------------------------------------------------------------

/** Skills directory: .zai/skills/ */
export const SKILLS_DIRNAME = 'skills'
export const SKILLS_PATH = `${CONFIG_DIRNAME}/${SKILLS_DIRNAME}`

/** Loop markdown file: .zai/loop.md */
export const LOOP_FILENAME = 'loop.md'
export const LOOP_PATH = `${CONFIG_DIRNAME}/${LOOP_FILENAME}`

/** Agent definitions directory: .zai/agents/ */
export const AGENTS_DIRNAME = 'agents'
export const AGENTS_PATH = `${CONFIG_DIRNAME}/${AGENTS_DIRNAME}`

/** Wiki directory: .zai/wiki/ */
export const WIKI_DIRNAME = 'wiki'
export const WIKI_PATH = `${CONFIG_DIRNAME}/${WIKI_DIRNAME}`

/** Plugin manifest directory name (no leading dot — used as path segment) */
export const PLUGIN_DIRNAME = '.claude-plugin'

/** Plugin manifest file: .claude-plugin/plugin.json */
export const PLUGIN_MANIFEST_FILENAME = 'plugin.json'
export const PLUGIN_MANIFEST_PATH = `${PLUGIN_DIRNAME}/${PLUGIN_MANIFEST_FILENAME}`

/** Marketplace cache directory name */
export const MARKETPLACE_CACHE_DIRNAME = '.claude-marketplaces'

// ---------------------------------------------------------------------------
// Other dotfiles
// ---------------------------------------------------------------------------

/** Bash history file */
export const BASH_LOG_FILENAME = 'bash-log.txt'
export const BASH_LOG_PATH = `~/${USER_CONFIG_DIRNAME}/${BASH_LOG_FILENAME}`

/** Keybindings file */
export const KEYBINDINGS_FILENAME = 'keybindings.json'
export const KEYBINDINGS_PATH = `~/${USER_CONFIG_DIRNAME}/${KEYBINDINGS_FILENAME}`

/** Agent instructions file (project-level) */
export const AGENTS_INSTRUCTIONS_FILENAME = 'AGENTS.md'

/** Agent instructions file (local overrides) */
export const AGENTS_INSTRUCTIONS_LOCAL_FILENAME = 'AGENTS.local.md'

/** Alias for AGENTS_INSTRUCTIONS_FILENAME (used in some import sites) */
export const AGENTS_FILENAME = AGENTS_INSTRUCTIONS_FILENAME

/** Profile config file */
export const PROFILE_FILENAME = '.claude-profile.json'

/** Hook chain file */
export const HOOKS_FILENAME = 'hooks.json'
