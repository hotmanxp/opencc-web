import {
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../cost-tracker.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  addSessionHook,
  removeSessionHook,
} from '../../utils/hooks/sessionHooks.js'
import {
  getHooksConfigFromSnapshot,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  createActiveGoal,
  incrementIteration,
  type ActiveGoal,
} from './activeGoal.js'
import type { HookCommand } from '../../schemas/hooks.js'

const GOAL_HOOK_MATCHER = ''
// 30s is plenty for a Haiku eval call (typical 1-3s). Matches the upstream
// claude-code v2.1.177 prompt-hook timeout for /goal Stop evaluation.
const GOAL_HOOK_TIMEOUT_S = 30
const MAX_CONDITION_CHARS = 4_000

export type GateResult = {
  code: 'hooks_gate' | 'trust_gate'
  message: string
}

export function checkGoalGate(opts: {
  disableAllHooks: boolean
  hasTrustDialogAccepted: boolean
}): GateResult | null {
  if (opts.disableAllHooks) {
    return {
      code: 'hooks_gate',
      message:
        "/goal can't run while hooks are restricted (disableAllHooks is set in settings or by policy).",
    }
  }
  if (!opts.hasTrustDialogAccepted) {
    return {
      code: 'trust_gate',
      message:
        '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.',
    }
  }
  return null
}

export function checkGoalGateFromEnv(): GateResult | null {
  getHooksConfigFromSnapshot()
  const disableAll = shouldDisableAllHooksIncludingManaged()
  const trusted = checkHasTrustDialogAccepted()
  return checkGoalGate({ disableAllHooks: disableAll, hasTrustDialogAccepted: trusted })
}

export function normalizeCondition(raw: string): string | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'Goal condition cannot be empty.' }
  if (trimmed.length > MAX_CONDITION_CHARS) {
    return { error: `Goal condition must be ${MAX_CONDITION_CHARS.toLocaleString('en-US')} characters or fewer.` }
  }
  // Strip surrounding quotes if present
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export { MAX_CONDITION_CHARS, GOAL_HOOK_TIMEOUT_S, GOAL_HOOK_MATCHER }

const GOAL_STATUS_ATTACHMENT_TYPE = 'goal_status'

/**
 * Find all Stop session hooks that /goal has registered (prompt-typed, no
 * matcher, no skillRoot). Mirrors upstream claude-code v2.1.177's `r1_()` —
 * walks `appState.sessionHooks[sessionId].hooks.Stop` and picks the prompt
 * hooks that belong to /goal. Used by clearActiveGoal to remove them.
 */
function findGoalPromptHooks(appState: AppState, sessionId: string): HookCommand[] {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) return []
  const stopMatchers = store.hooks.Stop ?? []
  const out: HookCommand[] = []
  for (const matcher of stopMatchers) {
    if (matcher.matcher !== '' || matcher.skillRoot !== undefined) continue
    for (const entry of matcher.hooks) {
      if (entry.hook.type === 'prompt') out.push(entry.hook)
    }
  }
  return out
}

export function setActiveGoal(opts: {
  condition: string
  setAppState: (updater: (prev: AppState) => AppState) => void
  appState: AppState
  /** Optional messages array — when provided, the goal_status sentinel is
   *  pushed here so --resume can restore /goal state from the JSONL.
   *  See docs/sync-upstream-system-reminder-parity.md §42. */
  messages?: Message[]
}): { goal: ActiveGoal } {
  const sessionId = getSessionId()
  // tokensAtStart records input+output token count at goal-set time so the
  // "Goal achieved" footer can show tokens consumed during the goal. The
  // earlier implementation used getTotalCost() (USD) which was a unit-mix
  // bug — the field is now in tokens to match its name and downstream use.
  const tokensAtStart =
    getTotalInputTokens() + getTotalOutputTokens()
  const goal = createActiveGoal(opts.condition, tokensAtStart)

  // 1. Clear any prior goal Stop prompt hooks (idempotent — `/goal X` while
  //    one is already active should swap, not stack).
  for (const prior of findGoalPromptHooks(opts.appState, sessionId)) {
    removeSessionHook(opts.setAppState, sessionId, 'Stop', prior)
  }

  // 2. Set activeGoal in appState
  opts.setAppState(prev => ({ ...prev, activeGoal: goal }))

  // 3. Register a Stop PROMPT hook — upstream's exact mechanism. The
  //    condition itself is the prompt; execPromptHook wraps it in a
  //    system prompt that asks the LLM for {ok: true}/{ok: false, reason}.
  //    The LLM evaluates recent messages and decides whether to allow
  //    stopping. No need to parse JSON from the agent's text response.
  const goalPromptHook: HookCommand = {
    type: 'prompt',
    prompt: opts.condition,
    timeout: GOAL_HOOK_TIMEOUT_S,
  }
  addSessionHook(
    opts.setAppState,
    sessionId,
    'Stop',
    GOAL_HOOK_MATCHER,
    goalPromptHook,
  )

  // 4. Append sentinel attachment (state=set) for transcript restore
  appendGoalStatusAttachment({
    setAppState: opts.setAppState,
    messages: opts.messages,
    state: 'set',
    condition: opts.condition,
    iterations: 0,
  })

  return { goal }
}

export function markGoalAchieved(opts: {
  setAppState: (updater: (prev: AppState) => AppState) => void
  appState: AppState
  /** Optional messages array — see setActiveGoal for the contract. */
  messages?: Message[]
}): void {
  const sessionId = getSessionId()
  const existing = opts.appState.activeGoal
  if (!existing) return

  // 1. Remove all goal prompt hooks (mirrors upstream `a1_`).
  const promptHooks = findGoalPromptHooks(opts.appState, sessionId)
  if (promptHooks.length === 0) {
    logForDebugging(
      `markGoalAchieved: no goal prompt hook found for condition "${existing.condition}" — possible race or caller misuse`,
      { level: 'warn' },
    )
  } else {
    for (const hook of promptHooks) {
      removeSessionHook(opts.setAppState, sessionId, 'Stop', hook)
    }
  }

  // 2. Mark as achieved (so the UI shows "✔ Goal achieved (Xs · Y turn ·
  //    Zk tokens)" for a brief confirmation window) and schedule a clear.
  //    We do NOT null activeGoal immediately — the indicator needs the
  //    achievedAt + tokensAtEnd to render the summary.
  const achievedAt = Date.now()
  const tokensAtEnd = getTotalInputTokens() + getTotalOutputTokens()
  opts.setAppState(prev => ({
    ...prev,
    activeGoal: { ...existing, achievedAt, tokensAtEnd },
  }))

  // 3. Append sentinel attachment (state=achieve) for transcript restore
  appendGoalStatusAttachment({
    setAppState: opts.setAppState,
    messages: opts.messages,
    state: 'achieve',
    condition: existing.condition,
    iterations: existing.iterations,
    tokens: tokensAtEnd,
  })

  // 4. Schedule the achieved window to clear so the footer pill eventually
  //    disappears. The 5s window matches how /command status indicators
  //    auto-dismiss elsewhere in the TUI.
  const ACHIEVED_DISPLAY_MS = 5000
  setTimeout(() => {
    opts.setAppState(prev =>
      prev.activeGoal?.achievedAt === achievedAt
        ? { ...prev, activeGoal: null }
        : prev,
    )
  }, ACHIEVED_DISPLAY_MS)
}

/**
 * Backward-compat alias. The original API name `clearActiveGoal` is used
 * by 5+ callsites and historically meant "the goal was achieved, mark it
 * done". After v2 of the transcript-restore port we renamed the Stop-hook
 * success path to `markGoalAchieved` (clearer intent). The /goal clear
 * user-command path is now `forceClearActiveGoal`. This alias keeps the
 * existing 5+ callsites working without changes.
 *
 * @deprecated Use `markGoalAchieved` or `forceClearActiveGoal` directly.
 */
export const clearActiveGoal = markGoalAchieved

/**
 * /goal clear path — user explicitly cancels the active goal.
 *
 * Distinct from markGoalAchieved (Stop-hook success). Here we:
 * 1. Immediately null activeGoal (no 5s achieved window)
 * 2. Remove the Stop prompt hook so the LLM no longer evaluates
 * 3. Push a state=clear attachment so --resume knows the user
 *    explicitly cleared and should NOT re-activate
 */
export function forceClearActiveGoal(opts: {
  setAppState: (updater: (prev: AppState) => AppState) => void
  appState: AppState
  /** Optional messages array — see setActiveGoal for the contract. */
  messages?: Message[]
}): void {
  const sessionId = getSessionId()
  const existing = opts.appState.activeGoal
  if (!existing) return

  // 1. Remove all goal prompt hooks (mirrors upstream `a1_`).
  const promptHooks = findGoalPromptHooks(opts.appState, sessionId)
  for (const hook of promptHooks) {
    removeSessionHook(opts.setAppState, sessionId, 'Stop', hook)
  }

  // 2. Immediately null activeGoal — no achieved window for explicit clear
  opts.setAppState(prev => ({ ...prev, activeGoal: null }))

  // 3. Append sentinel attachment (state=clear) for transcript restore.
  //    sessionRestore treats this as "user said stop, do not re-activate".
  appendGoalStatusAttachment({
    setAppState: opts.setAppState,
    messages: opts.messages,
    state: 'clear',
    condition: existing.condition,
  })
}

function appendGoalStatusAttachment(opts: {
  setAppState: (updater: (prev: AppState) => AppState) => void
  messages?: Message[]
  state: 'set' | 'bump' | 'achieve' | 'clear'
  condition: string
  iterations?: number
  tokens?: number
}): void {
  // Write the in-memory sentinel for fast-path reads (backward compat).
  // Mirrors the v1 in-memory goalSentinel field — getActiveGoalFromTranscript
  // doesn't read this anymore (it scans the messages array), but the
  // footer pill and other UI consumers may read it.
  opts.setAppState(prev => ({
    ...prev,
    goalSentinel: {
      met: opts.state === 'achieve',
      condition: opts.condition,
      timestamp: Date.now(),
    },
  }))

  // Persist a goal_status attachment to the messages array when one is
  // available. Mirrors upstream 2.1.177 `vlK()` which yields a
  // goal_status attachment on every met/not-yet-met event. The `state`
  // field tells sessionRestore what to do on --resume:
  //   - 'set'|'bump' → re-activate the goal (re-register Stop hook)
  //   - 'achieve'    → achieved-pill for 5s
  //   - 'clear'      → user explicitly cleared; do NOT re-activate
  if (opts.messages) {
    opts.messages.push(
      createAttachmentMessage({
        type: 'goal_status',
        state: opts.state,
        condition: opts.condition,
        timestamp: Date.now(),
        iterations: opts.iterations,
        tokens: opts.tokens,
      }) as unknown as Message,
    )
  }
}

export type GoalState =
  | {
      state: 'active'
      condition: string
      iterations: number
      tokensAtStart: number
      setAt: number
    }
  | {
      state: 'achieved'
      condition: string
      iterations: number
      tokensAtEnd: number
      achievedAt: number
    }
  | { state: 'cleared'; condition: string }

/**
 * Reverse-scan the messages array for the most recent goal_status
 * attachment and return the goal state it represents. Returns null if
 * no goal was ever set in the session.
 *
 * Walks back-to-front: the LAST goal_status attachment is the most
 * recent state. This matches the upstream `restoreGoalFromTranscript`
 * shape (the in-memory ActiveGoal is always the latest state, not
 * the first).
 */
export function getActiveGoalFromTranscript(
  messages: Message[],
): GoalState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== 'attachment') continue
    const att = (m as unknown as {
      attachment?: {
        type?: string
        state?: 'set' | 'bump' | 'achieve' | 'clear'
        condition?: string
        iterations?: number
        tokens?: number
        timestamp?: number
      }
    }).attachment
    if (att?.type !== GOAL_STATUS_ATTACHMENT_TYPE) continue
    if (!att.state) continue

    const condition = att.condition ?? ''
    switch (att.state) {
      case 'set':
      case 'bump':
        return {
          state: 'active',
          condition,
          iterations: att.iterations ?? 0,
          tokensAtStart: 0, // unknown on resume; the running token counter
          setAt: att.timestamp ?? Date.now(),
        }
      case 'achieve':
        return {
          state: 'achieved',
          condition,
          iterations: att.iterations ?? 0,
          tokensAtEnd: att.tokens ?? 0,
          achievedAt: att.timestamp ?? Date.now(),
        }
      case 'clear':
        return { state: 'cleared', condition }
    }
  }
  return null
}

/**
 * Stop-hook success path helper. Called from `execPromptHook` when the
 * prompt-hook LLM returns `{ok: true}` (or the safe `fallbackHookResult`
 * `{ok: true}` default). Clears the active goal so the footer pill shows
 * "✔ Goal achieved" for 5s and then disappears.
 *
 * Idempotent — no-op when no goal is active OR when the goal is already in
 * the `achieved` window (the latter guard prevents re-clearing from
 * resetting the 5s summary timer on a duplicate hook fire).
 *
 * Returns `true` if a clear was applied, `false` if no-op.
 *
 * Why this lives here (and not in `execPromptHook`)? Goal state lives in
 * `services/goal`; the hooks module is a generic LLM-eval utility and
 * shouldn't know about `activeGoal` semantics. Centralizing the
 * "goal-clearing on Stop-hook-success" transition here keeps `execPromptHook`
 * agnostic of which hook called it (Stop vs SessionStart vs ...).
 */
export function clearActiveGoalIfActive(opts: {
  toolUseContext: Pick<ToolUseContext, 'getAppState' | 'setAppState'>
}): boolean {
  const appState = opts.toolUseContext.getAppState()
  const existing = appState.activeGoal
  if (!existing || existing.achievedAt !== undefined) return false
  clearActiveGoal({
    setAppState: opts.toolUseContext.setAppState,
    appState,
  })
  return true
}

/**
 * Stop-hook blocking path helper. Called from `execPromptHook` when the
 * prompt-hook LLM returns `{ok: false, reason: "..."}` — i.e. the model
 * decided the goal isn't met yet and the agent must continue working.
 * Each block is one observable iteration of the goal loop, surfaced in
 * the footer pill as `◎ /goal active (Ns · N iterations)`.
 *
 * Idempotent — no-op when no goal is active OR when the goal is already
 * achieved (achieved goals can't accumulate more iterations).
 *
 * Returns `true` if iterations were bumped, `false` if no-op.
 */
export function bumpGoalIteration(opts: {
  toolUseContext: Pick<
    ToolUseContext,
    'getAppState' | 'setAppState'
  > & { messages?: Message[] }
}): boolean {
  const appState = opts.toolUseContext.getAppState()
  const existing = appState.activeGoal
  if (!existing || existing.achievedAt !== undefined) return false
  opts.toolUseContext.setAppState(prev => {
    if (!prev.activeGoal) return prev
    return {
      ...prev,
      activeGoal: incrementIteration(prev.activeGoal),
    }
  })
  // Persist the bumped iteration as a goal_status attachment so
  // --resume restores the same iteration count. Mirrors upstream
  // 2.1.177 `vlK()` which yields a goal_status attachment on every
  // Stop-hook iteration.
  appendGoalStatusAttachment({
    setAppState: opts.toolUseContext.setAppState,
    messages: opts.toolUseContext.messages,
    state: 'bump',
    condition: existing.condition,
    iterations: existing.iterations + 1,
  })
  return true
}
