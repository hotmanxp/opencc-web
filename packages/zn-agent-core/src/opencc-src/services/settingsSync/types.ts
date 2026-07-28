/**
 * Settings Sync Types
 *
 * Zod schemas and types for the user settings sync API.
 * Based on the backend API contract from anthropic/anthropic#218817.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { USER_SETTINGS_PATH } from '../../constants.js'
import { AGENT_INSTRUCTIONS_FILE, AGENT_INSTRUCTIONS_LOCAL_FILE } from '../../constants/product.js'

/**
 * Content portion of user sync data - flat key-value storage.
 * Keys are opaque strings (typically file paths).
 * Values are UTF-8 string content (JSON, Markdown, etc).
 */
export const UserSyncContentSchema = lazySchema(() =>
  z.object({
    entries: z.record(z.string(), z.string()),
  }),
)

/**
 * Full response from GET /api/claude_code/user_settings
 */
export const UserSyncDataSchema = lazySchema(() =>
  z.object({
    userId: z.string(),
    version: z.number(),
    lastModified: z.string(), // ISO 8601 timestamp
    checksum: z.string(), // MD5 hash
    content: UserSyncContentSchema(),
  }),
)

export type UserSyncData = z.infer<ReturnType<typeof UserSyncDataSchema>>

/**
 * Result from fetching user settings
 */
export type SettingsSyncFetchResult = {
  success: boolean
  data?: UserSyncData
  isEmpty?: boolean // true if 404 (no data exists)
  error?: string
  skipRetry?: boolean
}

/**
 * Result from uploading user settings
 */
export type SettingsSyncUploadResult = {
  success: boolean
  checksum?: string
  lastModified?: string
  error?: string
}

/**
 * Keys used for sync entries
 */
export const SYNC_KEYS = {
  USER_SETTINGS: USER_SETTINGS_PATH,
  USER_MEMORY: `~/.claude/${AGENT_INSTRUCTIONS_FILE}`,
  projectSettings: (projectId: string) =>
    `projects/${projectId}/.claude/settings.local.json`,
  projectMemory: (projectId: string) => `projects/${projectId}/${AGENT_INSTRUCTIONS_LOCAL_FILE}`,
} as const
