import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, DetailsSection, pick, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const grepRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderInput(input) {
    const secondary = pick(input, ["path", "glob", "output_mode", "context", "ignore_case"])
    return (
      <div>
        <FieldLabel>pattern</FieldLabel>
        <PreBlock>{linkifyText(typeof input.pattern === "string" ? input.pattern : "")}</PreBlock>
        {Object.keys(secondary).length > 0 && (
          <DetailsSection summary="更多参数">
            {linkifyText(JSON.stringify(secondary, null, 2))}
          </DetailsSection>
        )}
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
