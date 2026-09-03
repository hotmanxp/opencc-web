/**
 * `applyRuntimeCoreFlag` — 把 CLI `--runtimeCore=default|inproc|spawn|repl` 直接落到
 * `process.env.ZAI_RUNTIME_CORE`,并打印结果。
 *
 * 为什么要在 CLI 入口处理而不是直接交给 `resolveRuntimeCore`:
 *   - `resolveRuntimeCore` 的优先级是 flag(env)> settings > 'repl'(spec
 *     2026-08-30 §5.1),只看 env 不动 env;CLI flag 的语义是"强制覆盖",必须在 spawn 出 user process /
 *     解析 settings 之前落到 env 上,`initAgentRuntime` 才会读到正确值。
 *   - 启动日志(`[initAgentRuntime] runtimeCore=... (ZAI_RUNTIME_CORE=...)`)以
 *     env 实际值为锚;在 CLI 入口打可让用户立刻看到 flag 是否生效。
 *
 * 合法值(2026-08-28 命名统一,2026-08-30 全部统一为 `runtimeCore`,与
 * `ZAI_RUNTIME_CORE` / `settings.runtimeCore` 取值一一对齐,不再有 off /
 * 删 env 的二次转换):
 *   - 'default' → 强制轻量 in-process createOpenccRuntime
 *   - 'inproc'  → 强制 in-process print 多 session 运行时
 *   - 'spawn'   → 强制 spawn `opencc -p` 子进程(SessionHost)
 *   - 'repl'    → 强制 ReplRuntime(P3 stub / P3.1 shared OpenccRuntime 委托,见 agentRuntime.ts:578)
 *   - undefined → 不动 env(把决定权交给 settings.json / 父进程 env)
 */
import type { RuntimeCore } from '../shared/settings.js';

const VALID_VALUES: ReadonlySet<RuntimeCore> = new Set<RuntimeCore>([
  'default',
  'inproc',
  'spawn',
  'repl',
])

// zai patch (2026-08-28): `enableOpenccConfigs()` 在 `initAgentRuntime` 内会
// 把 settings 的 `env` 块无条件 `Object.assign` 回 `process.env`——晚于本
// 模块的 CLI 入口执行,会覆盖 `--runtimeCore inproc` 写入的
// `ZAI_RUNTIME_CORE=inproc`(实测:settings.env 里有同名键时 flag 形同虚设)。
// 这里记住 CLI 的强制值,`agentRuntime.initAgentRuntime` 在解析运行时之前用
// `reapplyRuntimeCoreFlag()` 恢复,保住 "flag = 强制覆盖 settings" 的语义。
// 本模块仅 type import(零运行时依赖),server 侧可安全 import,不会形成循环。
let forcedRuntimeCore: RuntimeCore | null = null

export function getForcedRuntimeCoreFlag(): RuntimeCore | null {
  return forcedRuntimeCore
}

/** 在 settings env 覆盖 process.env 之后重放 `--runtimeCore` 的强制语义。 */
export function reapplyRuntimeCoreFlag(): void {
  if (forcedRuntimeCore !== null) {
    process.env.ZAI_RUNTIME_CORE = forcedRuntimeCore
  }
}

export function applyRuntimeCoreFlag(raw: string | undefined): void {
  if (raw === undefined || raw === '') {
    return
  }
  if (!VALID_VALUES.has(raw as RuntimeCore)) {
    console.error(
      `[zai] error: --runtimeCore expected one of [default, inproc, spawn, repl], got '${raw}'`,
    )
    process.exit(2)
  }

  forcedRuntimeCore = raw as RuntimeCore
  process.env.ZAI_RUNTIME_CORE = forcedRuntimeCore
  console.log(`[zai] runtime flag: runtimeCore=${forcedRuntimeCore}`)
}
