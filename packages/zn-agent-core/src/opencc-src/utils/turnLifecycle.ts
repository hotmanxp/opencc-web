/**
 * Turn-lifecycle handoff between the query loop and tools that own long-running
 * work (Bash background commands).
 *
 * When a turn is aborted or is about to end with a final response, commands
 * still running in the foreground would be killed. Registering here lets them
 * hand themselves to the background instead, so their output is not lost.
 *
 * Mirrors Claude Code 2.1.287's turn-abort backgrounding.
 */

type TurnEndListener = () => void

/**
 * Listeners for the turn currently in flight. Keyed per agent so a subagent's
 * turn ending does not background the main loop's commands, and vice versa.
 */
const listenersByScope = new Map<string, Set<TurnEndListener>>()

/** Identity of the current turn's owner. Subagents register under their own id. */
let currentScope = 'main'

export function setTurnEndScope(agentId: string | undefined): void {
  currentScope = agentId ?? 'main'
}

export function getTurnEndScope(): string {
  return currentScope
}

export function registerTurnEndListener(listener: TurnEndListener): () => void {
  let set = listenersByScope.get(currentScope)
  if (!set) {
    set = new Set()
    listenersByScope.set(currentScope, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByScope.delete(currentScope)
  }
}

/**
 * Notify every listener registered for the current turn that the turn is
 * ending. Listeners that throw are skipped so one bad registration cannot
 * strand the rest — a failed handoff just means the command dies with the
 * turn, which is the pre-existing behaviour.
 *
 * Clearing the set afterwards keeps a listener from firing again on a later
 * turn of the same agent.
 */
export function fireTurnEnd(): void {
  const set = listenersByScope.get(currentScope)
  if (!set) return
  // Copy before iterating — a listener may unregister itself.
  for (const listener of Array.from(set)) {
    try {
      listener()
    } catch {
      // See above.
    }
  }
  listenersByScope.delete(currentScope)
}

/** Test seam: drop all registrations. */
export function clearTurnEndListeners(): void {
  listenersByScope.clear()
}
