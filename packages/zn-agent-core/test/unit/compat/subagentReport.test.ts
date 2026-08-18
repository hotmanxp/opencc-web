import { afterEach, describe, expect, it } from 'vitest'
import {
  subagentReportTool,
  subagentReportOpenccTool,
} from '../../../src/compat/tools/opencc/subagentReport.js'

const FAKE = '__zaiSessionInbox'
const SID = '__zaiCurrentSessionId'

type TestCall = [string, ...unknown[]]
type TestBridge = {
  followup: (...args: unknown[]) => void
  inject: (...args: unknown[]) => void
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FAKE]
  delete (globalThis as Record<string, unknown>)[SID]
})

function installBridge(calls: TestCall[]): void {
  const bridge: TestBridge = {
    followup: (...args) => calls.push(['followup', ...args]),
    inject: (...args) => calls.push(['inject', ...args]),
  }
  ;(globalThis as Record<string, unknown>)[FAKE] = bridge
}

describe('subagent_report', () => {
  it('schema 包含 output 必填 + delivery 枚举', () => {
    expect(subagentReportTool.inputSchema).toBeTruthy()
  })

  it('wakeup → followup 到父 session(优先 context.parentSessionId)', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'fallback-parent'
    const calls: TestCall[] = []
    installBridge(calls)

    const res = await subagentReportTool.execute(
      { output: 'progress', delivery: 'wakeup' },
      { parentSessionId: 'parent-1' },
    )

    expect(res).toEqual({ delivered: true })
    expect(calls[0][0]).toBe('followup')
    expect(calls[0][1]).toBe('parent-1')
    expect(calls[0][2]).toMatchObject({
      content: 'progress',
      source: {
        kind: 'subagent',
        form: 'report',
        senderSessionId: 'fallback-parent',
      },
    })
  })

  it('quiet → inject', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'
    const calls: TestCall[] = []
    installBridge(calls)

    await subagentReportTool.execute({ output: 'note', delivery: 'quiet' }, {})

    expect(calls[0][0]).toBe('inject')
    expect(calls[0][1]).toBe('parent-1')
    expect(calls[0][2]).toMatchObject({ content: 'note' })
  })

  it('无 bridge 不抛,返回 delivered:false', async () => {
    ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'

    const res = await subagentReportTool.execute(
      { output: 'x', delivery: 'wakeup' },
      {},
    )

    expect(res).toEqual({ delivered: false })
  })

  describe('subagentReportOpenccTool(vendor 表面)', () => {
    it('暴露 vendor 请求序列化必需的 prompt()(回归 #668:裸工具塞子代理工具集 → tool.prompt is not a function)', async () => {
      expect(typeof subagentReportOpenccTool.prompt).toBe('function')
      const desc = await (
        subagentReportOpenccTool as {
          prompt: (opts?: unknown) => Promise<string>
        }
      ).prompt({})
      expect(desc).toContain('报告当前子任务的进度或移交结果给父 agent')
    })

    it('name/inputSchema 与裸工具一致', () => {
      expect(subagentReportOpenccTool.name).toBe('subagent_report')
      expect(subagentReportOpenccTool.inputSchema).toBe(
        subagentReportTool.inputSchema,
      )
    })

    it('call 委托裸工具 execute(经 wrapAsOpenccTool 的 {data:} 信封)', async () => {
      ;(globalThis as Record<string, unknown>)[SID] = 'parent-1'
      const calls: TestCall[] = []
      installBridge(calls)

      const res = await (
        subagentReportOpenccTool as {
          call: (args: unknown, ctx: unknown) => Promise<unknown>
        }
      ).call(
        { output: 'wrapped', delivery: 'wakeup' },
        { parentSessionId: 'parent-1' },
      )

      expect(res).toEqual({ data: { delivered: true } })
      expect(calls[0][0]).toBe('followup')
      expect(calls[0][1]).toBe('parent-1')
    })
  })
})
