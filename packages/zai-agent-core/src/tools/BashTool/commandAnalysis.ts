/**
 * Bash command analysis (zai 端本地版, 替代 opencc `tools/BashTool/bashCommandAnalysis.ts`)。
 *
 * opencc 用 tree-sitter-bash 做 AST 解析 (fail-closed 'too-complex'),
 * zai 不引入 tree-sitter 依赖, 用 regex + splitter 做轻量分析。
 *
 * 对外暴露 `analyzeBashCommand(command)`, 返回结构化分析结果,
 * BashTool 用它做 read-only / sandbox 决策。
 */
import { splitCommandWithOperators, baseCommand } from './commandSplitter.js'

export type BashCommandAnalysis = {
  hasDestructiveWrite: boolean
  hasCd: boolean
  hasPipeOrRedirect: boolean
  hasSubshell: boolean
  hasSimulatedSedEdit: boolean
  isParseable: boolean
  baseCommands: string[]
}

const DESTRUCTIVE_WRITE_RE = /\b(rm\s+(-[a-zA-Z]*[rfRF]+\b|--recursive)|dd\s+.*\bof=\/dev\/)/
const SED_INPLACE_RE = /\bsed\s+(.*\s)?-i/

export function analyzeBashCommand(command: string): BashCommandAnalysis {
  let parts: string[]
  try {
    parts = splitCommandWithOperators(command)
  } catch {
    return emptyAnalysis(false)
  }

  const baseCommands: string[] = []
  let hasCd = false
  let hasPipeOrRedirect = false

  for (const p of parts) {
    if (['&&', '||', ';', '|', '>', '>>', '>&'].includes(p)) {
      if (p === '|' || p === '>' || p === '>>' || p === '>&') hasPipeOrRedirect = true
      continue
    }
    const base = baseCommand(p)
    if (base === 'cd') hasCd = true
    if (base) baseCommands.push(base)
  }

  return {
    hasDestructiveWrite: DESTRUCTIVE_WRITE_RE.test(command),
    hasCd,
    hasPipeOrRedirect,
    hasSubshell: /[`(]|\\\(|\\\) /.test(command),
    hasSimulatedSedEdit: SED_INPLACE_RE.test(command),
    isParseable: true,
    baseCommands,
  }
}

function emptyAnalysis(parseable: boolean): BashCommandAnalysis {
  return {
    hasDestructiveWrite: false,
    hasCd: false,
    hasPipeOrRedirect: false,
    hasSubshell: false,
    hasSimulatedSedEdit: false,
    isParseable: parseable,
    baseCommands: [],
  }
}