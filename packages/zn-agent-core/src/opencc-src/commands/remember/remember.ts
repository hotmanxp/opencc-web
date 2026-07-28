import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { LocalCommandResult } from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
type MemoryType = (typeof MEMORY_TYPES)[number]

function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

/**
 * Get memory directory path based on memory type.
 * - user/feedback/reference → user-level (~/.claude/memory/)
 * - project → project-level (getAutoMemPath)
 */
function getMemoryDir(type: MemoryType): string {
  if (type === 'project') {
    return getAutoMemPath()
  }
  // user, feedback, reference → user-level memory
  return join(getClaudeConfigHomeDir(), 'memory')
}

export async function call(
  args: string,
  _context: ToolUseContext,
): Promise<LocalCommandResult> {
  // Parse: /remember [type] <content> or /remember <content>
  const parts = args.trim().split(/\s+/)

  let type: MemoryType = 'user'
  let content: string

  if (parts.length > 1 && isMemoryType(parts[0])) {
    type = parts[0]
    content = parts.slice(1).join(' ')
  } else {
    content = args.trim()
  }

  if (!content) {
    return {
      type: 'text',
      value:
        'Usage: /remember [user|feedback|project|reference] <content>\n\nExample: /remember user "This is my memory content"',
    }
  }

  const memoryDir = getMemoryDir(type)

  // Create memory directory if it doesn't exist
  await mkdir(memoryDir, { recursive: true })

  // Generate filename from first 50 chars of content (sanitized)
  const slug = content
    .slice(0, 50)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const filename = `${slug}-${Date.now()}.md`

  // Build frontmatter
  const description = content.slice(0, 100).replace(/\n/g, ' ').trim()
  const frontmatter = `---
description: ${description}
type: ${type}
---

${content}`

  const filePath = join(memoryDir, filename)
  await writeFile(filePath, frontmatter, 'utf-8')

  return {
    type: 'text',
    value: `Saved to memory:
${filePath}

Type: ${type}
Description: ${description}`,
  }
}
