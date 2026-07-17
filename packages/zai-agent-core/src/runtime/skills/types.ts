export type SkillFrontmatter = {
  name?: string
  description?: string
  when_to_use?: string
  version?: string
  model?: string
  'disable-model-invocation'?: boolean
  'user-invocable'?: boolean
  'allowed-tools'?: string[]
  'argument-hint'?: string
  arguments?: string | string[]
  context?: 'fork'
  agent?: string
  effort?: string | number
  shell?: string
  hooks?: Record<string, unknown>
  paths?: string | string[]
  [k: string]: unknown
}

/**
 * A skill loaded from a known source.
 *
 * Disk-loaded skills fill `baseDir`, `filePath`, `frontmatter`, `markdown`,
 * and `sourceIndex`. Skills loaded from an MCP server (see `loadMcpSkills`)
 * fill `description`, `body`, and `mcpInfo` instead. Both shapes share `name`
 * and the optional `source` discriminator.
 */
export type LoadedSkill = {
  name: string
  /** Present for disk-loaded skills. */
  baseDir?: string
  /** Present for disk-loaded skills. */
  filePath?: string
  /** Present for disk-loaded skills. */
  frontmatter?: SkillFrontmatter
  /** Present for disk-loaded skills. */
  markdown?: string
  /** Present for disk-loaded skills. */
  sourceIndex?: number
  /** Top-level description (set for MCP-loaded skills; disk skills use frontmatter.description). */
  description?: string
  /** Top-level body text (set for MCP-loaded skills; disk skills use markdown). */
  body?: string
  /** Skill source. Defaults to 'disk' for skills loaded from the filesystem. */
  source?: 'disk' | 'mcp' | 'plugin'
  /**
   * Plugin discriminator — `'skill'` for SKILL.md files loaded from a plugin
   * directory, `'command'` for slash-command manifests. Omit for non-plugin
   * skills to keep the original disk/MCP semantics intact.
   */
  kind?: 'skill' | 'command'
  /** Owning plugin id; present only when `source === 'plugin'`. */
  pluginId?: string
  /** MCP metadata — present only for skills loaded from an MCP server. */
  mcpInfo?: { serverName: string; resourceUri: string }
}

export type PendingSkillInjection = {
  skillName: string
  content: string
}
