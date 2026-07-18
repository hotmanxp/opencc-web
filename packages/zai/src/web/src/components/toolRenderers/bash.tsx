import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, DetailsSection, pick, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"
import { parseBashOutput } from "./bashParser.js"

export const bashRenderer: ToolRenderer = {
  preview(input) {
    const desc = input.description
    if (typeof desc === "string" && desc.trim()) return truncate(desc.trim(), 80)
    const cmd = input.command
    if (typeof cmd === "string" && cmd.trim()) return truncate(cmd.trim(), 80)
    return ""
  },

  renderInput(input) {
    const command = typeof input.command === "string" ? input.command : ""
    const secondary = pick(input, ["description", "timeout", "run_in_background"])
    return (
      <div>
        <FieldLabel>命令</FieldLabel>
        <PreBlock>{linkifyText(command)}</PreBlock>
        {Object.keys(secondary).length > 0 && (
          <DetailsSection summary="更多参数">
            {linkifyText(JSON.stringify(secondary, null, 2))}
          </DetailsSection>
        )}
      </div>
    )
  },

  renderOutput(output) {
    if (output === undefined || output === null) return null
    const { stdout, stderr, plain } = parseBashOutput(stringFromOutput(output))
    return (
      <>
        {stdout && (
          <PreBlock variant="success">{linkifyText(stdout)}</PreBlock>
        )}
        {stderr && <PreBlock variant="warn">{linkifyText(stderr)}</PreBlock>}
        {plain && <PreBlock>{linkifyText(plain)}</PreBlock>}
      </>
    )
  },
}
