/**
 * weixinDedicatedInstance 单测。
 *
 * 覆盖主实例启动时的编排决策(用户需求 1):
 *   开启设置 + 无锁 → 拉起 app=weixin 专用实例(默认 9199 / homedir);
 *   已有活锁 / 实例在跑 → 不打扰;
 *   未开启 / 非受管 / 本身是子实例或宿主 → 一律不动作。
 *
 * 依赖全部 mock:instanceSupervisor(spawn 副作用)、settings 读取、owner 锁。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'

// vi.mock 的 factory 会被提升到 import 之前执行,所以它引用的状态必须用
// vi.hoisted 一并提升 —— 否则 factory 求值时变量还在 TDZ。
const h = vi.hoisted(() => ({
  supervisorMock: {
    getSnapshots: vi.fn(),
    createInstance: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn(),
    restartInstance: vi.fn(),
  },
  settingsMock: { current: null as Record<string, unknown> | null },
  ownerMock: { current: null as unknown },
  // getInstanceSupervisor 是否应该抛(模拟"instanceSupervisor 未初始化")
  supervisorThrows: { current: false },
}))
const { supervisorMock, settingsMock, ownerMock, supervisorThrows } = h

vi.mock('../../../src/server/services/instanceSupervisor.js', () => ({
  getInstanceSupervisor: () => {
    if (h.supervisorThrows.current) throw new Error('instanceSupervisor not initialized')
    return h.supervisorMock
  },
}))

vi.mock('../../../src/server/services/zaiSettingsStore.js', () => ({
  readZaiSettings: async () => ({ weixinBot: h.settingsMock.current ?? undefined }),
}))

vi.mock('../../../src/server/services/weixinBot/WeixinOwnerLock.js', () => ({
  WeixinOwnerLock: { read: async () => h.ownerMock.current },
}))

import {
  DEFAULT_WEIXIN_INSTANCE_PORT,
  WEIXIN_INSTANCE_NAME,
  findDedicatedInstance,
  maybeProvisionWeixinInstance,
  provisionDedicatedInstance,
  resolveDedicatedCwd,
  restartDedicatedInstance,
  stopDedicatedInstance,
} from '../../../src/server/services/weixinBot/weixinDedicatedInstance.js'

function makeSnapshot(patch: Record<string, unknown> = {}) {
  return {
    id: 'inst_wx',
    name: WEIXIN_INSTANCE_NAME,
    cwd: homedir(),
    createdAt: '2026-09-13T00:00:00.000Z',
    app: 'weixin',
    state: 'stopped',
    port: null,
    pid: null,
    startedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    isCurrent: false,
    ...patch,
  }
}

const envKeys = ['ZAI_SUPERVISOR_PID', 'ZAI_APP', 'ZAI_INSTANCE_ID'] as const
let savedEnv: Record<string, string | undefined> = {}

describe('weixinDedicatedInstance', () => {
  beforeEach(() => {
    savedEnv = {}
    for (const k of envKeys) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    // 默认:受管的顶层主实例(有 supervisor、无 profile、非 instance child)。
    process.env.ZAI_SUPERVISOR_PID = String(process.pid)
    settingsMock.current = { enabled: true }
    ownerMock.current = null
    supervisorThrows.current = false
    supervisorMock.getSnapshots.mockReset().mockReturnValue([])
    supervisorMock.createInstance.mockReset().mockResolvedValue(makeSnapshot({ state: 'starting' }))
    supervisorMock.startInstance.mockReset().mockResolvedValue(makeSnapshot({ state: 'starting' }))
    supervisorMock.stopInstance.mockReset().mockResolvedValue(makeSnapshot())
    supervisorMock.restartInstance.mockReset().mockResolvedValue(makeSnapshot({ state: 'starting' }))
  })

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('resolveDedicatedCwd:空配置 → 用户主目录,非空 → 原样', () => {
    expect(resolveDedicatedCwd('')).toBe(homedir())
    expect(resolveDedicatedCwd('   ')).toBe(homedir())
    expect(resolveDedicatedCwd(undefined)).toBe(homedir())
    expect(resolveDedicatedCwd(tmpdir())).toBe(tmpdir())
  })

  it('非受管进程 → not_managed,不碰 supervisor', async () => {
    delete process.env.ZAI_SUPERVISOR_PID
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'not_managed' })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('本进程就是 app=weixin 宿主 → self_is_host', async () => {
    process.env.ZAI_APP = 'weixin'
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'self_is_host' })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('instance child 不派生孙实例 → instance_child', async () => {
    process.env.ZAI_INSTANCE_ID = 'inst_other'
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'instance_child' })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('settings.enabled=false → disabled(不拉起)', async () => {
    settingsMock.current = { enabled: false }
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'disabled' })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('force=true(面板「连接」)时即使 enabled=false 也拉起', async () => {
    settingsMock.current = { enabled: false }
    const r = await provisionDedicatedInstance({ force: true })
    expect(r).toMatchObject({ attempted: true, reason: 'provisioned' })
    expect(supervisorMock.createInstance).toHaveBeenCalled()
  })

  it('已有活锁 → already_running,不重复拉起', async () => {
    ownerMock.current = { info: { pid: 4242, instanceId: 'inst_old' }, live: true, self: false }
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'already_running' })
    expect(r.detail).toContain('inst_old')
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
    expect(supervisorMock.startInstance).not.toHaveBeenCalled()
  })

  it('无实例定义 → 用配置端口 + 配置 cwd 创建 app=weixin 实例', async () => {
    const cwd = tmpdir()
    settingsMock.current = { enabled: true, instancePort: 9310, instanceCwd: cwd }
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: true, reason: 'provisioned', instanceId: 'inst_wx' })
    expect(supervisorMock.createInstance).toHaveBeenCalledWith({
      name: WEIXIN_INSTANCE_NAME,
      cwd,
      port: 9310,
      app: 'weixin',
    })
  })

  it('未配 cwd → 默认用户主目录;未配端口 → 9199', async () => {
    settingsMock.current = { enabled: true }
    await provisionDedicatedInstance({ force: false })
    expect(supervisorMock.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: homedir(), port: DEFAULT_WEIXIN_INSTANCE_PORT }),
    )
  })

  it('cwd 不存在 → invalid_cwd,不 create', async () => {
    settingsMock.current = { enabled: true, instanceCwd: '/definitely/not/here/xyz' }
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'invalid_cwd' })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('已有定义但已停 → 复用定义并启动(按当前设置覆盖端口)', async () => {
    supervisorMock.getSnapshots.mockReturnValue([makeSnapshot({ state: 'stopped' })])
    settingsMock.current = { enabled: true, instancePort: 9499 }
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: true, reason: 'started', instanceId: 'inst_wx' })
    expect(supervisorMock.startInstance).toHaveBeenCalledWith('inst_wx', { port: 9499 })
    expect(supervisorMock.createInstance).not.toHaveBeenCalled()
  })

  it('已有定义且 running → already_running', async () => {
    supervisorMock.getSnapshots.mockReturnValue([makeSnapshot({ state: 'running' })])
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'already_running' })
    expect(supervisorMock.startInstance).not.toHaveBeenCalled()
  })

  it('instanceSupervisor 不可用 → unsupported(不抛)', async () => {
    supervisorThrows.current = true
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'unsupported' })
  })

  it('createInstance 抛错(如端口被占)→ failed,带 detail', async () => {
    supervisorMock.createInstance.mockRejectedValue(new Error('listen EADDRINUSE 9199'))
    const r = await provisionDedicatedInstance({ force: false })
    expect(r).toMatchObject({ attempted: false, reason: 'failed' })
    expect(r.detail).toContain('EADDRINUSE')
  })

  it('maybeProvisionWeixinInstance:异常不外抛', async () => {
    supervisorMock.createInstance.mockRejectedValue(new Error('boom'))
    await expect(maybeProvisionWeixinInstance()).resolves.toMatchObject({ reason: 'failed' })
  })

  it('findDedicatedInstance:无 supervisor 时返回 null 而不是抛', () => {
    supervisorThrows.current = true
    expect(findDedicatedInstance()).toBeNull()
  })

  it('findDedicatedInstance:只认 app=weixin 的那一条', () => {
    supervisorMock.getSnapshots.mockReturnValue([
      makeSnapshot({ id: 'inst_tf', app: 'task-factory', name: 'tf' }),
      makeSnapshot({ id: 'inst_wx', state: 'running', port: 9199, pid: 777 }),
    ])
    const snap = findDedicatedInstance()
    expect(snap).toMatchObject({ id: 'inst_wx', state: 'running', port: 9199, pid: 777 })
  })

  it('stopDedicatedInstance:停掉 running 的专用实例', async () => {
    supervisorMock.getSnapshots.mockReturnValue([makeSnapshot({ state: 'running' })])
    const r = await stopDedicatedInstance()
    expect(r).toMatchObject({ ok: true, reason: 'stopped', instanceId: 'inst_wx' })
    expect(supervisorMock.stopInstance).toHaveBeenCalledWith('inst_wx')
  })

  it('stopDedicatedInstance:没有专用实例 → not_found', async () => {
    const r = await stopDedicatedInstance()
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('restartDedicatedInstance:实例在跑 → restart(让新凭据/新配置生效)', async () => {
    supervisorMock.getSnapshots.mockReturnValue([makeSnapshot({ state: 'running' })])
    const r = await restartDedicatedInstance()
    expect(r).toMatchObject({ attempted: true, reason: 'started' })
    expect(supervisorMock.restartInstance).toHaveBeenCalledWith('inst_wx')
  })

  it('restartDedicatedInstance:实例不存在 → 退化为常规拉起', async () => {
    const r = await restartDedicatedInstance()
    expect(r).toMatchObject({ attempted: true, reason: 'provisioned' })
    expect(supervisorMock.createInstance).toHaveBeenCalled()
  })
})
