import { describe, expect, test } from 'bun:test'
import { DESCRIPTION } from './prompt.ts'
import { FileWriteTool } from './FileWriteTool.ts'

describe('FileWriteTool prompt', () => {
  test('DESCRIPTION matches upstream 2.1.177 canonical text', () => {
    expect(DESCRIPTION).toBe(
      'Writes a file to the local filesystem, overwriting if one exists.',
    )
  })

  test('runtime description() returns the new text (catches inline-literal drift)', async () => {
    const desc = await (
      FileWriteTool.description as unknown as () => Promise<string>
    )()
    expect(desc).toBe(
      'Writes a file to the local filesystem, overwriting if one exists.',
    )
  })
})
