/**
 * Tool-spec matching for agent `tools` / `disallowedTools` lists.
 *
 * Lives apart from `agentToolUtils.ts` so the matching rule can be unit-tested
 * without importing the tool implementations (BashTool and friends pull native
 * shims that do not load under vitest).
 *
 * @module
 */

/** The subset of `Tool` this module reads. */
export type NamedTool = { name: string }

/**
 * Whether one agent tool spec selects `tool`.
 *
 * Three forms are supported:
 * - an exact tool name (`Bash`, `mcp__cua-driver__click`);
 * - a bare prefix wildcard ending in `*` (`mcp__cua-driver__*`) matching every
 *   tool whose name starts with the prefix. Lets an agent allowlist a whole MCP
 *   server whose catalog is discovered at runtime and may change upstream,
 *   without editing the agent definition each time;
 * - `*` alone, which the caller handles before reaching here as "all tools".
 *
 * @param toolSpec - the spec from the agent definition, after permission-rule
 *   parsing has stripped any `(...)` content.
 * @param tool - a candidate tool, normally already filtered by the disallow
 *   list and the sub-agent restrictions.
 * @returns whether the spec selects the tool.
 */
export function toolSpecMatches(toolSpec: string, tool: NamedTool): boolean {
  if (!toolSpec.endsWith('*')) return toolSpec === tool.name
  return tool.name.startsWith(toolSpec.slice(0, -1))
}

/**
 * Whether a spec is a prefix wildcard rather than an exact name.
 * `*` alone is the caller's all-tools sentinel and is not a prefix wildcard.
 *
 * @param toolSpec - the spec to classify.
 * @returns whether the spec should be expanded against the available pool.
 */
export function isPrefixWildcard(toolSpec: string): boolean {
  return toolSpec.length > 1 && toolSpec.endsWith('*')
}