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

const SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr',
])
const LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const SEMANTIC_NEUTRAL = new Set(['echo', 'printf', 'true', 'false', ':'])
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
    if (SEMANTIC_NEUTRAL.has(base)) continue
    hasNonNeutral = true

    const isPartSearch = SEARCH_COMMANDS.has(base)
    const isPartRead = READ_COMMANDS.has(base)
    const isPartList = LIST_COMMANDS.has(base)
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