/**
 * Bash 命令的搜索/读取/列表分类 (对标 opencc `tools/BashTool/BashTool.tsx:62-175`)。
 *
 * 用 `commandSplitter` 拆分子命令, 每个子命令的 base name 决定类型:
 *   - isSearch : grep, find, rg, ag, ack, locate, which, whereis
 *   - isRead   : cat, head, tail, less, more, wc, stat, file, strings, jq, awk, cut, sort, uniq, tr
 *   - isList   : ls, tree, du
 *
 * Pipeline / 复合命令 (&&, ||, ;, |) 必须**所有**子命令都是 read/search/list 才算
 * collapsible。语义中性命令 (echo, printf, true, false, :) 跳过。
 */
import { splitCommandWithOperators } from './commandSplitter.js'

/**
 * 导出三个命令集 (对标 opencc `tools/BashTool/BashTool.tsx:62-84`):
 *
 *   - BASH_SEARCH_COMMANDS: 真正的搜索类命令 (grep, find, rg, ...)
 *   - BASH_READ_COMMANDS:    只读类 (cat, head, jq, wc, ...)
 *   - BASH_LIST_COMMANDS:    目录列举类 (ls, tree, du) — 与 READ 拆分,
 *                            让 summary 区分 "Listed N directories" vs "Read N files"
 */
export const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
export const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr',
])
export const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])

/**
 * 语义中性命令 — 在 pipeline 中不影响整体 read/search 判定
 * (opencc `BASH_SEMANTIC_NEUTRAL_COMMANDS`)。
 * 例如 `ls dir && echo "---" && ls dir2` 仍是只读复合命令。
 */
export const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])

/**
 * 通常不产生 stdout 的命令 (opencc `BASH_SILENT_COMMANDS`)。
 * `isSilentBashCommand` 用来给前端判断是否折叠静默结果。
 */
export const BASH_SILENT_COMMANDS = new Set([
  'mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp',
  'touch', 'ln', 'cd', 'export', 'unset', 'wait',
])

/**
 * `sleep` 等命令若在 assistant mode 触发自动后台化, 会导致用户看不到
 * 实时进度 (opencc `DISALLOWED_AUTO_BACKGROUND_COMMANDS`)。
 * 只在前台跑 — 显式 run_in_background:true 仍允许。
 */
export const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep'] as const

const REDIRECT_OPERATORS = new Set(['>', '>>', '>&'])

export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
} {
  let parts: string[]
  try {
    parts = splitCommandWithOperators(command)
  } catch {
    return { isSearch: false, isRead: false, isList: false }
  }
  if (parts.length === 0) return { isSearch: false, isRead: false, isList: false }

  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasNonNeutral = false
  let skipNextAsRedirectTarget = false

  for (const part of parts) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false
      continue
    }
    if (REDIRECT_OPERATORS.has(part)) {
      skipNextAsRedirectTarget = true
      continue
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      continue
    }
    const base = part.trim().split(/\s+/)[0] ?? ''
    if (!base) continue
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(base)) continue
    hasNonNeutral = true

    const isPartSearch = BASH_SEARCH_COMMANDS.has(base)
    const isPartRead = BASH_READ_COMMANDS.has(base)
    const isPartList = BASH_LIST_COMMANDS.has(base)
    if (!isPartSearch && !isPartRead && !isPartList) {
      return { isSearch: false, isRead: false, isList: false }
    }
    if (isPartSearch) hasSearch = true
    if (isPartRead) hasRead = true
    if (isPartList) hasList = true
  }

  if (!hasNonNeutral) return { isSearch: false, isRead: false, isList: false }
  return { isSearch: hasSearch, isRead: hasRead, isList: hasList }
}

/**
 * 判断命令是否"沉默" — pipeline 中所有子命令都来自 `BASH_SILENT_COMMANDS`
 * (mv/cp/rm/mkdir/...) 且 pipeline 头部不是 read/search/list。
 *
 * 对标 opencc `BashTool.tsx:181` 的 `isSilentBashCommand`。前端可用此
 * 来折叠 mv/cp/rm 等只返回 exit code 0 的纯副作用命令。
 *
 * 语义中性命令 (echo 等) 跳过 — 这与 isSearchOrReadBashCommand 一致。
 */
export function isSilentBashCommand(command: string): boolean {
  let parts: string[]
  try {
    parts = splitCommandWithOperators(command)
  } catch {
    return false
  }
  if (parts.length === 0) return false

  let sawAnyNonNeutral = false
  for (const part of parts) {
    if (REDIRECT_OPERATORS.has(part)) {
      // 重定向会把数据写入文件, 不算"沉默"
      return false
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') continue
    const base = part.trim().split(/\s+/)[0] ?? ''
    if (!base) continue
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(base)) continue
    sawAnyNonNeutral = true
    if (!BASH_SILENT_COMMANDS.has(base)) return false
  }

  return sawAnyNonNeutral
}