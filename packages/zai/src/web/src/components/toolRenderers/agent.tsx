import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

function firstLine(s: string): string {
  return s.split(/\r?\n/, 1)[0]?.trim() ?? ""
}

export const agentRenderer: ToolRenderer = {
  preview(input) {
    const desc = input.description
    if (typeof desc === "string" && desc.trim()) return truncate(desc.trim(), 80)
    const p = input.prompt
    if (typeof p === "string" && p.trim()) return truncate(firstLine(p), 80)
    return ""
  },

  displayName(input) {
    const t = input.subagent_type
    return `${typeof t === "string" && t.trim() ? t.trim() : "general-purpose"} (agent)`
  },

  renderInput(input) {
    const subType = typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : "general-purpose"
    const prompt = typeof input.prompt === "string" ? input.prompt : ""
    return (
      <div>
        <FieldLabel>subagent_type</FieldLabel>
        <PreBlock>{linkifyText(subType)}</PreBlock>
        <FieldLabel>prompt</FieldLabel>
        <PreBlock>{linkifyText(prompt)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
