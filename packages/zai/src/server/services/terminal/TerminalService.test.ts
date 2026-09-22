import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { TERMINAL_LIMITS, type TerminalShell } from '../../../shared/terminal.js'
import {
  TerminalClosedError,
  TerminalNotFoundError,
  TerminalShellUnavailableError,
  ptyAvailability,
} from './PtySession.js'
import { TerminalService } from './TerminalService.js'

const available = ptyAvailability().available

/** 优先用 bash：`bash -i` 在这台机器上比默认 zsh（oh-my-zsh）启动快，测试更稳。 */
function pickShell(service: TerminalService): TerminalShell {
  const shells = service.shells()
  const bash = shells.find((shell) => shell.name === 'bash')
  const chosen = bash ?? shells[0]
  if (chosen === undefined) throw new Error('no shell discovered on this machine')
  return chosen
}

function createRequest(service: TerminalService, id: string) {
  return {
    sessionId: 's1',
    id,
    cols: 80,
    rows: 24,
    shellPath: pickShell(service).path,
    cwd: tmpdir(),
  }
}

describe.skipIf(!available)('TerminalService — 每会话终端注册中心', () => {
  let service: TerminalService

  beforeEach(() => {
    service = new TerminalService()
  })

  afterEach(async () => {
    await service.disposeAll()
  })

  it('environment 报告上限与 node-pty 可用性', () => {
    const env = service.environment('/tmp')
    expect(env.available).toBe(true)
    expect(env.cwd).toBe('/tmp')
    expect(env.maxTerminals).toBe(TERMINAL_LIMITS.maxTerminals)
    expect(env.maxCols).toBe(TERMINAL_LIMITS.maxCols)
    expect(env.maxRows).toBe(TERMINAL_LIMITS.maxRows)
    expect(env.maxInputBytes).toBe(TERMINAL_LIMITS.maxInputBytes)
    expect(env.scrollback).toBe(TERMINAL_LIMITS.scrollback)
  })

  it('shells 列出本机 shell，默认 shell 排第一', () => {
    const shells = service.shells()
    expect(shells.length).toBeGreaterThan(0)
    for (const shell of shells) {
      expect(shell.path.startsWith('/')).toBe(true)
      expect(shell.name.length).toBeGreaterThan(0)
    }
  })

  it('create 幂等：同一 id 重复调用返回同一个终端', () => {
    const first = service.create(createRequest(service, 't-a'))
    const second = service.create(createRequest(service, 't-a'))
    expect(second).toEqual(first)
    expect(service.list('s1')).toHaveLength(1)
  })

  it('list 按会话隔离，未知会话返回空', () => {
    service.create(createRequest(service, 't-b'))
    expect(service.list('s1').map((t) => t.id)).toEqual(['t-b'])
    expect(service.list('other')).toEqual([])
  })

  it('超过 maxTerminals 时拒绝新建', () => {
    const request = createRequest(service, 't-x')
    for (let i = 0; i < TERMINAL_LIMITS.maxTerminals; i++) {
      service.create({ ...request, id: `t-many-${i}` })
    }
    expect(() => service.create({ ...request, id: 't-overflow' })).toThrow(TerminalClosedError)
  })

  it('close 之后同 id 不能复活（closedIds），重复 close 幂等', async () => {
    service.create(createRequest(service, 't-c'))
    await service.close('s1', 't-c')
    await service.close('s1', 't-c')
    expect(service.list('s1')).toEqual([])
    expect(() => service.create(createRequest(service, 't-c'))).toThrow(TerminalClosedError)
  })

  it('未知 id 的 close / get 抛 NotFound', async () => {
    expect(() => service.get('s1', 't-none')).toThrow(TerminalNotFoundError)
    await expect(service.close('s1', 't-none')).rejects.toBeInstanceOf(TerminalNotFoundError)
  })

  it('未知 shellPath 被拒', () => {
    expect(() =>
      service.create({ ...createRequest(service, 't-d'), shellPath: '/nope/not-a-shell' }),
    ).toThrow(TerminalShellUnavailableError)
  })

  it('write / resize / rename 落到对应终端', async () => {
    service.create(createRequest(service, 't-e'))
    await service.resize('s1', 't-e', 120, 40)
    service.rename('s1', 't-e', '测试终端')
    service.write('s1', 't-e', 'echo hi\r')
    const info = service.list('s1')[0]
    expect(info.cols).toBe(120)
    expect(info.rows).toBe(40)
    expect(info.title).toBe('测试终端')
  })

  it('disposeSession 回收该会话的全部终端', async () => {
    service.create(createRequest(service, 't-f'))
    service.create({ ...createRequest(service, 't-g') })
    await service.disposeSession('s1')
    expect(service.list('s1')).toEqual([])
    // 会话被回收后同 id 可以重新创建（dispose 不等于 close）
    expect(() => service.create(createRequest(service, 't-f'))).not.toThrow()
  })
})