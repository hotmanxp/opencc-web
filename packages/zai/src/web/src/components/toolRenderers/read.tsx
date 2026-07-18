import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const readRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    const offset = toNum(input.offset)
    const limit = toNum(input.limit)
    const range = offset != null && limit != null ? ` L${offset}-${offset + limit - 1}` : ""
    return truncate(`${p}${range}`, 80)
  },

  renderInput(input) {
    const offset = toNum(input.offset)
    const limit = toNum(input.limit)
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>{linkifyText(typeof input.file_path === "string" ? input.file_path : "")}</PreBlock>
        {(offset != null || limit != null) && (
          <PreBlock>
            {`offset=${offset ?? 0}${limit != null ? `, limit=${limit}` : ""}`}
          </PreBlock>
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
