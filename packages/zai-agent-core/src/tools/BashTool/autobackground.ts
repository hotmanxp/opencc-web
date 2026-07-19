/**
 * Assistant-mode 自动后台化白名单 (对标 opencc `BashTool.tsx` 顶部
 * `isAutobackgroundingAllowed` + `DISALLOWED_AUTO_BACKGROUND_COMMANDS`)。
 *
 * 当 assistant 模式超过 15s 阻塞预算 (`ASSISTANT_BLOCKING_BUDGET_MS`) 时,
 * BashTool 自动把 foreground task 转到 background tracker。但部分命令
 * (`sleep`) 不该被自动转后台 — 用户在阻塞等待, 后台化会丢失可见的
 * progress 提示。
 *
 * 显式 `run_in_background:true` 不受此限制 — 用户主动要求后台化时,
 * 任何命令都允许。
 */
import { DISALLOWED_AUTO_BACKGROUND_COMMANDS } from './isSearchOrRead.js'
import { splitCommand, baseCommand } from './commandSplitter.js'

/**
 * 是否允许 assistant 自动后台化这条命令。返回 false 时, BashTool 不会
 * 在 15s 后把它转 background (但仍允许显式 run_in_background:true)。
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  const parts = splitCommand(command)
  if (parts.length === 0) return true
  const base = baseCommand(parts[0] ?? '')
  if (!base) return true
  return !(DISALLOWED_AUTO_BACKGROUND_COMMANDS as readonly string[]).includes(base)
}
