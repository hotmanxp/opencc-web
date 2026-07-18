import { describe, expect, test } from 'vitest'
import { parseSkillResource } from '../../src/mcp/SkillResourceAdapter.js'

describe('parseSkillResource', () => {
  const validBlob = Buffer.from(
    '---\nname: code-review\ndescription: Review code changes\n---\n\n## Steps\n...'
  ).toString('base64')

  test('parses valid skill resource', () => {
    const skill = parseSkillResource(
      { uri: 'skill://code-review', mimeType: 'text/markdown', blob: validBlob },
      'github'
    )
    expect(skill).toEqual({
      name: 'code-review',
      description: 'Review code changes',
      body: '## Steps\n...',
      source: 'mcp',
      mcpInfo: { serverName: 'github', resourceUri: 'skill://code-review' },
    })
  })

  test('returns null on missing frontmatter', () => {
    const blob = Buffer.from('No frontmatter here').toString('base64')
    const skill = parseSkillResource(
      { uri: 'skill://x', mimeType: 'text/markdown', blob },
      'github'
    )
    expect(skill).toBeNull()
  })

  test('returns null on malformed blob', () => {
    const skill = parseSkillResource(
      { uri: 'skill://x', mimeType: 'text/markdown', blob: 'not-base64!' },
      'github'
    )
    expect(skill).toBeNull()
  })
})
