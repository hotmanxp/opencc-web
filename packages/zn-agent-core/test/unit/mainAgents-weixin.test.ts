import { describe, expect, it } from 'vitest'
import { getBuiltinMainAgents, WEIXIN_MAIN_AGENT_NAME } from '../../src/opencc-src/server/mainAgents.js'

/** 构造一个覆盖各家族的假工具池(DisplayFiles/WebFetch/Workflow 等应被剔除)。 */
function fakeTools(): { name: string }[] {
  return [
    // 指派家族 — 保留
    { name: 'Agent' },
    { name: 'TaskOutput' },
    { name: 'TaskStop' },
    { name: 'CliAgent' },
    // cron 家族 — 保留
    { name: 'CronCreate' },
    { name: 'CronDelete' },
    { name: 'CronList' },
    // 本体操作 — 保留
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'Edit' },
    { name: 'Write' },
    { name: 'Glob' },
    { name: 'Grep' },
    { name: 'WebSearch' },
    { name: 'Skill' },
    { name: 'AskUserQuestion' },
    { name: 'TaskCreate' },
    { name: 'TaskGet' },
    { name: 'TaskUpdate' },
    { name: 'TaskList' },
    // Web UI / 界面向 / banned — 剔除
    { name: 'DisplayFiles' },
    { name: 'WebFetch' },
    { name: 'WebBrowser' },
    { name: 'Workflow' },
    { name: 'Monitor' },
    { name: 'RemoteTrigger' },
    { name: 'Brief' },
    { name: 'SendUserFile' },
    { name: 'EnterWorktree' },
    { name: 'LSP' },
  ]
}

describe('weixin main agent (zai patch 2026-09-13)', () => {
  it('注册进内置列表,固定 name=weixin-bot', () => {
    const agents = getBuiltinMainAgents()
    const wx = agents.find((a) => a.name === WEIXIN_MAIN_AGENT_NAME)
    expect(wx).toBeTruthy()
    expect(wx!.systemPrompt).toBeTypeOf('function')
    expect(wx!.tools).toBeTypeOf('function')
  })

  it('tools 槽:白名单过滤 — DisplayFiles/WebFetch 等界面向工具全部剔除', () => {
    const wx = getBuiltinMainAgents().find((a) => a.name === 'weixin-bot')!
    const filtered = wx.tools!(fakeTools() as never)
    const names = filtered.map((t) => (t as { name: string }).name)
    // 剔除
    expect(names).not.toContain('DisplayFiles')
    expect(names).not.toContain('WebFetch')
    expect(names).not.toContain('WebBrowser')
    expect(names).not.toContain('Workflow')
    expect(names).not.toContain('Monitor')
    expect(names).not.toContain('RemoteTrigger')
    expect(names).not.toContain('Brief')
    expect(names).not.toContain('SendUserFile')
    expect(names).not.toContain('EnterWorktree')
    expect(names).not.toContain('LSP')
    // 保留
    expect(names).toContain('Agent')
    expect(names).toContain('TaskOutput')
    expect(names).toContain('CliAgent')
    expect(names).toContain('CronCreate')
    expect(names).toContain('CronDelete')
    expect(names).toContain('CronList')
    expect(names).toContain('Bash')
    expect(names).toContain('Read')
    expect(names).toContain('AskUserQuestion')
    expect(names).toContain('TaskCreate')
  })

  it('systemPrompt:身份前置 + 关键纪律段 + 剥离编码段', () => {
    const wx = getBuiltinMainAgents().find((a) => a.name === 'weixin-bot')!
    const origin = [
      'You are an interactive agent that helps users with software engineering tasks. Use the instructions below.',
      '# System\nTools are executed in a user-selected permission mode.',
      '# Doing tasks\nThe user will primarily request you to perform software engineering tasks.\nAvoid backwards-compatibility hacks.',
      '# CodeGraph\nExplore the codebase with codegraph tools.',
      'Session ticket id: abc123',
      '# Environment\nPrimary working directory: /tmp/x',
      '# Using your tools\nTo read files use Read instead of cat.',
    ]
    const slotted = wx.systemPrompt!(origin)
    const joined = slotted.join('\n')
    // 身份/纪律前置
    expect(slotted[0]).toContain('微信通道')
    expect(joined).toContain('Agent 工具派发给子 agent')
    expect(joined).toContain('CronCreate')
    expect(joined).toContain('纯文本')
    // 编码段剥离
    expect(joined).not.toContain('software engineering tasks')
    expect(joined).not.toContain('# Doing tasks')
    expect(joined).not.toContain('# CodeGraph')
    expect(joined).not.toContain('Session ticket id:')
    // 通用段保留
    expect(joined).toContain('# System')
    expect(joined).toContain('# Environment')
    expect(joined).toContain('# Using your tools')
  })
})
