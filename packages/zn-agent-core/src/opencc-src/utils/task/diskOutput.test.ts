import { afterEach, describe, expect, test } from 'bun:test'
import { unlinkSync } from 'fs'
import {
  getWorkflowReportPath,
  readWorkflowReport,
  writeWorkflowReport,
} from './diskOutput.js'
import type { WorkflowReport } from './diskOutput.js'

// Each test uses a unique taskId so concurrent runs of the same file
// don't collide on the shared temp dir resolved by getProjectTempDir().
// afterEach best-effort removes the files we wrote so the dir stays clean.
const writtenPaths: string[] = []
afterEach(() => {
  for (const p of writtenPaths.splice(0)) {
    try {
      unlinkSync(p)
    } catch {
      // ignore — file may not exist if write failed
    }
  }
})

function uid(): string {
  return `wf_t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

const sample: WorkflowReport = {
  schemaVersion: 1,
  taskId: 'wf_abc',
  workflowName: 'echo',
  description: 'echoes input',
  status: 'completed',
  startedAt: 1000,
  completedAt: 3000,
  durationMs: 2000,
  args: { foo: 'bar' },
  result: 'done',
  agents: [
    { id: 'a1', status: 'completed', prompt: 'hi', result: 'ok' },
    { id: 'a2', status: 'failed', prompt: 'bad', error: 'boom' },
  ],
  summary: { total: 2, completed: 1, failed: 1, skipped: 0 },
}

describe('writeWorkflowReport / readWorkflowReport', () => {
  test('round-trips a report through disk', async () => {
    const taskId = uid()
    const path = getWorkflowReportPath(taskId)
    writtenPaths.push(path)
    await writeWorkflowReport(taskId, sample)
    expect(path.endsWith(`/${taskId}.report.json`)).toBe(true)
    const back = await readWorkflowReport(taskId)
    expect(back).toEqual(sample)
  })

  test('getWorkflowReportPath uses workflows_reports dir under claude home', () => {
    const taskId = uid()
    writtenPaths.push(getWorkflowReportPath(taskId))
    const reportPath = getWorkflowReportPath(taskId)
    // Report lives under claude home/.workflows_reports/, not in the
    // tasks temp dir used for task output files.
    expect(reportPath).toContain('.workflows_reports/')
    expect(reportPath).toContain(`/${taskId}.report.json`)
  })

  test('returns null when no report exists', async () => {
    expect(await readWorkflowReport(uid())).toBeNull()
  })

  test('overwrites existing report on re-write', async () => {
    const taskId = uid()
    writtenPaths.push(getWorkflowReportPath(taskId))
    await writeWorkflowReport(taskId, sample)
    const updated: WorkflowReport = {
      ...sample,
      status: 'failed',
      error: { message: 'x' },
    }
    await writeWorkflowReport(taskId, updated)
    expect((await readWorkflowReport(taskId))?.status).toBe('failed')
  })
})