import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const editRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    const all = input.replace_all === true ? " (all)" : ""
    return truncate(`${p}${all}`, 80)
  },

  renderInput(input) {
    const oldStr = typeof input.old_string === "string" ? input.old_string : ""
    const newStr = typeof input.new_string === "string" ? input.new_string : ""
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>
          {linkifyText(typeof input.file_path === "string" ? input.file_path : "")}
        </PreBlock>
        <FieldLabel>old_string</FieldLabel>
        <PreBlock>{linkifyText(oldStr)}</PreBlock>
        <FieldLabel>new_string</FieldLabel>
        <PreBlock>{linkifyText(newStr)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
