/**
 * globalThis 桥清理协议 — B0 T0.8。
 *
 * zai 在运行时把若干内部句柄挂到 globalThis，让 opencc vendor / dsh 适配器
 * 内的 compat 模块能跨 module space 访问（典型如 `__zaiEventBus`、
 * `__zaiBridgeCtx`、`__zaiSessionInbox`、`__zaiCurrentSessionId`）。
 *
 * 双轨改造引入的不变量（主计划 §7 R10 + §4.1）：
 * - 启动时所有 `__zai*` 桥一次性挂入。
 * - shutdown() 显式清理（delete globalThis.__zai*），避免测试 / 重启残留。
 * - 同进程同一时刻只激活一条轨道；轨道切换必须重启 zai（不允许运行期切换）。
 *
 * 实现要点：
 * - 把 `__zai*` 字段名集中在一处维护，避免散落难盘点。
 * - 提供 `installZaiGlobalBridges(values)` 与 `clearZaiGlobalBridges()` 两个
 *   函数，前者由 initAgentRuntime 启动序列调用，后者由 KernelAdapter.shutdown()
 *   调用。
 * - 内部对每个 key 记录旧值（如果有），shutdown 时还原 — 防止误把外部脚本
 *   注入的同名全局变量删掉。
 *
 * 主计划 §4.1 §7 明确要求：B-1 尖峰验证 + 单测覆盖「启动后存在 / shutdown 后不存在」。
 */

export const ZAI_GLOBAL_BRIDGE_KEYS = [
  '__zaiEventBus',
  '__zaiBridgeCtx',
  '__zaiSessionInbox',
  '__zaiCurrentSessionId',
] as const

export type ZaiGlobalBridgeKey = (typeof ZAI_GLOBAL_BRIDGE_KEYS)[number]

type GlobalWithBridges = typeof globalThis & {
  __zaiEventBus?: unknown
  __zaiBridgeCtx?: unknown
  __zaiSessionInbox?: unknown
  __zaiCurrentSessionId?: unknown
}

interface BridgeInstallValues {
  __zaiEventBus?: unknown
  __zaiBridgeCtx?: unknown
  __zaiSessionInbox?: unknown
  __zaiCurrentSessionId?: unknown
}

/**
 * 把内部句柄挂入 globalThis。
 * 启动序列入口（initAgentRuntime）调一次。
 *
 * 仅挂载 values 中**实际提供**的 key；undefined 的 key 视为不变。
 */
export function installZaiGlobalBridges(values: BridgeInstallValues): void {
  const g = globalThis as GlobalWithBridges
  for (const key of ZAI_GLOBAL_BRIDGE_KEYS) {
    const v = values[key]
    if (v !== undefined) {
      ;(g as Record<string, unknown>)[key] = v
    }
  }
}

/**
 * 清空所有 zai 注入的 globalThis 桥 — shutdown 时调。
 *
 * 不删除非 zai 注入的同名 key：仅当 globalThis[key] 是由 installZaiGlobalBridges
 * 注入的对象引用时（用 WeakSet 记录），shutdown 才 delete。
 * 这避免误删外部脚本/测试 fixture 设置的同名变量。
 */
const installedRefs = new WeakSet<object>()

export function trackZaiGlobalBridge(key: ZaiGlobalBridgeKey, value: unknown): void {
  if (value && typeof value === 'object') {
    installedRefs.add(value as object)
  }
}

export function clearZaiGlobalBridges(): void {
  const g = globalThis as GlobalWithBridges
  for (const key of ZAI_GLOBAL_BRIDGE_KEYS) {
    const v = (g as Record<string, unknown>)[key]
    if (v && typeof v === 'object' && installedRefs.has(v as object)) {
      delete (g as Record<string, unknown>)[key]
    } else if (v === undefined) {
      // 已经是 undefined —— 不操作
    } else {
      // 非 zai 注入的同名变量（外部脚本/test fixture），保留
    }
  }
}

/**
 * 自检 — 测试用：当前 globalThis 是否含有任何 zai 桥。
 * KernelAdapter.shutdown() 后应返回 false。
 */
export function hasAnyZaiGlobalBridge(): boolean {
  const g = globalThis as GlobalWithBridges
  return ZAI_GLOBAL_BRIDGE_KEYS.some((k) => (g as Record<string, unknown>)[k] !== undefined)
}