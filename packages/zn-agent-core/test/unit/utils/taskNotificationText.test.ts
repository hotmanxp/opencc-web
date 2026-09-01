import { describe, expect, it } from 'vitest'
import {
  formatEnqueuedTime,
  formatTaskNotification,
  inferTaskKindFromRaw,
} from '../../../src/opencc-src/utils/taskNotificationText.js'

const RAW_BASH = [
  '<task-notification>',
  '<task-id>b5oacxomu</task-id>',
  '<status>completed</status>',
  '<summary>Background command "Start zai dev instance" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n')

describe('inferTaskKindFromRaw', () => {
  it('识别 Background command 前缀为 bash', () => {
    expect(inferTaskKindFromRaw(RAW_BASH)).toBe('bash')
  })
  it('识别 Monitor 前缀为 monitor', () => {
    expect(inferTaskKindFromRaw('Monitor "tail log" stream ended')).toBe(
      'monitor',
    )
  })
  it('无法推断时返回 undefined', () => {
    expect(inferTaskKindFromRaw('<task-notification>x</task-notification>')).toBeUndefined()
  })
})

describe('formatEnqueuedTime', () => {
  it('输出 LLM 可读时间(非 epoch),含时区偏移', () => {
    const s = formatEnqueuedTime(Date.parse('2026-09-01T02:53:53Z'))
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/)
    expect(s).not.toContain('1788') // 不应是裸 epoch
  })
})

describe('formatTaskNotification', () => {
  it('bash: 含可读时间 + 过期干扰提示,不再称 background agent', () => {
    const out = formatTaskNotification(RAW_BASH, {
      taskKind: 'bash',
      enqueuedAt: Date.parse('2026-09-01T02:53:53Z'),
    })
    expect(out).toContain('background Bash command finished at ')
    expect(out).toMatch(/at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/)
    expect(out).toContain('may already be in the past')
    expect(out).toContain('stale status update')
    expect(out).toContain('NOT a message from the user')
    expect(out).toContain('re-run or re-verify')
    expect(out).not.toContain('background agent')
    expect(out).toContain(RAW_BASH)
  })

  it('bash 无 enqueuedAt 时仍保留非用户消息锚句', () => {
    const out = formatTaskNotification(RAW_BASH, { taskKind: 'bash' })
    expect(out).toContain('NOT a message from the user')
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('缺 taskKind 时从 raw 前缀兜底推断为 bash', () => {
    const out = formatTaskNotification(RAW_BASH, {
      enqueuedAt: Date.parse('2026-09-01T02:53:53Z'),
    })
    expect(out).toContain('background Bash command finished')
  })

  it('agent 保持 vendor 原措辞并追加时间锚点', () => {
    const out = formatTaskNotification(
      '<task-notification><summary>Agent "t" completed</summary></task-notification>',
      { taskKind: 'agent', enqueuedAt: Date.parse('2026-09-01T02:53:53Z') },
    )
    expect(out).toMatch(/^A background agent completed a task \(at \d{4}/)
  })

  it('未知类型且无法推断 → 旧措辞(向后兼容)', () => {
    const out = formatTaskNotification('<task-notification>x</task-notification>', {})
    expect(out).toBe('A background agent completed a task:\n<task-notification>x</task-notification>')
  })

  it('monitor/workflow 各有独立措辞', () => {
    expect(
      formatTaskNotification('Monitor "m" stream ended', { taskKind: 'monitor' }),
    ).toContain('background monitor')
    expect(
      formatTaskNotification('wf', { taskKind: 'workflow' }),
    ).toContain('background workflow')
  })
})
