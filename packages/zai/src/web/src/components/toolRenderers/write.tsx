import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const writeRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    if (!("content" in input)) return truncate(p, 80)
    const c = input.content
    const lines = typeof c === "string" ? (c === "" ? 0 : c.split("\n").length) : 0
    return truncate(`${p} (${lines} lines)`, 80)
  },

  renderInput(input) {
    const filePath = typeof input.file_path === "string" ? input.file_path : ""
    const content = typeof input.content === "string" ? input.content : ""
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>{linkifyText(filePath)}</PreBlock>
        <FieldLabel>完整内容</FieldLabel>
        <PreBlock>{linkifyText(content)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
