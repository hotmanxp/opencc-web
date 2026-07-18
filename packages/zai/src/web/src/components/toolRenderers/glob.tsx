import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const globRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderInput(input) {
    return (
      <div>
        <FieldLabel>pattern</FieldLabel>
        <PreBlock>{linkifyText(typeof input.pattern === "string" ? input.pattern : "")}</PreBlock>
        {typeof input.path === "string" && (
          <>
            <FieldLabel>path</FieldLabel>
            <PreBlock>{linkifyText(input.path)}</PreBlock>
          </>
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
