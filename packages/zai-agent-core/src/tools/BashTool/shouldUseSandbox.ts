/**
 * BashTool 的 sandbox 决策 (对标 opencc `tools/BashTool/shouldUseSandbox.ts`)。
 *
 * zai 默认 sandbox 开 (executor='child_process'), 不读 env 也不读 GrowthBook。
 * 只有显式 `dangerouslyDisableSandbox` + `_dangerouslyDisableSandboxApproved`
 * 同时为 true 才跳过 sandbox。
 */
import type { BashInput } from './schema.js'
import type { BashCommandAnalysis } from './commandAnalysis.js'

export function shouldUseSandbox(input: BashInput, _analysis: BashCommandAnalysis): boolean {
  if (input.dangerouslyDisableSandbox === true && input._dangerouslyDisableSandboxApproved === true) {
    return false
  }
  return true
}

/**
 * 是否在 UI 上展示 "SandboxedBash" 标签 (而非 "Bash")。
 * zai 不读 `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` env, 默认展示 'Bash'。
 */
export function shouldUseSandboxForPresentation(_input: BashInput): boolean {
  return false
}