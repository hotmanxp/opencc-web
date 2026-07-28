import { describe, expect, test } from 'bun:test'
import { DESCRIPTION } from './prompt.js'
import { FileReadTool } from './FileReadTool.js'

describe('FileReadTool prompt', () => {
  test('DESCRIPTION matches upstream 2.1.177 canonical text', () => {
    expect(DESCRIPTION).toBe(
      'Reads a file from the local filesystem. You can access any file directly by using this tool.',
    )
  })

  test('runtime description() returns the new text (catches inline-literal drift)', async () => {
    const desc = await (
      FileReadTool.description as unknown as () => Promise<string>
    )()
    expect(desc).toBe(
      'Reads a file from the local filesystem. You can access any file directly by using this tool.',
    )
  })
})
