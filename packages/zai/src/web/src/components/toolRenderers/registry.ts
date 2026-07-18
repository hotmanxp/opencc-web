import type { ToolRenderer } from "./types.js"
import { bashRenderer } from "./bash.js"
import { genericRenderer } from "./generic.js"
import { globRenderer } from "./glob.js"
import { grepRenderer } from "./grep.js"
import { readRenderer } from "./read.js"
import { editRenderer } from "./edit.js"
import { writeRenderer } from "./write.js"
import { agentRenderer } from "./agent.js"

const registry: Record<string, ToolRenderer> = {
  Agent: agentRenderer,
  Bash: bashRenderer,
  Edit: editRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Read: readRenderer,
  Write: writeRenderer,
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
