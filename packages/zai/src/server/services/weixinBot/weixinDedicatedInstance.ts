/**
 * weixinDedicatedInstance — 主实例按配置拉起「微信专用实例」。
 *
 * 用户要求(2026-09-13):
 *   1) 主实例启动时检查配置,若开启了微信机器人服务,先看机器级 owner 锁 ——
 *      无锁则拉起一个**独立实例**专门处理消息(默认端口 9199,面板可改);
 *   2) 只有 `app=weixin` 的实例处理消息;
 *   3) 专用实例的 cwd 默认用户主目录,面板可配。
 *
 * 为什么"检查锁"就等价于"检查是否已有实例在跑":
 *   `WeixinOwnerLock` 是机器级互斥体,通道持有者从 `adapter.connect()` 成功到
 *   `stop()` 全程持有它(`proper-lockfile` 每 10s 刷新 mtime,30s stale 回收)。
 *   所以「有活锁」= 已经有一个实例在收消息,此时不该再拉一个;「无锁」可能是
 *   从没拉过、也可能是上一个实例崩了(此时锁已被 stale 回收)—— 两种都该拉起。
 *
 * 与 `maybeAutoStartWeixinBot()`(weixinRuntimeBoot.ts)的分工:
 *   - 本模块:跑在**主实例**(能读 instanceSupervisor 的进程)上,负责"要不要有
 *     专用实例、把它拉起来",自己绝不启动通道;
 *   - 那个模块:跑在**专用实例**上,负责"把这个通道连起来"。
 *   两者都只在受管进程里生效。
 */
import { homedir } from 'node:os'
import { isManagedChild } from '../../../cli/managedChild.js'
import { WeixinBotSettingsSchema, type WeixinBotSettings } from '../../../shared/weixin.js'
import { getInstanceSupervisor } from '../instanceSupervisor.js'
import { readZaiSettings } from '../zaiSettingsStore.js'
import { isWeixinChannelHost, DEFAULT_WEIXIN_INSTANCE_PORT, WEIXIN_CHANNEL_PROFILE } from './channelProfile.js'
import { isValidDir } from './cwdValidity.js'
import { weixinDiag } from './debug.js'
import { WeixinOwnerLock } from './WeixinOwnerLock.js'

/** 自动创建的专用实例名。用户手动建同名实例会撞 DUPLICATE_NAME —— 意图明确,可接受。 */
export const WEIXIN_INSTANCE_NAME = 'weixin-bot'

export { DEFAULT_WEIXIN_INSTANCE_PORT }

/** 面板 / status 用的专用实例快照。 */
export interface DedicatedInstanceSnapshot {
  id: string
  name: string
  state: string
  /** 运行端口(child 实际绑定的那个),未运行时为 null。 */
  port: number | null
  /** 定义上固定的启动端口 —— 与 settings 对齐时比的是它,不是运行端口。 */
  startPort: number | null
  pid: number | null
  cwd: string
  lastError: string | null
}

export type ProvisionReason =
  /** 新建了实例定义并启动 */
  | 'provisioned'
  /** 复用已存在的定义,把它启动起来 */
  | 'started'
  /** owner 锁被持有 / 实例已在 running|starting */
  | 'already_running'
  /** settings.weixinBot.enabled 未开启 */
  | 'disabled'
  /** 非受管进程(裸 dev / 直连) */
  | 'not_managed'
  /** 本进程就是 instance child,不能再派生孙实例 */
  | 'instance_child'
  /** 本进程就是专用的通道宿主,不需要再拉一个 */
  | 'self_is_host'
  /** instanceSupervisor 不可用(未初始化 / 路由被禁) */
  | 'unsupported'
  /** 配置的工作目录不存在 */
  | 'invalid_cwd'
  | 'failed'

export interface ProvisionResult {
  attempted: boolean
  reason: ProvisionReason
  instanceId?: string
  detail?: string
}

/** 读并规范化 weixinBot 设置。schema 校验失败(如 baseUrl 非法)时返回 null。 */
async function readWeixinBotSettings(): Promise<WeixinBotSettings | null> {
  try {
    const raw = (await readZaiSettings()).weixinBot ?? {}
    const parsed = WeixinBotSettingsSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * 解析专用实例工作目录:配置为空 → 用户主目录。
 * 导出给面板/测试复用,保证「空 = homedir」这条规则只有一处实现。
 */
export function resolveDedicatedCwd(configured: string | undefined | null): string {
  const trimmed = (configured ?? '').trim()
  return trimmed || homedir()
}

/** 当前是否已存在 `app=weixin` 的实例定义(不区分运行状态)。 */
export function findDedicatedInstance(): DedicatedInstanceSnapshot | null {
  try {
    const snap = getInstanceSupervisor()
      .getSnapshots()
      .find((s) => s.app === WEIXIN_CHANNEL_PROFILE)
    if (!snap) return null
    return {
      id: snap.id,
      name: snap.name,
      state: snap.state,
      port: snap.port,
      startPort: snap.startPort ?? null,
      pid: snap.pid,
      cwd: snap.cwd,
      lastError: snap.lastError?.message ?? null,
    }
  } catch {
    // instanceSupervisor 未初始化(instance child / 早期启动) → 视为"没有"。
    return null
  }
}

/**
 * 把当前 settings 的编排参数(cwd / 端口)对齐到**已有实例定义**上。
 *
 * 为什么必须显式对齐:`InstanceSupervisor` 的 `def.cwd` / `def.startPort` 只在
 * `createInstance` 那一刻写盘,`startInstance` / `restartInstance` 都不改写它们
 * —— `doStart` 启动子进程时直接读 `entry.def.cwd`(instanceSupervisor.ts)。所以
 * 面板改了工作目录/端口后即使重启专用实例,子进程仍然落在旧目录、绑旧端口上,
 * 表现为「配置了工作目录但没生效」。这里在启动前把差异 patch 回定义。
 *
 * 只 patch 真正变化的字段:`updateInstance` 对空 patch 会抛 `INVALID_STATE`,而且
 * 无变化时的写入会白白 persist + emit 一次。
 *
 * 比的是定义上的 `startPort` 而非运行态 `port` —— 后者在实例停止/自动扫描时是
 * null,拿它对比会每次都判为"变了"。
 */
async function syncDedicatedDefinition(
  supervisor: ReturnType<typeof getInstanceSupervisor>,
  existing: { id: string; cwd: string; startPort?: number | null },
  want: { cwd: string; port: number },
): Promise<void> {
  const patch: { cwd?: string; port?: number } = {}
  if (existing.cwd !== want.cwd) patch.cwd = want.cwd
  if ((existing.startPort ?? null) !== want.port) patch.port = want.port
  if (Object.keys(patch).length === 0) return
  await supervisor.updateInstance(existing.id, patch)
}

/**
 * 拉起(或启动)微信专用实例。幂等 —— 已有活锁或已在运行时直接返回
 * `already_running`,不会把正在收消息的实例重启掉。
 *
 * @param opts.force `true` = 用户在面板上显式点了「连接」,即使
 *   `settings.weixinBot.enabled` 尚未开启也要拉起来;`false` = 启动路径,
 *   只在该开关开启时生效。
 */
export async function provisionDedicatedInstance(opts: { force: boolean }): Promise<ProvisionResult> {
  if (!isManagedChild()) return { attempted: false, reason: 'not_managed' }
  if (isWeixinChannelHost()) return { attempted: false, reason: 'self_is_host' }
  // 子实例不派生孙实例 —— 与 server/index.ts / routes/instances.ts 同一条约束。
  if (process.env.ZAI_INSTANCE_ID) return { attempted: false, reason: 'instance_child' }

  const wb = await readWeixinBotSettings()
  if (!opts.force && !wb?.enabled) return { attempted: false, reason: 'disabled' }

  const port = wb?.instancePort ?? DEFAULT_WEIXIN_INSTANCE_PORT
  const cwd = resolveDedicatedCwd(wb?.instanceCwd)

  // 有活锁 → 已经有人在做这件事。这是常态(重启主实例时专用实例仍在跑),
  // 不重启它,否则每次主实例重启都会打断正在处理的微信消息。
  const owner = await WeixinOwnerLock.read()
  if (owner?.live) {
    return {
      attempted: false,
      reason: 'already_running',
      detail: `owner pid=${owner.info.pid} instance=${owner.info.instanceId}`,
    }
  }

  if (!isValidDir(cwd)) {
    return { attempted: false, reason: 'invalid_cwd', detail: cwd }
  }

  let supervisor: ReturnType<typeof getInstanceSupervisor>
  try {
    supervisor = getInstanceSupervisor()
  } catch (err) {
    return { attempted: false, reason: 'unsupported', detail: (err as Error).message }
  }

  const existing = supervisor.getSnapshots().find((s) => s.app === WEIXIN_CHANNEL_PROFILE)
  try {
    if (existing) {
      if (existing.state === 'running' || existing.state === 'starting') {
        return { attempted: false, reason: 'already_running', instanceId: existing.id }
      }
      // 复用定义:先把 settings 里的 cwd / 端口写回定义(用户改完保存即可
      // 通过后续启动生效),再按定义启动。
      await syncDedicatedDefinition(supervisor, existing, { cwd, port })
      const started = await supervisor.startInstance(existing.id)
      return { attempted: true, reason: 'started', instanceId: started.id }
    }
    const created = await supervisor.createInstance({
      name: WEIXIN_INSTANCE_NAME,
      cwd,
      port,
      app: WEIXIN_CHANNEL_PROFILE,
    })
    return { attempted: true, reason: 'provisioned', instanceId: created.id }
  } catch (err) {
    // 端口被占用 / cwd 不可写等都从这里出来。createInstance 内部已把实例置为
    // `down` 并记 lastError,面板能看到;这里只把原因带回去。
    return { attempted: false, reason: 'failed', instanceId: existing?.id, detail: (err as Error).message }
  }
}

/**
 * 主实例启动时的自动编排入口(见 server/index.ts,必须排在
 * `initInstanceSupervisor()` 之后)。任何异常都不冒泡 —— 微信拉起失败不该
 * 阻断 zai 启动。
 */
export async function maybeProvisionWeixinInstance(): Promise<ProvisionResult> {
  try {
    const result = await provisionDedicatedInstance({ force: false })
    if (result.attempted) {
      // 正常稳态(拉起 / 复用专用实例),默认静默,见 weixinDebugEnabled()。
      weixinDiag(
        `[weixin.instance] ${result.reason} dedicated instance ${result.instanceId ?? ''} ` +
          `(channel now owned by an app=weixin instance)`,
      )
    } else if (result.reason === 'failed' || result.reason === 'invalid_cwd') {
      // `invalid_cwd` 也走 warning:配置的工作目录不存在时专用实例根本起不来,
      // 静默会让用户以为"机器人没反应"是网络问题。
      console.warn(`[weixin.instance] provisioning ${result.reason}: ${result.detail ?? 'unknown error'}`)
    }
    return result
  } catch (err) {
    console.warn('[weixin.instance] provisioning threw:', err)
    return { attempted: false, reason: 'failed', detail: (err as Error).message }
  }
}

/**
 * 面板「连接」用:强制拉起专用实例(不看 `enabled` 开关)。
 * 用户点按钮即表达意图,不应因为另一个开关没打开而静默无效。
 */
export async function ensureDedicatedInstance(): Promise<ProvisionResult> {
  return provisionDedicatedInstance({ force: true })
}

/**
 * 重启专用实例,让它在启动时重新读 `accounts/<id>.json` 拿到最新凭据,
 * 并把 settings 里的编排参数(工作目录 / 端口)重新对齐到实例定义。
 *
 * 用在两条路径上:
 *   1) 面板保存设置(`PUT /api/weixin/settings`)—— 这是「改完保存即生效」的
 *      唯一实现点,靠上面的 `syncDedicatedDefinition` 把新 cwd / 端口写回定义,
 *      否则重启只会用旧定义再起一遍(历史 bug:面板显示新目录、实例仍在旧目录);
 *   2) 扫码登录刚完成:QR 凭据由主实例写入 accounts/,而真正连通道的专用实例
 *      是另一个进程 —— 它只在启动时读一次凭据,所以必须重启才能用上新 token
 *      (否则表现为"扫码成功但收不到消息,要手动重启服务")。
 *
 * 实例不存在时退化为常规拉起。
 */
export async function restartDedicatedInstance(): Promise<ProvisionResult> {
  if (process.env.ZAI_INSTANCE_ID) return { attempted: false, reason: 'instance_child' }
  let supervisor: ReturnType<typeof getInstanceSupervisor>
  try {
    supervisor = getInstanceSupervisor()
  } catch (err) {
    return { attempted: false, reason: 'unsupported', detail: (err as Error).message }
  }
  const existing = supervisor.getSnapshots().find((s) => s.app === WEIXIN_CHANNEL_PROFILE)
  if (!existing) return provisionDedicatedInstance({ force: true })

  const wb = await readWeixinBotSettings()
  const cwd = resolveDedicatedCwd(wb?.instanceCwd)
  const port = wb?.instancePort ?? DEFAULT_WEIXIN_INSTANCE_PORT
  // 目录不存在时**不**写进定义:宁可保留旧 cwd 让它继续跑,也不要让定义指向一个
  // 起不来的目录(那会把正在收消息的实例打成 down)。错误如实回报给调用方。
  if (!isValidDir(cwd)) {
    return { attempted: false, reason: 'invalid_cwd', instanceId: existing.id, detail: cwd }
  }

  try {
    await syncDedicatedDefinition(supervisor, existing, { cwd, port })
    const snap =
      existing.state === 'running' || existing.state === 'starting'
        ? await supervisor.restartInstance(existing.id)
        : await supervisor.startInstance(existing.id)
    return { attempted: true, reason: 'started', instanceId: snap.id }
  } catch (err) {
    return { attempted: false, reason: 'failed', instanceId: existing.id, detail: (err as Error).message }
  }
}

/**
 * 面板「断开」用:停掉专用实例。
 * 通道由专用实例独占,所以主实例上的"断开"只能是停它 —— 没有本进程的通道可断。
 */
export async function stopDedicatedInstance(): Promise<{
  ok: boolean
  reason: 'stopped' | 'already_stopped' | 'not_found' | 'instance_child' | 'unsupported' | 'failed'
  instanceId?: string
  detail?: string
}> {
  if (process.env.ZAI_INSTANCE_ID) return { ok: false, reason: 'instance_child' }
  let supervisor: ReturnType<typeof getInstanceSupervisor>
  try {
    supervisor = getInstanceSupervisor()
  } catch (err) {
    return { ok: false, reason: 'unsupported', detail: (err as Error).message }
  }
  const existing = supervisor.getSnapshots().find((s) => s.app === WEIXIN_CHANNEL_PROFILE)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.state === 'stopped' || existing.state === 'down') {
    return { ok: true, reason: 'already_stopped', instanceId: existing.id }
  }
  try {
    await supervisor.stopInstance(existing.id)
    return { ok: true, reason: 'stopped', instanceId: existing.id }
  } catch (err) {
    return { ok: false, reason: 'failed', instanceId: existing.id, detail: (err as Error).message }
  }
}
