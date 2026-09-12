/**
 * `applyRuntimeCoreFlag` — 把 CLI `--runtimeCore=default|repl` 直接落到
 * `process.env.ZAI_RUNTIME_CORE`,并打印结果。
 *
 * 为什么要在 CLI 入口处理而不是直接交给 `resolveRuntimeCore`:
 *   - `resolveRuntimeCore` 的优先级是 flag(env)> settings > 'repl'(spec
 *     2026-08-30 §5.1),只看 env 不动 env;CLI flag 的语义是"强制覆盖",必须在 spawn 出 user process /
 *     解析 settings 之前落到 env 上,`initAgentRuntime` 才会读到正确值。
 *   - 启动日志(`[initAgentRuntime] runtimeCore=... (ZAI_RUNTIME_CORE=...)`)以
 *     env 实际值为锚;在 CLI 入口打可让用户立刻看到 flag 是否生效。
 *
 * 合法值(2026-09-07 移除 inproc/spawn 轨道后收敛为二态):
 *   - 'default' → 轻量 in-process createOpenccRuntime
 *   - 'repl'    → ReplRuntime(createReplSession 抽壳路径,默认)
 *   - undefined → 不动 env(把决定权交给 settings.json / 父进程 env)
 */
import type { RuntimeCore } from '../shared/settings.js';

// 阶段 1(2026-09-12):保留 'default' 接受(磁盘遗留兼容)但运行时折叠 'repl'。
// VALID_VALUES 在 `applyRuntimeCoreFlag` 中只用来拒绝非法值;'default' 的
// 折叠处理在该函数内显式分支。
const VALID_VALUES: ReadonlySet<string> = new Set<string>([
  'default',  // deprecated,收到时 warn 并落 'repl'
  'repl',
])

// zai patch (2026-08-28): `enableOpenccConfigs()` 在 `initAgentRuntime` 内会
// 把 settings 的 `env` 块无条件 `Object.assign` 回 `process.env`——晚于本
// 模块的 CLI 入口执行,会覆盖 `--runtimeCore` 写入的
// `ZAI_RUNTIME_CORE`(实测:settings.env 里有同名键时 flag 形同虚设)。
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
  if (!VALID_VALUES.has(raw)) {
    console.error(
      `[zai] error: --runtimeCore expected one of [default, repl], got '${raw}'`,
    )
    process.exit(2)
  }

  // 阶段 1(2026-09-12):'default' deprecated,折叠成 'repl' 写入 env。
  // 保留 VALID_VALUES 接受 'default' 是为了不破坏既有客户端传参;
  // 但运行时永远 'repl',与 settings / REST 端点语义一致。
  let resolved: RuntimeCore
  if (raw === 'default') {
    console.warn(
      `[zai] warn: --runtimeCore 'default' is deprecated; coercing to 'repl' (phase-1 runtime unification)`,
    )
    resolved = 'repl'
  } else {
    resolved = raw as RuntimeCore
  }

  forcedRuntimeCore = resolved
  process.env.ZAI_RUNTIME_CORE = resolved
  console.log(`[zai] runtime flag: runtimeCore=${resolved}`)
}
