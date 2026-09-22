import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { TerminalShell } from '../../../shared/terminal.js'

/**
 * shell 发现与默认 shell 解析。
 * 移植自 deepseek-harness `packages/api/terminal-controller/src/shells.ts`
 * （它走 subprocess provider 的 resolveExecutable；zai 直接查本机 PATH）。
 */

const execFileAsync = promisify(execFile)

const IS_WIN32 = process.platform === 'win32'

/** 新建 tab 时可选的 shell 候选（与 dsh 的 shellCandidates 默认值一致）。 */
export const SHELL_CANDIDATES = ['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'] as const

/**
 * 从可执行文件路径推导 profile。
 * POSIX 用 `-i` 起交互式 shell —— **读用户自己的 rc**（oh-my-zsh 主题、别名、
 * 补全、PATH 都在里面）。这与 dsh 的 `--noprofile --norc -i` 相反：dsh 要接管
 * PS1/PROMPT_COMMAND 才能为模型判断"命令跑完了吗"，浏览器终端不需要那个标记，
 * 要的是用户熟悉的环境。见 spec 的差异说明。
 */
export function profile(path: string, name?: string): TerminalShell {
  const base = name ?? path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const kind = base.toLowerCase().replace(/\.exe$/u, '')
  const args = kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo'] : ['-i']
  return { path, name: kind, args }
}

/** 路径存在且可执行（Windows 只校验存在性 —— X_OK 在 win32 语义不同）。 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, IS_WIN32 ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 在 PATH 里解析一个命令名（或直接用绝对路径）。
 * @returns 绝对路径；找不到返回 undefined。
 */
export function which(command: string): string | undefined {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return isExecutable(command) ? command : undefined
  }
  const extensions = IS_WIN32
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of (process.env.PATH ?? '').split(IS_WIN32 ? ';' : delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, command + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/** 归一化用于去重的 key（Windows 大小写不敏感）。 */
function dedupeKey(path: string): string {
  const normalized = path.includes('\\') ? path.toLowerCase() : path
  try {
    return realpathSync(normalized)
  } catch {
    return normalized
  }
}

/**
 * 系统默认 shell：优先 `$SHELL`，否则按 POSIX / Windows 的常见位置回退。
 * 返回的路径保证已校验可执行；全都不存在时返回 undefined。
 */
export function resolveDefaultShell(): TerminalShell | undefined {
  const declared = process.env.SHELL
  if (declared && isExecutable(declared)) return profile(declared)
  const fallbacks = IS_WIN32
    ? ['pwsh', 'powershell', 'cmd']
    : ['/bin/zsh', '/bin/bash', '/bin/sh']
  for (const candidate of fallbacks) {
    const path = which(candidate)
    if (path) return profile(path)
  }
  return undefined
}

/**
 * 列出已安装的 shell，默认 shell 排第一，按 realpath 去重。
 * 与 dsh 的 discoverShells 同语义：解析失败的候选被跳过，不抛错。
 */
export function discoverShells(candidates: readonly string[] = SHELL_CANDIDATES): TerminalShell[] {
  const shells = new Map<string, TerminalShell>()
  const add = (shell: TerminalShell | undefined): void => {
    if (!shell) return
    const key = dedupeKey(shell.path)
    if (!shells.has(key)) shells.set(key, shell)
  }
  add(resolveDefaultShell())
  for (const candidate of candidates) {
    const path = which(candidate)
    if (path) add(profile(path))
  }
  return [...shells.values()]
}

/**
 * 解析一个指定 shellPath（来自前端的 `+` 菜单）。
 * @returns 校验通过且**位于候选清单内**的 profile；否则 undefined。
 */
export function resolveShellPath(
  shellPath: string,
  candidates: readonly string[] = SHELL_CANDIDATES,
): TerminalShell | undefined {
  return discoverShells(candidates).find((shell) => shell.path === shellPath)
}