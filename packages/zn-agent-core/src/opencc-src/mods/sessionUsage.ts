/**
 * `$.session.usage()` — the read behind the status line and `/context`.
 *
 * Everything here is a READ of state the host already keeps. The one genuinely
 * expensive path — upstream's `breakdown: 'full'`, which sends a token-count
 * request per tool and memory file — is not wired: reaching it needs the tool
 * permission context, the resolved tool list and the agent definitions, and
 * `analyzeContextUsage` takes all three. The transcript it would measure is
 * reachable too (`query.ts` holds `toolUseContext.messages`), but the only
 * breakdown builder that takes messages calls the token-counting API, so
 * wiring it would make every `$.session.usage()` call billable.
 *
 * So: there is no local estimate and no fallback. A mod that passes
 * `breakdown: 'summary'` or `'full'` gets the field ABSENT — `undefined` — and
 * absence is the signal that it was not computed. There is no flag saying
 * which, because nothing produces one. A previous version of this header
 * claimed otherwise; `SessionUsageFacts.breakdown` below is the input port a
 * host publisher would fill, and no production call site does.
 *
 * Upstream's declaration is `SessionUsage` (d.ts:11711); the field names below
 * are its own. Note that an archaeology report sketched a different shape
 * (`{startedAt, model, messages, windows, provider, cost}`) which the d.ts does
 * not have — see the note on `ModSessionUsage` in nouns.ts.
 */

import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalInputTokens,
} from '../bootstrap/state.js'
import { getContextWindowForModel } from '../utils/context.js'
import { getMainLoopModel } from '../utils/model/model.js'
import type {
  ModSessionRateLimit,
  ModSessionUsage,
  ModSessionUsageArgs,
} from './nouns.js'

/**
 * What the host publishes for `usage()` to read.
 *
 * Same shape as `SessionFacts` beside it: the host knows these, the noun only
 * reads, and a field nobody publishes is absent rather than faked. `messages`
 * is what `context.tokens` is derived from — a session that has made no API
 * call has no "last response" to report, which is why `tokens` is optional.
 */
export type SessionUsageFacts = {
  startedAt?: number
  rateLimits?: readonly ModSessionRateLimit[]
  /**
   * The compaction-window figures `/context` breaks down. Host publishes them
   * only when it has computed them; the noun never recomputes — reaching
   * upstream's `breakdown: 'full'` needs `analyzeContextUsage`, which sends
   * one token-count request per tool and memory file.
   */
  breakdown?: {
    categories: Array<{ name: string; tokens: number }>
    totalTokens: number
    maxTokens: number
  }
}

const usageFacts: SessionUsageFacts = {}

/**
 * When this session began.
 *
 * opencc has no session-start timestamp of its own: the TUI keeps one in a
 * React ref and `bridgeMain` keeps a per-session map, neither reachable from a
 * mod. Upstream's documented use for this field is staleness
 * (`stat.mtimeMs < (await $.session.usage()).startedAt`), so an answer of 0
 * would make every file look older than the session — a confidently wrong
 * answer rather than an absent one.
 *
 * Module-level and stamped on first read, so it survives `/clear` restarting
 * the transcript without resetting the process.
 */
let startedAtMs = 0

export function sessionStartedAt(): number {
  if (startedAtMs === 0) startedAtMs = Date.now()
  return startedAtMs
}

export function setSessionUsageFacts(facts: SessionUsageFacts): void {
  Object.assign(usageFacts, facts)
}

export function clearSessionUsageFacts(): void {
  for (const key of Object.keys(usageFacts)) {
    delete usageFacts[key as keyof SessionUsageFacts]
  }
}

/**
 * Input tokens the session has been answered over — the status line's
 * `total_input_tokens`.
 *
 * Read from the cost ledger rather than by scanning the transcript for the
 * newest assistant message. The ledger is the same numbers `/cost` totals and
 * `addToTotalSessionCost` writes on every priced response, which makes it
 * correct from any mod call site; scanning messages instead meant the answer
 * depended on WHEN the mod asked, because the assistant message carrying the
 * usage block only exists after the model has answered.
 *
 * Zero is a real reading (a session that has made no API call yet) and is
 * reported as 0 rather than omitted — unlike `tokens` upstream types as
 * optional, it is genuinely always computable here, and a mod asking "how full
 * is the window" wants 0, not undefined.
 */
function sessionInputTokens(): number {
  return (
    getTotalInputTokens() +
    getTotalCacheCreationInputTokens() +
    getTotalCacheReadInputTokens()
  )
}

export function readSessionUsage(
  args?: ModSessionUsageArgs,
): ModSessionUsage {
  const window = getContextWindowForModel(getMainLoopModel() as string)
  const tokens = sessionInputTokens()

  const context: ModSessionUsage['context'] = { tokens, window }
  if (window > 0) {
    context.percent = Math.min(100, (tokens / window) * 100)
  }

  // `breakdown` is attached only when the caller asked for one AND the host
  // published one. Today no production call site publishes it, so the field is
  // always absent and `undefined` is the caller-facing "not computed" signal —
  // there is no substitute value computed locally, and no flag saying which.
  // `columns` is a rendering hint for a grid this API never draws — it is
  // validated and then dropped, because answering with a layout width would be
  // claiming to render.
  if (args?.breakdown !== undefined && usageFacts.breakdown !== undefined) {
    context.breakdown = { ...usageFacts.breakdown }
  }

  return {
    startedAt: usageFacts.startedAt ?? 0,
    context,
    rateLimits: usageFacts.rateLimits ? [...usageFacts.rateLimits] : [],
    cost: { usd: getTotalCostUSD() },
  }
}