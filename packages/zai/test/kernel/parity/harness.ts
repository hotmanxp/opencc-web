/**
 * Parity Test Harness — B6 T6.1。
 *
 * 把同一场景脚本分别在「opencc 轨道」和「dsh 轨道」上跑一遍，把产出的
 * ServerEvent 序列归一化（剥离 ts / eventId / seq 等时间戳 + id 差异），
 * 然后逐事件类型做 diff。
 *
 * 设计动机：
 * - 双轨改造的核心承诺是「zai 行为一致」，需要自动化验证。
 * - B1b 阶段的 11 组 ServerEvent 翻译完整度需要客观度量工具。
 * - 任何偏差必须显式标注 — 不能是「我自己看着差不多」的口头结论。
 *
 * 约束：
 * - 不调真实 LLM（避免 mock 链路 + token 成本）。每个 scenario 是手写的
 *   「已知事件序列 + 期望 ServerEvent」，分别在 opencc / dsh 模拟器上跑。
 * - 双轨适配器（OpenccTrackSimulator / DshTrackSimulator）只产出
 *   ServerEvent，不引入真实 vendor/dsh 运行时依赖。
 * - 事件归一化：剔除 ts / eventId / seq（这三项是 id/时间差异，不算语义差异）。
 * - diff 报告：每组事件类型独立行，标注「对等 / 差异 / 已知差异清单条目」。
 */

import type { ServerEvent } from '../../../src/shared/events.js'

// ─── 11 组 ServerEvent 类型常量 ─────────────────────────────────────

/** 主计划 §5 + ServerEvent union 拆分（Runtime/Session/Job/Prompt/System/State/Instance/Queue/Command/StreamError/Projection）。 */
export const SERVER_EVENT_GROUPS = [
  'Runtime',
  'Session',
  'Job',
  'Prompt',
  'System',
  'State',
  'Instance',
  'Queue',
  'Command',
  'StreamError',
  'Projection',
] as const

export type ServerEventGroup = (typeof SERVER_EVENT_GROUPS)[number]

/**
 * 根据 event.type 前缀归到 11 组之一。
 * - runtime.*      → Runtime
 * - session.* (除 session/projection) → Session
 * - job.*          → Job
 * - prompt.*       → Prompt
 * - system.* / server.* / toast / branch.* / app.update.* → System
 * - state.*        → State
 * - instance.*     → Instance
 * - queue.*        → Queue
 * - command.*      → Command
 * - stream/error   → StreamError
 * - session/projection → Projection
 * - weixin.inbound → System (B3 微信适配器)
 */
export function classifyEventType(type: string): ServerEventGroup {
  if (type.startsWith('runtime.')) return 'Runtime'
  if (type === 'session/projection') return 'Projection'
  if (type.startsWith('session.')) return 'Session'
  if (type.startsWith('job.')) return 'Job'
  if (type.startsWith('prompt.')) return 'Prompt'
  if (
    type.startsWith('system.') ||
    type.startsWith('server.') ||
    type === 'toast' ||
    type.startsWith('branch.') ||
    type.startsWith('app.update.') ||
    type === 'weixin.inbound'
  ) {
    return 'System'
  }
  if (type.startsWith('state.')) return 'State'
  if (type.startsWith('instance.')) return 'Instance'
  if (type.startsWith('queue.')) return 'Queue'
  if (type.startsWith('command.')) return 'Command'
  if (type === 'stream/error') return 'StreamError'
  // 兜底：未知类型归到 Runtime（便于发现）
  return 'Runtime'
}

// ─── 归一化 ─────────────────────────────────────────────────────────

/**
 * 事件归一化：剔除 ts / eventId / seq 等「时序 / id 差异」字段，
 * 保留语义字段。归一化后的事件可以按结构比对。
 */
export function normalizeEvent(event: ServerEvent): Record<string, unknown> {
  // 浅拷贝后删字段 — 不递归，便于人工核对
  const e = { ...event } as Record<string, unknown>
  delete e.eventId
  delete e.ts
  delete e.seq
  // turnIndex 是「单 session 内」的序号，parity 期望双轨一致；但如果场景不固定
  // turn 起点，也允许归一化（默认保留）。给配置项 hook。
  return e
}

/**
 * 序列归一化：每个事件去 ts/eventId/seq，按 type 分组得到 Map<group, events[]>。
 */
export function groupByType(
  events: readonly ServerEvent[],
): Map<string, ServerEvent[]> {
  const m = new Map<string, ServerEvent[]>()
  for (const e of events) {
    const key = classifyEventType(e.type)
    if (!m.has(key)) m.set(key, [])
    m.get(key)!.push(e)
  }
  return m
}

/**
 * 序列归一化（按 group）：每组内部按事件类型列表（normalize 后）。
 */
export function normalizeGroup(
  events: readonly ServerEvent[],
): Map<ServerEventGroup, Array<Record<string, unknown>>> {
  const grouped = groupByType(events)
  const out = new Map<ServerEventGroup, Array<Record<string, unknown>>>()
  for (const group of SERVER_EVENT_GROUPS) {
    const items = grouped.get(group) ?? []
    out.set(group, items.map(normalizeEvent))
  }
  return out
}

// ─── Diff ────────────────────────────────────────────────────────────

export type DiffVerdict = 'pair' | 'diverged' | 'known'

export interface GroupDiff {
  group: ServerEventGroup
  verdict: DiffVerdict
  /** 双轨都见到的事件类型（对等）。 */
  sharedTypes: string[]
  /** 仅 opencc 出现的事件类型。 */
  openccOnly: string[]
  /** 仅 dsh 出现的事件类型。 */
  dshOnly: string[]
  /** 双轨事件数量差异（dsh - opencc）。 */
  countDelta: number
  /** 已知差异条目 ID（与 docs/2026-08-17-dsh-known-differences.md 对齐）。 */
  knownDifferenceIds: string[]
}

export interface ParityReport {
  scenarioId: string
  scenarioName: string
  /** 是否所有 11 组都被覆盖到（B1b T1.5 验收）。 */
  groupsCovered: ServerEventGroup[]
  groupsMissing: ServerEventGroup[]
  diff: GroupDiff[]
  /** 全局 verdict：所有组 pair → 'pair'；否则 'diverged'。 */
  verdict: DiffVerdict
}

// ─── 已知差异清单（与 docs/2026-08-17-dsh-known-differences.md 对齐） ─

/**
 * 已知差异 ID → 涉及的事件类型 + group。
 * 测试时若某 group 出现的差异全部命中已知差异清单，verdict 标 'known'。
 *
 * 当前条目仅包含 B0-B5 已确认的差异（来源于 docs/superpowers/specs/）。
 * B6 阶段会扩充 — 已知差异清单与本常量保持双向引用。
 */
export const KNOWN_DIFFERENCES: Record<
  string,
  { group: ServerEventGroup; events: string[]; description: string }
> = {
  'dsh-001-tool-schema': {
    group: 'Runtime',
    events: ['runtime.tool_call'],
    description: 'dsh 严格 JSON Schema 校验，opencc 容错',
  },
  'dsh-002-event-timing': {
    group: 'Runtime',
    events: ['runtime.started', 'runtime.done'],
    description: 'runtime.started vs runtime.done 时序细节差异',
  },
  'dsh-003-compaction': {
    group: 'Runtime',
    events: ['runtime.compacted'],
    description: 'dsh compaction capability 路径与 opencc 不一致',
  },
  'dsh-004-nested-subagent': {
    group: 'Runtime',
    events: ['runtime.delta'],
    description: '嵌套子 agent 文本流回声',
  },
  'dsh-005-plugin-compat': {
    group: 'System',
    events: ['app.update.checking', 'app.update.installing'],
    description: 'plugin 兼容层缺失事件',
  },
  'dsh-006-version-compat': {
    group: 'System',
    events: ['server.connected'],
    description: 'dsh 版本固定 0.1.0-rc.7 时无 server 升级事件',
  },
  'dsh-007-stream-error': {
    group: 'StreamError',
    events: ['stream/error'],
    description: 'dsh 主动 stream 错误更少（prefer retry over stream break）',
  },
  'dsh-008-projection-watermark': {
    group: 'Projection',
    events: ['session/projection'],
    description: 'projection 推送频率略高（dsh 派生事件更密集）',
  },
}

// ─── 双轨适配器（mock，不调真实 vendor/dsh 运行时） ────────────────────

export interface TrackAdapter {
  readonly name: 'opencc' | 'dsh'
  /**
   * 给定场景输入 → 产出 ServerEvent 序列。
   * 实现：scenario.events 已经在外部手写，适配器只做必要的「轨道差异
   * 注入」（如 dsh 多推一个 projection，opencc 多推一个 custom-title）。
   */
  runScenario(input: ScenarioInput): ServerEvent[]
}

export interface ScenarioInput {
  /** 场景唯一 ID。 */
  scenarioId: string
  /** 用户 prompt（mock LLM 接收）。 */
  prompt: string
  /** 期望的事件类型列表（双轨都应产出）。 */
  expectedEventTypes: string[]
  /** 仅在 dsh 侧出现的事件类型（已知差异）。 */
  dshOnlyEventTypes?: string[]
  /** 仅在 opencc 侧出现的事件类型（已知差异）。 */
  openccOnlyEventTypes?: string[]
}

// ─── ScenarioRunner ──────────────────────────────────────────────────

export interface Scenario {
  id: string
  name: string
  /** 期望覆盖的 group 列表（默认全 11 组）。 */
  groups?: ServerEventGroup[]
  input: ScenarioInput
}

/**
 * 在双轨上各跑一遍 scenario，比较归一化结果，产出 ParityReport。
 */
export function runParity(
  scenario: Scenario,
  openccAdapter: TrackAdapter,
  dshAdapter: TrackAdapter,
): ParityReport {
  const openccEvents = openccAdapter.runScenario(scenario.input)
  const dshEvents = dshAdapter.runScenario(scenario.input)

  const openccNorm = normalizeGroup(openccEvents)
  const dshNorm = normalizeGroup(dshEvents)

  const diff: GroupDiff[] = []
  const groupsCovered = new Set<ServerEventGroup>()
  const requiredGroups = scenario.groups ?? [...SERVER_EVENT_GROUPS]

  for (const group of requiredGroups) {
    const oItems = openccNorm.get(group) ?? []
    const dItems = dshNorm.get(group) ?? []
    const oTypes = new Set(oItems.map((e) => String(e.type)))
    const dTypes = new Set(dItems.map((e) => String(e.type)))

    const shared: string[] = []
    const openccOnly: string[] = []
    const dshOnly: string[] = []

    for (const t of oTypes) {
      if (dTypes.has(t)) shared.push(t)
      else openccOnly.push(t)
    }
    for (const t of dTypes) {
      if (!oTypes.has(t)) dshOnly.push(t)
    }

    const countDelta = dItems.length - oItems.length

    // 判定 verdict
    let verdict: DiffVerdict = 'pair'
    const knownIds: string[] = []
    const allDiffTypes = [...openccOnly, ...dshOnly]
    if (allDiffTypes.length > 0) {
      // 看是否能完全被已知差异清单覆盖
      const knownTypeMap = new Map<string, string>()
      for (const [id, info] of Object.entries(KNOWN_DIFFERENCES)) {
        if (info.group !== group) continue
        for (const evt of info.events) knownTypeMap.set(evt, id)
      }
      const unmatched = allDiffTypes.filter((t) => !knownTypeMap.has(t))
      if (unmatched.length === 0) {
        verdict = 'known'
        for (const t of allDiffTypes) {
          const id = knownTypeMap.get(t)
          if (id && !knownIds.includes(id)) knownIds.push(id)
        }
      } else {
        verdict = 'diverged'
      }
    }

    if (oItems.length > 0 || dItems.length > 0) {
      groupsCovered.add(group)
    }

    diff.push({
      group,
      verdict,
      sharedTypes: shared.sort(),
      openccOnly: openccOnly.sort(),
      dshOnly: dshOnly.sort(),
      countDelta,
      knownDifferenceIds: knownIds,
    })
  }

  const groupsMissing = requiredGroups.filter((g) => !groupsCovered.has(g))
  const anyDiverged = diff.some((d) => d.verdict === 'diverged')
  const verdict: DiffVerdict = anyDiverged ? 'diverged' : 'pair'

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    groupsCovered: Array.from(groupsCovered),
    groupsMissing,
    diff,
    verdict,
  }
}

// ─── Diff 报告渲染 ──────────────────────────────────────────────────

/**
 * 把 ParityReport 渲染成可读 markdown 表格（一行一组）。
 */
export function renderReport(report: ParityReport): string {
  const lines: string[] = []
  lines.push(`# Parity Report — ${report.scenarioId}: ${report.scenarioName}`)
  lines.push('')
  lines.push(`- Scenario verdict: **${report.verdict}**`)
  lines.push(`- Groups covered: ${report.groupsCovered.join(', ') || '(none)'}`)
  lines.push(`- Groups missing: ${report.groupsMissing.join(', ') || '(none)'}`)
  lines.push('')
  lines.push('| Group | Verdict | Shared | OpenCC-only | DSH-only | Count Δ | Known |')
  lines.push('|-------|---------|--------|-------------|----------|---------|-------|')
  for (const d of report.diff) {
    lines.push(
      `| ${d.group} | ${d.verdict} | ${d.sharedTypes.join(', ') || '—'} | ${d.openccOnly.join(', ') || '—'} | ${d.dshOnly.join(', ') || '—'} | ${d.countDelta} | ${d.knownDifferenceIds.join(', ') || '—'} |`,
    )
  }
  return lines.join('\n')
}

// ─── Track 适配器工厂（用于测试中跑场景） ────────────────────────────

/**
 * 简单 mock 轨道适配器：从 scenario 的 expectedEventTypes 列表生成
 * ServerEvent 序列。仅做字段填充，不模拟真实 LLM。
 */
export function makeMockTrackAdapter(
  name: 'opencc' | 'dsh',
): TrackAdapter {
  return {
    name,
    runScenario(input: ScenarioInput): ServerEvent[] {
      const events: ServerEvent[] = []
      let seq = 1
      const allTypes = [
        ...input.expectedEventTypes,
        ...(name === 'dsh'
          ? input.dshOnlyEventTypes ?? []
          : input.openccOnlyEventTypes ?? []),
      ]
      for (const type of allTypes) {
        events.push(makeMockEvent(type, seq++, input.scenarioId))
      }
      return events
    },
  }
}

function makeMockEvent(
  type: string,
  seq: number,
  scenarioId: string,
): ServerEvent {
  const base = {
    eventId: `evt-${seq}-${scenarioId}`,
    ts: Date.now(),
    seq,
  }
  // 用 zod 解析（parse 失败时退化为 untyped object — 但 ServerEvent 是 z.infer，
  // 不能直接构造。改为返回 any-cast，调用方只关心 type 列表）。
  return {
    ...base,
    type: type as any,
  } as ServerEvent
}