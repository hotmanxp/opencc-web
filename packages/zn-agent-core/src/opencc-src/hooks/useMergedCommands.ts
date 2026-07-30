import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo } from 'react'
import type { Command } from '../commands.js'

export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands: Command[],
): Command[] {
  // Use map of names as stable dependency key
  const initialKey = initialCommands.map(c => c.name).join('-')
  const mcpKey = mcpCommands.map(c => c.name).join('-')
  return useMemo(() => {
    if (mcpCommands.length > 0) {
      return uniqBy([...initialCommands, ...mcpCommands], 'name')
    }
    return initialCommands
  }, [initialCommands, mcpCommands, initialKey, mcpKey])
}
