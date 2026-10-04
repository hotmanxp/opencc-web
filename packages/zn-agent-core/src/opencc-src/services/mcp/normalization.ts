/**
 * Pure utility functions for MCP name normalization.
 * This file has no dependencies to avoid circular imports.
 */

// Claude.ai server names are prefixed with this string
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Replaces any invalid characters (including dots and spaces) with underscores.
 *
 * For claude.ai servers (names starting with "claude.ai "), also collapses
 * consecutive underscores and strips leading/trailing underscores to prevent
 * interference with the __ delimiter used in MCP tool names.
 */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}

/**
 * Match servers by name, retrying on the normalized form when no exact hit.
 * A model that writes "my server" or "my.server" for a server configured as
 * "my_server" should still reach it instead of getting "not found".
 */
export function findServersByName<T extends { name: string }>(
  servers: T[],
  name: string,
): T[] {
  const exact = servers.filter(server => server.name === name)
  if (exact.length > 0) return exact
  const normalized = normalizeNameForMCP(name)
  return servers.filter(
    server => normalizeNameForMCP(server.name) === normalized,
  )
}
