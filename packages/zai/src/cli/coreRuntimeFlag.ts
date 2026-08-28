/**
 * `applyCoreRuntimeFlag` — 把 CLI `--coreRuntime=default|inproc|spawn` 直接落到
 * `process.env.ZAI_CORE_RUNTIME`,并打印结果。
 *
 * 为什么要在 CLI 入口处理而不是直接交给 `resolveCoreRuntime`:
 *   - `resolveCoreRuntime` 的优先级是 flag(env)> settings > default,只看 env
 *     不动 env;CLI flag 的语义是"强制覆盖",必须在 spawn 出 user process /
 *     解析 settings 之前落到 env 上,`initAgentRuntime` 才会读到正确值。
 *   - 启动日志(`[initAgentRuntime] coreRuntime=... (ZAI_CORE_RUNTIME=...)`)以
 *     env 实际值为锚;在 CLI 入口打可让用户立刻看到 flag 是否生效。
 *
 * 合法值(2026-08-28 命名统一,与 `ZAI_CORE_RUNTIME` / `settings.coreRuntime`
 * 取值一一对齐,不再有 off / 删 env 的二次转换):
 *   - 'default' → 强制轻量 in-process createOpenccRuntime
 *   - 'inproc'  → 强制 in-process print 多 session 运行时
 *   - 'spawn'   → 强制 spawn `opencc -p` 子进程(SessionHost)
 *   - undefined → 不动 env(把决定权交给 settings.json / 父进程 env)
 */
import type { CoreRuntime } from '../shared/settings.js';

const VALID_VALUES: ReadonlySet<CoreRuntime> = new Set<CoreRuntime>([
  'default',
  'inproc',
  'spawn',
])

// zai patch (2026-08-28): `enableOpenccConfigs()` 在 `initAgentRuntime` 内会
// 把 settings 的 `env` 块无条件 `Object.assign` 回 `process.env`——晚于本
// 模块的 CLI 入口执行,会覆盖 `--coreRuntime inproc` 写入的
// `ZAI_CORE_RUNTIME=inproc`(实测:settings.env 里有同名键时 flag 形同虚设)。
// 这里记住 CLI 的强制值,`agentRuntime.initAgentRuntime` 在解析运行时之前用
// `reapplyCoreRuntimeFlag()` 恢复,保住 "flag = 强制覆盖 settings" 的语义。
// 本模块仅 type import(零运行时依赖),server 侧可安全 import,不会形成循环。
let forcedRuntime: CoreRuntime | null = null

export function getForcedCoreRuntimeFlag(): CoreRuntime | null {
  return forcedRuntime
}

/** 在 settings env 覆盖 process.env 之后重放 `--coreRuntime` 的强制语义。 */
export function reapplyCoreRuntimeFlag(): void {
  if (forcedRuntime !== null) {
    process.env.ZAI_CORE_RUNTIME = forcedRuntime
  }
}

export function applyCoreRuntimeFlag(raw: string | undefined): void {
  if (raw === undefined || raw === '') {
    return
  }
  if (!VALID_VALUES.has(raw as CoreRuntime)) {
    console.error(
      `[zai] error: --coreRuntime expected one of [default, inproc, spawn], got '${raw}'`,
    )
    process.exit(2)
  }

  forcedRuntime = raw as CoreRuntime
  process.env.ZAI_CORE_RUNTIME = forcedRuntime
  console.log(`[zai] runtime flag: coreRuntime=${forcedRuntime}`)
}
