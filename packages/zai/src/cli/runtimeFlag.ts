/**
 * `applyRuntimeFlag` — 把 CLI `--runtime=print|null` 翻译成
 * `process.env.ZAI_OPENCC_CLI` 的写/删,并打印结果。
 *
 * 为什么要在 CLI 入口处理而不是直接交给 `resolveOpenccCliFlag`:
 *   - `resolveOpenccCliFlag` 的优先级是 env > settings > off,只看 env 不动
 *     env;CLI flag 的语义是"强制覆盖",必须在 spawn 出 user process / 解析
 *     settings 之前落到 env 上,`initAgentRuntime` 才会读到正确值。
 *   - 启动日志(`[initAgentRuntime] runtime=... (ZAI_OPENCC_CLI=...)`)以
 *     env 实际值为锚;在 CLI 入口打可让用户立刻看到 flag 是否生效。
 *
 * 合法值:
 *   - 'print' → 强制 in-process print 多 session 运行时(`ZAI_OPENCC_CLI=inproc`)
 *   - 'null'  → 强制 unset 掉父 shell 继承的 ZAI_OPENCC_CLI,落回 settings/off
 *   - 其他 / undefined → 不动 env(把决定权交给 settings.json / 父进程 env)
 */
export type RuntimeFlagValue = 'print' | 'null'

const VALID_VALUES: ReadonlySet<RuntimeFlagValue> = new Set(['print', 'null'])

export function applyRuntimeFlag(raw: string | undefined): void {
  if (raw === undefined || raw === '') {
    return
  }
  if (!VALID_VALUES.has(raw as RuntimeFlagValue)) {
    console.error(
      `[zai] error: --runtime expected one of [print, null], got '${raw}'`,
    )
    process.exit(2)
  }

  if (raw === 'print') {
    process.env.ZAI_OPENCC_CLI = 'inproc'
    console.log(`[zai] runtime flag: print (ZAI_OPENCC_CLI=inproc)`)
  } else {
    delete process.env.ZAI_OPENCC_CLI
    console.log(`[zai] runtime flag: null (ZAI_OPENCC_CLI deleted)`)
  }
}