import type { ToolRenderer } from "./types.js"
import { genericRenderer } from "./generic.js"

const registry: Record<string, ToolRenderer> = {
  // Per-tool renderers are registered in their own tasks (Tasks 4–10).
  // This stub intentionally contains only the fallback so the wiring works
  // end-to-end from Task 1; later tasks call setRenderer() to plug in.
}

export function setRenderer(name: string, renderer: ToolRenderer): void {
  registry[name] = renderer
}

export function getRenderer(name: string): ToolRenderer {
  return registry[name] ?? genericRenderer
}

export function _renderersForTest(): Readonly<Record<string, ToolRenderer>> {
  return registry
}
