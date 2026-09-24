import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join as pathJoin } from 'path'

// Same constraint as prompts.upstream252.test.ts: src/opencc-src/** is excluded
// from runtime import in the vitest config, so the assertions read the vendored
// source directly. The intent here is to pin all three halves of the 2.1.280
// NotebookEdit decision: the tool must not reach the model, the REPL must not
// expose it either, and the implementation must stay on disk.

const VENDOR = pathJoin(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src',
  'opencc-src',
)
const read = (...parts: string[]) =>
  readFileSync(pathJoin(VENDOR, ...parts), 'utf8')

describe('NotebookEdit is deregistered in the vendored tree', () => {
  it('tools.ts does not register it in getAllBaseTools()', () => {
    const src = read('tools.ts')
    // no active import — only the commented-out zai line remains
    expect(src).not.toMatch(/^import \{ NotebookEditTool \}/m)
    expect(src).toContain(
      "// import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'",
    )
    // the array entry stays commented out (zai web has no Jupyter editing)
    expect(src).toContain('// NotebookEditTool,')
  })

  it('the REPL primitive pool does not expose it', () => {
    const src = read('tools', 'REPLTool', 'primitiveTools.ts')
    expect(src).not.toContain("from '../NotebookEditTool/NotebookEditTool.js'")
    expect(src).not.toContain('    NotebookEditTool,\n')
  })

  it('FileEditTool refuses .ipynb with the unavailability message', () => {
    const src = read('tools', 'FileEditTool', 'FileEditTool.ts')
    expect(src).not.toContain('NOTEBOOK_EDIT_TOOL_NAME')
    expect(src).toContain('File is a Jupyter Notebook (.ipynb).')
    expect(src).toContain('Notebook editing is not available in this build')
  })

  it('the implementation is still retained on disk', () => {
    expect(
      existsSync(pathJoin(VENDOR, 'tools', 'NotebookEditTool', 'NotebookEditTool.ts')),
    ).toBe(true)
    expect(
      existsSync(pathJoin(VENDOR, 'tools', 'NotebookEditTool', 'constants.ts')),
    ).toBe(true)
  })
})