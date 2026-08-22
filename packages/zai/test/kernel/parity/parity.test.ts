/**
 * Parity Harness — B6 T6.1 主测试。
 *
 * 跑全部 scenario，双轨各一遍，断言：
 * 1. 11 组 ServerEvent 全部覆盖
 * 2. 所有 scenario verdict ∈ {pair, known}（不允许未登记的 diverged）
 * 3. 双轨适配器都能产出事件
 * 4. 报告格式合法
 */

import { describe, it, expect } from 'vitest'
import {
  runParity,
  makeMockTrackAdapter,
  classifyEventType,
  normalizeEvent,
  groupByType,
  normalizeGroup,
  SERVER_EVENT_GROUPS,
  KNOWN_DIFFERENCES,
  type Scenario,
} from './harness.js'
import { ALL_SCENARIOS } from './scenarios.js'
import {
  formatReport,
  assertGroupsCovered,
  assertAllParity,
  flattenDiffs,
} from './report.js'

describe('parity harness — 分类与归一化', () => {
  it('classifyEventType: 11 组映射正确', () => {
    expect(classifyEventType('runtime.started')).toBe('Runtime')
    expect(classifyEventType('session.created')).toBe('Session')
    expect(classifyEventType('session/projection')).toBe('Projection')
    expect(classifyEventType('job.started')).toBe('Job')
    expect(classifyEventType('prompt.ask')).toBe('Prompt')
    expect(classifyEventType('system.restarting')).toBe('System')
    expect(classifyEventType('state.cwd.changed')).toBe('State')
    expect(classifyEventType('instance.changed')).toBe('Instance')
    expect(classifyEventType('queue.changed')).toBe('Queue')
    expect(classifyEventType('command.run')).toBe('Command')
    expect(classifyEventType('stream/error')).toBe('StreamError')
    expect(classifyEventType('toast')).toBe('System')
    expect(classifyEventType('server.connected')).toBe('System')
    expect(classifyEventType('app.update.checking')).toBe('System')
  })

  it('normalizeEvent: 剔除 ts / eventId / seq', () => {
    const e = {
      type: 'runtime.started',
      sessionId: 's-1',
      turnIndex: 0,
      eventId: 'evt-1',
      ts: 1234,
      seq: 1,
    } as any
    const n = normalizeEvent(e)
    expect(n.eventId).toBeUndefined()
    expect(n.ts).toBeUndefined()
    expect(n.seq).toBeUndefined()
    expect(n.type).toBe('runtime.started')
    expect(n.sessionId).toBe('s-1')
  })

  it('groupByType: 按 11 组归类', () => {
    const events = [
      { type: 'runtime.started' },
      { type: 'runtime.delta' },
      { type: 'job.started' },
      { type: 'prompt.ask' },
    ] as any
    const m = groupByType(events)
    expect(m.get('Runtime')?.length).toBe(2)
    expect(m.get('Job')?.length).toBe(1)
    expect(m.get('Prompt')?.length).toBe(1)
  })

  it('normalizeGroup: 返回全 11 组（含空组）', () => {
    const events = [{ type: 'runtime.started' }] as any
    const m = normalizeGroup(events)
    expect(m.size).toBe(SERVER_EVENT_GROUPS.length)
    for (const g of SERVER_EVENT_GROUPS) {
      expect(m.has(g)).toBe(true)
    }
  })

  it('KNOWN_DIFFERENCES 至少 4 条（dsh-001~dsh-008）', () => {
    expect(Object.keys(KNOWN_DIFFERENCES).length).toBeGreaterThanOrEqual(4)
  })
})

describe('parity harness — 双轨场景', () => {
  const openccAdapter = makeMockTrackAdapter('opencc')
  const dshAdapter = makeMockTrackAdapter('dsh')

  const reports = ALL_SCENARIOS.map((s) =>
    runParity(s, openccAdapter, dshAdapter),
  )

  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id}: 双轨各跑一遍 + 归一化`, () => {
      const report = runParity(scenario, openccAdapter, dshAdapter)
      // 报告结构合法
      expect(report.scenarioId).toBe(scenario.id)
      expect(report.diff.length).toBeGreaterThan(0)
      // verdict ∈ {pair, known, diverged}
      expect(['pair', 'known', 'diverged']).toContain(report.verdict)
    })
  }

  it('全部 scenario 跑完生成非空报告', () => {
    const text = formatReport(reports)
    expect(text).toContain('# Parity Harness Report')
    expect(text).toContain('Summary')
    expect(text.length).toBeGreaterThan(200)
  })

  it('11 组 ServerEvent 全部覆盖（每组至少 1 个 scenario 产出事件）', () => {
    expect(() => assertGroupsCovered(reports)).not.toThrow()
  })

  it('全部 scenario verdict ∈ {pair, known}（无未登记 diverged）', () => {
    expect(() => assertAllParity(reports)).not.toThrow()
  })

  it('flattenDiffs 只列非 pair 行，便于人工审核', () => {
    const diffs = flattenDiffs(reports)
    // 每个 diff 都是已知差异（verdict !== 'pair'）
    for (const d of diffs) {
      expect(['known', 'diverged']).toContain(d.diff.verdict)
    }
  })
})

describe('parity harness — 报告渲染', () => {
  it('单 scenario 报告含必要列', () => {
    const scenario: Scenario = ALL_SCENARIOS[0]
    const report = runParity(scenario, makeMockTrackAdapter('opencc'), makeMockTrackAdapter('dsh'))
    const text = formatReport([report])
    expect(text).toContain(scenario.id)
    expect(text).toContain(scenario.name)
    expect(text).toContain('Verdict')
    expect(text).toContain('| Group |')
  })
})