import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initTaskFactoryBridge, getTaskFactoryState, getTaskFactoryStateSync, setTaskFactoryState,
  injectSupervisorCommand, buildTaskCommand, QUICK_VERIFIER_HINT, __resetForTests,
} from '../../../src/server/services/taskFactoryBridge.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { sessionInbox } from '../../../src/server/services/sessionInbox.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-bridge-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
})
afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('taskFactoryBridge', () => {
  it('set/get state 持久化到 state.json', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-sup' })
    const s = await getTaskFactoryState()
    expect(s.managedEnabled).toBe(true)
    expect(s.supervisorSessionId).toBe('sess-sup')
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
    expect(raw.managedEnabled).toBe(true)
  })

  it('emitter 事件经 eventBus 发出', () => {
    __resetForTests()
    const spy = vi.spyOn(eventBus, 'emit')
    initTaskFactoryBridge()
    const emitter = (globalThis as any).__zaiTaskFactoryEmitter
    emitter({ action: 'created', payload: { id: 'tf-x' } })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_factory', action: 'created' }))
  })

  it('injectSupervisorCommand 走 sessionInbox.followup', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    injectSupervisorCommand('<task-command action="dispatch"></task-command>')
    expect(spy).toHaveBeenCalledWith(
      'sess-sup',
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'task-factory' }),
        content: expect.stringContaining('task-command'),
      }),
    )
  })

  it('injectSupervisorCommand 在 sid 为 null 时跳过(2026-09-02 reset 护栏)', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: null })
    // mockClear 处理前一个测试未 mockRestore 的 spy 累积
    const spy = vi.spyOn(sessionInbox, 'followup')
    spy.mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warn.mockClear()
    injectSupervisorCommand('<task-command action="dispatch"></task-command>')
    expect(spy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('injectSupervisorCommand skipped'))
    warn.mockRestore()
    spy.mockRestore()
  })
})

// zai patch (2026-09-04, quick-intake):verifier 分流 —— buildTaskCommand
// 根据 task.mode 自动决定是否在 task-command 后追加 verifier light 提示段。
describe('buildTaskCommand / QUICK_VERIFIER_HINT (2026-09-04 quick-intake)', () => {
  it('QUICK_VERIFIER_HINT 含 <task-verifier-mode value="light"> 标签 + build/lint/diff 关键词', () => {
    expect(QUICK_VERIFIER_HINT).toContain('<task-verifier-mode value="light">')
    expect(QUICK_VERIFIER_HINT).toContain('</task-verifier-mode>')
    expect(QUICK_VERIFIER_HINT).toContain('build')
    expect(QUICK_VERIFIER_HINT).toContain('lint')
    expect(QUICK_VERIFIER_HINT).toContain('git diff')
  })

  it('quick 任务 dispatch 注入:task-command 后追加 verifier-mode light 段', () => {
    const cmd = buildTaskCommand('dispatch', { id: 'tf-q1', title: '改文案', mode: 'quick' }, 'Dispatch task tf-q1 for execution.')
    expect(cmd).toContain('<task-command action="dispatch" id="tf-q1" title="改文案">Dispatch task tf-q1 for execution.</task-command>')
    expect(cmd).toContain(QUICK_VERIFIER_HINT)
    // hint 必须紧跟 task-command,不能混在中间
    const idx = cmd.indexOf('</task-command>')
    const hintIdx = cmd.indexOf('<task-verifier-mode')
    expect(hintIdx).toBeGreaterThan(idx)
  })

  it('quick 任务 accept 注入:同样追加 verifier light 段(verifier 后续会 spawn)', () => {
    const cmd = buildTaskCommand('accept', { id: 'tf-q2', mode: 'quick' }, 'Accept the task deliverables and call SuperTasksMarkDone.')
    expect(cmd).toContain('action="accept"')
    expect(cmd).toContain(QUICK_VERIFIER_HINT)
  })

  it('full 任务 / mode 缺省:不附加 verifier 提示段(向后兼容)', () => {
    const cases: Array<{ name: string; task: Parameters<typeof buildTaskCommand>[1] }> = [
      { name: 'full 显式', task: { id: 'tf-f1', mode: 'full', title: 'T' } },
      { name: 'mode 缺省', task: { id: 'tf-f2', title: 'T' } },
      { name: 'task=null', task: null },
    ]
    for (const c of cases) {
      const cmd = buildTaskCommand('dispatch', c.task, 'Dispatch.')
      expect(cmd).not.toContain('task-verifier-mode')
      expect(cmd).not.toContain('value="light"')
    }
  })

  it('title 中的 < 替换为全角 ＜,防止被解析为 XML 起始标签', () => {
    const cmd = buildTaskCommand('dispatch', { id: 'tf-x', title: '<bad>tag', mode: 'quick' }, 'go')
    expect(cmd).toContain('title="＜bad>tag"')
    expect(cmd).not.toContain('title="<bad>')
  })

  it('pause / resume action 同样会附带 hint(quick 任务下也安全)—— 设计上 hint 只跟 mode 走', () => {
    // pause / resume 不触发 verifier,但 buildTaskCommand 不区分 action,
    // 因为 hint 是「任务级」属性 —— quick 任务任何 action 都隐含 verifier
    // 会用 light 路径。统一行为便于调用方不需要关心 action。
    const pauseCmd = buildTaskCommand('pause', { id: 'tf-q3', mode: 'quick' }, 'paused')
    expect(pauseCmd).toContain(QUICK_VERIFIER_HINT)
    const resumeCmd = buildTaskCommand('resume', { id: 'tf-q4', mode: 'full' }, 'resume')
    expect(resumeCmd).not.toContain('task-verifier-mode')
  })
})
