import React from "react"
import type { ToolRenderer } from "./types.js"
import { PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

// MCP tool names 形如 `mcp_<server>_<action>` (e.g. `mcp_zinai_browser_navigate`).
// MCP 工具集是用户/服务端动态注入的, 没法为每一个静态注册一个 renderer.
// 走前缀派发: 任何 `mcp_` 开头的 name 都用 mcpRenderer (registry 用 isMcpToolName 路由).
//
// 设计目标: 比 generic 行为略可读, 但 schema 不固定没法抽主字段 -
//   1. pill 已经是完整长名 (`mcp_zinai_browser_navigate`), preview 不再粘全长
//   2. preview 显示第一个 input value 字符串 (和 generic 一样), 让用户在折叠态看到 URL/参数
//   3. input: 走 JSON 全量展示 (无 FieldLabel, 跟 generic 统一)
//   4. output: 跟 generic 等价的 success <pre>
const MCP_PREFIX = "mcp_"

function shortName(fullName: string): string {
  return fullName.startsWith(MCP_PREFIX) ? fullName.slice(MCP_PREFIX.length) : fullName
}

function actionSegment(fullName: string): string {
  // 取最后一个 `_` 之后段作为可读动作 (e.g. mcp_zinai_browser_navigate → navigate)
  const idx = fullName.lastIndexOf("_")
  return idx >= 0 ? fullName.slice(idx + 1) : shortName(fullName)
}

export const mcpRenderer: ToolRenderer = {
  preview(input) {
    const firstKey = Object.keys(input)[0]
    if (!firstKey) return ""
    const v = input[firstKey]
    if (v == null) return ""
    const text = typeof v === "string" ? v : JSON.stringify(v)
    return truncate(text, 80)
  },

  renderInput(input) {
    // MCP input schema 是各 server 自定义, 无法稳定抽主字段; 走 JSON 全量展示.
    return <PreBlock>{linkifyText(JSON.stringify(input, null, 2))}</PreBlock>
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

// 暴露 helper for tests + 调试
export { actionSegment, shortName }
