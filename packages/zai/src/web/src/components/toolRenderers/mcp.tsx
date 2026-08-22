import React from "react"
import type { ToolRenderer } from "./types.js"
import { PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

// MCP tool names 形如 `mcp_<server>_<action>` (opencc, e.g. `mcp_zinai_browser_navigate`)
// 或 `mcp:<server>:<tool>` (dsh 内核, packages/dsh-bridge/src/tools/mcp.ts).
// MCP 工具集是用户/服务端动态注入的, 没法为每一个静态注册一个 renderer.
// 走前缀派发: 任何 `mcp_` 或 `mcp:` 开头的 name 都用 mcpRenderer (registry 用 isMcpToolName 路由).
//
// 设计目标: 比 generic 行为略可读, 但 schema 不固定没法抽主字段 -
//   1. pill 已经是完整长名 (`mcp_zinai_browser_navigate`), preview 不再粘全长
//   2. preview 显示第一个 input value 字符串 (和 generic 一样), 让用户在折叠态看到 URL/参数
//   3. input: 走 JSON 全量展示 (无 FieldLabel, 跟 generic 统一)
//   4. output: 跟 generic 等价的 success <pre>
const MCP_UNDERSCORE_PREFIX = "mcp_"
const MCP_COLON_PREFIX = "mcp:"

function stripPrefix(fullName: string): string {
  if (fullName.startsWith(MCP_UNDERSCORE_PREFIX)) return fullName.slice(MCP_UNDERSCORE_PREFIX.length)
  if (fullName.startsWith(MCP_COLON_PREFIX)) return fullName.slice(MCP_COLON_PREFIX.length)
  return fullName
}

function shortName(fullName: string): string {
  const stripped = stripPrefix(fullName)
  return stripped === fullName ? fullName : stripped
}

function actionSegment(fullName: string): string {
  // 取最后一段作为可读动作. 分隔符以"主分隔符"为准 —
  //   dsh 用冒号 `mcp:zinai:browser_navigate` → action = `browser_navigate`
  //   opencc 用下划线 `mcp_zinai_browser_navigate` → action = `navigate`
  // 优先选冒号 (dsh 工具命名更短), 没有再选下划线 (opencc 兜底).
  const colonIdx = fullName.lastIndexOf(":")
  if (colonIdx >= 0 && fullName.startsWith(MCP_COLON_PREFIX)) {
    return fullName.slice(colonIdx + 1)
  }
  const underscoreIdx = fullName.lastIndexOf("_")
  return underscoreIdx >= 0 ? fullName.slice(underscoreIdx + 1) : shortName(fullName)
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
  return name.startsWith(MCP_UNDERSCORE_PREFIX) || name.startsWith(MCP_COLON_PREFIX)
}

// 暴露 helper for tests + 调试
export { actionSegment, shortName }
