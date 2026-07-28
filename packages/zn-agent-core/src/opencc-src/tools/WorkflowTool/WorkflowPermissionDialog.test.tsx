// @ts-nocheck
import { existsSync, readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { describe, expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { analyzeScript } from './staticAnalyzer.js'
import type { ScriptAnalysis } from './staticAnalyzer.js'
import { WorkflowPermissionDialog } from './WorkflowPermissionDialog.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, getOutput: () => output }
}

async function renderAndExtract(
  element: React.ReactElement,
): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(element)

  // Wait for a frame containing the dialog title — guarantees React has
  // flushed at least one paint.
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2500) {
    const frame = stripAnsi(extractLastFrame(getOutput()))
    if (frame.includes('Run a dynamic workflow?')) {
      root.unmount()
      stdin.end()
      stdout.end()
      return frame
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  root.unmount()
  stdin.end()
  stdout.end()
  throw new Error('Timed out waiting for WorkflowPermissionDialog output')
}

describe('WorkflowPermissionDialog', () => {
  test('renders meta description + phases from script analysis', async () => {
    const script = `
async function userScript() {
  await parallel([
    () => agent("search1"),
    () => agent("search2"),
  ]);
  await agent("verify");
}
`
    const analysis = analyzeScript(script)
    const out = await renderAndExtract(
      <WorkflowPermissionDialog
        workflowName="my-wf"
        description="A test workflow"
        analysis={analysis}
        script={script}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(out).toContain('Run a dynamic workflow?')
    expect(out).toContain('my-wf')
    expect(out).toContain('A test workflow')
    expect(out).toMatch(/parallel/)
    expect(out).toMatch(/sequential/)
  })

  test('shows estimated agent count', async () => {
    const analysis: ScriptAnalysis = {
      phases: [
        {
          kind: 'parallel',
          agents: [{ prompt: '' }, { prompt: '' }],
          annotation: '×2',
        },
      ],
      estimatedAgents: 6,
      hasReturn: true,
    }
    const out = await renderAndExtract(
      <WorkflowPermissionDialog
        workflowName="x"
        description=""
        analysis={analysis}
        script=""
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(out).toMatch(/6.*agents?/i)
  })

  test('is registered in PermissionRequest dispatch for WorkflowTool', () => {
    // The dispatch in src/components/permissions/PermissionRequest.tsx
    // routes each Tool class to a permission component. We assert that
    // the WorkflowTool case (or a case keyed on its tool name) routes
    // to WorkflowPermissionDialog — and that the old WorkflowPermissionRequest
    // is no longer referenced.
    const dispatchPath = join(
      __dirname,
      '..',
      '..',
      'components',
      'permissions',
      'PermissionRequest.tsx',
    )
    expect(existsSync(dispatchPath)).toBe(true)
    const content = readFileSync(dispatchPath, 'utf-8')

    // Either: a `case WorkflowTool:` switch that returns WorkflowPermissionDialog,
    // or a string-keyed `case 'WorkflowTool':` switch that does the same.
    // We accept both shapes by allowing the dialog name anywhere within ~250
    // chars of any reference to WorkflowTool.
    expect(content).toMatch(/WorkflowTool[\s\S]{0,300}WorkflowPermissionDialog/)
    expect(content).not.toMatch(/WorkflowPermissionRequest/)
  })
})