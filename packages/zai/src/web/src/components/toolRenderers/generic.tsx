import type { ToolRenderer } from "./types.js"
import { truncate } from "./shared.js"

export const genericRenderer: ToolRenderer = {
  preview(input) {
    const firstKey = Object.keys(input)[0]
    if (!firstKey) return ""
    const v = input[firstKey]
    if (v == null) return ""
    const text = typeof v === "string" ? v : JSON.stringify(v)
    return truncate(text, 80)
  },
}
