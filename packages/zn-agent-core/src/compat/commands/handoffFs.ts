/**
 * Re-export opencc vendor handoff fs utilities for zai consumption.
 *
 * These are pure fs helpers (root: string) with no ToolUseContext dependency,
 * so they can be reused directly from zai without compat-shimming the
 * opencc handler. The vendor handler itself depends on ToolUseContext and
 * is NOT reused — zai implements its own handler.
 */
export {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../../opencc-src/commands/handoff/handoff.js'