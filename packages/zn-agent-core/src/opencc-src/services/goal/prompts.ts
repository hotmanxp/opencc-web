/**
 * Upstream-compatibility prompts for /goal Stop-hook LLM evaluation.
 * Source: claude-code 2.1.177 (binary-extracted, all-strings.txt:536004-536014)
 * Reconstructed from template literal split across multiple string runs.
 * Brand swapped: "Claude Code" → "OpenCC" (per 2026-06-15 rebrand,
 * subsequent brand consolidation uses "OpenCC" without space).
 */

/** Stop hook (only /goal fires this; other prompt hooks use GENERIC). */
export const GOAL_STOP_CONDITION_PROMPT = `You are evaluating a stop-condition hook in OpenCC. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

/** Generic prompt hook (non-Stop, e.g. UserPromptSubmit). */
export const GOAL_HOOK_GENERIC_PROMPT = `You are evaluating a hook condition in OpenCC. Judge whether the user-provided condition is met.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<reason the condition is met>"}
- {"ok": false, "reason": "<reason the condition is not met>"}

Always include a "reason" field.`

/** Retry path (verbatim from prior RETRY_SYSTEM_PROMPT, no change). */
export const RETRY_PROMPT = `You are evaluating a hook in OpenCC. Your previous response could not be parsed as JSON.

CRITICAL — your reply will be fed to JSON.parse and MUST succeed:
- Return ONLY the JSON object, with NO surrounding prose, NO markdown code fences, NO leading/trailing text.
- Output exactly: {"ok": true}  OR  {"ok": false, "reason": "..."}
- Do not include greetings, explanations, or anything outside the braces.`
