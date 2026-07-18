/**
 * BashTool utils (zai 端精简版, 替代 opencc `tools/BashTool/utils.ts`)。
 *
 * opencc utils.ts 提供:
 *   - buildImageToolResult (图片输出) — zai stub
 *   - isImageOutput (图片检测) — zai stub 永远 false
 *   - resizeShellImageOutput — zai stub 永远 null
 *   - resetCwdIfOutsideProject (cwd 漂移提示) — zai stub
 *   - stdErrAppendShellResetMessage — zai stub
 *   - stripEmptyLines (剥多余空行) — 移植
 *   - selectFailureOutput (失败路径挑选 best body) — 移植
 */

import type { BashOutput } from './outputSchema.js'

/** 图片检测 — zai 无此路径, 永远 false。 */
export function isImageOutput(_stdout: string): boolean {
  return false
}

/** 图片缩放 — zai stub。 */
export async function resizeShellImageOutput(_stdout: string): Promise<string | null> {
  return null
}

/** cwd 漂移提示 — zai stub (zai 的 spawn 用 cwd=workdir, 没有 shell 状态)。 */
export function resetCwdIfOutsideProject(): boolean {
  return false
}

export function stdErrAppendShellResetMessage(stderr: string): string {
  return stderr
}

/** 剥多余空行。 */
export function stripEmptyLines(stdout: string): string {
  return stdout.replace(/\n{3,}/g, '\n\n')
}

/**
 * 失败路径挑选 — issue #1231: 三选一非空 failure body, 按优先级:
 *   1. accumulator 收集到的(已剥 Exit code marker)
 *   2. result.stdout (shell runner 给的)
 *   3. lastProgressFullOutput (流式 generator 最近一次 yield)
 */
export function selectFailureOutput(
  accumulated: string,
  stdout: string,
  lastProgressFullOutput: string,
): string {
  if (accumulated.trim()) return accumulated
  if (stdout?.trim()) return stdout
  if (lastProgressFullOutput?.trim()) return lastProgressFullOutput
  return ''
}

/**
 * 退出码语义解释 — 对标 opencc `commandSemantics.ts` 的 interpretationResult。
 */
export function interpretExitCode(command: string, code: number): string | undefined {
  const base = command.trim().split(/\s+/)[0] ?? ''
  if (base === 'grep' && code === 1) return 'no matches found'
  if (base === 'diff' && code === 1) return 'files differ'
  if (base === 'test' && code === 1) return 'condition false'
  if (base === 'ls' && code > 1) return 'permission denied or I/O error'
  return undefined
}

/** 构造标准化 BashOutput。 */
export function makeBashOutput(partial: Partial<BashOutput> & { stdout: string; stderr: string; interrupted: boolean }): BashOutput {
  return {
    stdout: partial.stdout,
    stderr: partial.stderr,
    interrupted: partial.interrupted,
    isAbort: partial.isAbort,
    abortReason: partial.abortReason,
    abortMessage: partial.abortMessage,
    isImage: partial.isImage ?? false,
    backgroundTaskId: partial.backgroundTaskId,
    backgroundedByUser: partial.backgroundedByUser,
    assistantAutoBackgrounded: partial.assistantAutoBackgrounded,
    dangerouslyDisableSandbox: partial.dangerouslyDisableSandbox,
    returnCodeInterpretation: partial.returnCodeInterpretation,
    noOutputExpected: partial.noOutputExpected,
    persistedOutputPath: partial.persistedOutputPath,
    persistedOutputSize: partial.persistedOutputSize,
    persistedOutputTruncated: partial.persistedOutputTruncated,
  }
}