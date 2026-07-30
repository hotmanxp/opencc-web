export type ActiveGoal = {
  condition: string
  iterations: number
  setAt: number
  tokensAtStart: number
  // When set, the goal has been achieved and the UI shows the summary
  // ("✔ Goal achieved (...)") for a short confirmation window. Cleared by
  // a timer in clearActiveGoal so the footer pill eventually disappears.
  achievedAt?: number
  tokensAtEnd?: number
}

export function createActiveGoal(
  condition: string,
  tokensAtStart: number,
  now: number = Date.now(),
): ActiveGoal {
  return {
    condition: condition.trim(),
    iterations: 0,
    setAt: now,
    tokensAtStart,
  }
}

export function incrementIteration(goal: ActiveGoal): ActiveGoal {
  if (!goal) return createActiveGoal('', 0)
  return { ...goal, iterations: goal.iterations + 1 }
}
