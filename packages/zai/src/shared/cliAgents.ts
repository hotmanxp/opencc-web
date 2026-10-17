/**
 * cliAgent provider 名单 —— **本仓库唯一的取值域真相源**。
 *
 * zai patch (2026-10-17, oc-002):`7c32e4da` 把 `claude` 加进
 * `superTasks.ts` 的 `CLI_AGENT_NAMES` 时,忘了另外 5 处手抄的取值域 ——
 * 最致命的是 `factorySettings.ts` 的 zod 枚举,于是:UI 下拉框把 `claude`
 * 列为可选值 → 用户选中 → 点保存 → `safeParse` 失败 → **400,且粘住**
 * (catch 只 toast 不回滚 `draft`,不动下拉框的话之后每次保存都重复 400,
 * 同批次的 docsDir / repoRoot / maxParallelTasks / historyArchiveHours
 * 四项编辑全部连坐丢失)。
 *
 * 更前面还立着一道 `as` cast:`FactorySettingsDrawer.tsx:307` 用
 * `(v ?? null) as Draft['preferCliAgent']` 把本该拦下它的编译期检查关掉了,
 * 所以 typecheck 一直是绿的。
 *
 * **以前这里有 6 份手抄**(superTasks / factorySettings×2 / Drawer / superTaskApi
 * / vendor 侧 factorySettingsCore),每加一个 provider 就要记得改 6 处 ——
 * 漏一处就是一条线上不同的缺陷。**新增 provider 时改这个文件即可。**
 *
 * ⚠️ **vendor 侧有一处做不到统一**:`opencc-src/server/factorySettingsCore.ts`
 * 读**同一个** `factory-settings.json`(路径表达式逐字相同),但它在
 * `zn-agent-core` 包内,不能反向 import zai 的 `@shared`。那里的白名单必须
 * 手工同步 —— 已在该文件里写了反向指认注释,加 provider 时两处一起改。
 */

export const CLI_AGENT_NAMES = ['opencc', 'claude', 'dsh', 'opencode'] as const

export type CliAgentName = (typeof CLI_AGENT_NAMES)[number]

/**
 * 宽松的成员判定 —— 用于 sanitize 而非类型收窄。
 *
 * 用 `readonly string[]` 而非直接 `CLI_AGENT_NAMES.includes(x)`:后者对
 * as-const tuple 的参数类型收得很窄,传入 `unknown` 会编译不过。
 */
export function isCliAgentName(value: unknown): value is CliAgentName {
  return typeof value === 'string' && (CLI_AGENT_NAMES as readonly string[]).includes(value)
}
