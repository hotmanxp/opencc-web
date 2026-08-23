import type { ReactNode } from "react"
import type { AgentMessage } from "../../store/useAgentStore.js"

export type ToolRenderer = {
  preview(input: Record<string, unknown>): string
  displayName?(input: Record<string, unknown>): string
  renderInput?(input: Record<string, unknown>): ReactNode
  /**
   * renderOutput 接受 (output, isError) 两个参数 — 与原有 11 个 renderer
   * (bash / read / edit / write / glob / grep / agent / mcp / generic) 签名
   * 完全一致. 不引入新参数, 不破坏 opencc 路径.
   *
   * 需要 AgentMessage 上下文的 renderer (例如 harness tool-fs-search 的
   * structuredGrepRenderer / structuredGlobRenderer 读 presentationMeta) 应
   * 实现 `renderFull(msg)`, 该方法接收完整 AgentMessage, 优先级高于
   * renderOutput. MessageBubble 检测到 renderFull 时直接挂载其结果,
   * 完全不走 renderOutput 路径. 这样不修改旧 API 即可接入新工具.
   */
  renderOutput?(output: unknown, isError: boolean): ReactNode
  /**
   * 整块接管渲染: 当 ToolCallBlock 检测到 renderFull 存在, 它会跳过默认
   * 折叠面板/pill/preview/input/output/error, 直接渲染此返回 (例如
   * Edit/Write 走 DiffBlock 自己负责 header/diff/error 一体化展示).
   * 同一时刻只会被返回 renderFull 或被标准 input/output 路径使用,
   * renderFull 优先级最高. preview/displayName 仍然被 ToolUsePill/折叠态
   * preview 使用, 所以哪怕 renderFull 模式下, 也建议实现 preview.
   */
  renderFull?(msg: AgentMessage): ReactNode
}
