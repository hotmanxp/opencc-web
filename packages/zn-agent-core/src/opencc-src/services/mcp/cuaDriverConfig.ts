/**
 * Single source of truth for the cua-driver MCP stdio server entry.
 *
 * zai auto-injects this server into the effective MCP list when the user has
 * enabled Computer Use in `~/.zai/settings.json` (or `<cwd>/.zai/settings.json`)
 * and the current process platform is in the configured allow-list (default:
 * darwin). The entry name MUST match `COMPUTER_USE_MCP_SERVER_NAME` so the
 * reserved-name guards in `services/mcp/config.ts` and `main.tsx` reject
 * manual collisions. The stdio subprocess is `cua-driver mcp` — a separately
 * installed binary (e.g. `brew install --cask cua-driver`). zai does not
 * bundle the binary and does not own its lifetime; the MCP client spawns and
 * restarts it through the existing stdio transport.
 *
 * Mirrors deepseek-harness/packages/experimental/computer-use-cua-driver-mcp
 * but without the Cordis `ctx.computerUse.register()` slot (zai has no
 * equivalent capability-seam service yet).
 *
 * @module
 */
import type { ScopedMcpServerConfig } from './types.js'
import { getComputerUseSettings } from '../../utils/settings/types.js'

/** MCP server name as it appears in the effective servers map and in `mcp__<name>__<tool>` tool names. */
export const CUA_DRIVER_SERVER_NAME = 'cua-driver'

/**
 * Whether the cua-driver entry belongs to the "built-in MCP server that
 * defaults to disabled" class (`config.ts` `DEFAULT_DISABLED_BUILTIN`).
 *
 * Always false. That class exists for a server that is *always* present in the
 * effective list and requires an explicit `enabledMcpServers` opt-in;
 * `isMcpServerDisabled()` reports such a name as disabled otherwise. zai
 * injects the cua-driver entry only when the user has already opted in via
 * `settings.computerUse.enabled`, so classifying it as default-disabled would
 * silently skip the subprocess spawn even after successful injection.
 *
 * Exported so the invariant is unit-testable without importing `config.ts`
 * (whose module graph does not load under vitest).
 */
export const CUA_DRIVER_IS_DEFAULT_DISABLED_BUILTIN = false

/**
 * Build the stdio MCP server config for cua-driver, or `null` if Computer
 * Use is disabled / not supported on this platform.
 *
 * `binaryPath` (when set) wins over `command`. We pass it as `command` since
 * the MCP stdio transport takes a single executable path. We do NOT mutate
 * `process.env.PATH` to make the binary discoverable — the user must either
 * install cua-driver on $PATH or set `binaryPath`.
 */
export function getCuaDriverMcpServerConfig():
  | (ScopedMcpServerConfig & { type?: 'stdio' })
  | null {
  const s = getComputerUseSettings()
  if (!s.enabled) return null
  if (!s.platforms.includes(process.platform as 'darwin' | 'linux' | 'win32')) {
    return null
  }
  const command = s.binaryPath ?? s.command
  return {
    type: 'stdio',
    command,
    args: s.args,
    scope: 'user',
  }
}