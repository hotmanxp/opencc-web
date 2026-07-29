// src/utils/ultracodePrompt.ts
//
// Appended to workflow-spawned subagent system prompts when isUltracodeActive() is true.
//
// Source: VERBATIM from upstream claude-code v2.1.170 (Workflow tool
// description, extracted from the compiled binary as the `Ut8` template
// literal at offset 530459). Re-verified verbatim against v2.1.177
// binary extract on 2026-06-15 — all four sections (Ultracode opt-in
// rule, Composing patterns, Quality patterns, Scale to what the user
// asked for) appear contiguously in the upstream template.
//
// This file is the single source of truth for ultracode subagent text.
// See Task 4 of docs/superpowers/plans/2026-06-10-plan9-ultracode-sync.md.

import { getUltracodeReminder, isUltracodeActive } from './ultracode.ts'

/**
 * Main-session opt-in block for the ultracode keyword trigger.
 *
 * Verbatim from upstream claude-code v2.1.177 (binary extract line 530459).
 * This is the upstream `**Ultracode.**` paragraph that the LLM sees as
 * part of the user-meta message queue when the user types the keyword
 * `ultracode X` or sets `/effort ultracode`. Upstream delivers this as a
 * user-role message with `isMeta: true` (see binary extract line 532977
 * `workflow_keyword_request` / `ultra_effort_enter` dispatch) — NOT as a
 * system-role instruction. OpenCC matches that delivery mechanism:
 * appended to the user-meta message list via `applyKeywordTrigger` and
 * `setEffortValue('ultracode')`.
 *
 * The full quality-pattern taxonomy (Composing patterns / Quality patterns
 * / Scale section) lives in the WorkflowTool tool description (line 129)
 * and in `ULTRACODE_SUBAGENT_PROMPT` for spawned sub-agents. This
 * main-session block is just the opt-in paragraph.
 */
export const ULTRACODE_OPT_IN_BLOCK = `**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce \u2014 token cost is not a constraint. For multi-phase work (understand \u2192 design \u2192 implement \u2192 review), that often means several workflows in sequence \u2014 one per phase \u2014 so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings \u2014 unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.`

export const ULTRACODE_SUBAGENT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

---

**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. For multi-phase work (understand → design → implement → review), that often means several workflows in sequence — one per phase — so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings — unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
  while (dry < 2) {                                              // loop-until-dry
    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
      agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(b => seen.add(key(b)))
    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
      parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
        agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  return confirmed
  // dedup vs \`seen\`, NOT \`confirmed\` — else judge-rejected findings reappear every round and it never converges.

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
    const votes = await parallel(Array.from({length: 3}, () => () =>
      agent(\`Try to refute: \${claim}. Default to refuted=true if uncertain.\`, {schema: VERDICT})))
    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), \`log()\` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).`

/**
 * Returns the system prompt array with the ultracode block appended, when
 * `isUltracodeActive()` is true. Returns the input array unchanged otherwise.
 *
 * Used by runAgent.ts and AgentTool.tsx (fork-parent path) to inject the
 * verbatim upstream ultracode prelude into subagent system prompts at spawn
 * time, matching upstream v2.1.170 behavior.
 */
export function withUltracodePrompt(
  systemPrompt: readonly string[],
): readonly string[] {
  if (!isUltracodeActive()) return systemPrompt
  return [...systemPrompt, ULTRACODE_SUBAGENT_PROMPT]
}

/**
 * Returns the system prompt array with the ultracode `<system-reminder>`
 * appended. Unlike `withUltracodePrompt`, this helper ALWAYS appends the
 * reminder (on or off) — matching upstream claude-code v2.1.170, which
 * always emits the reminder so the subagent knows whether to follow the
 * ultracode block or revert to the opt-in rule.
 *
 * Apply AFTER `withUltracodePrompt` so the reminder sits below the
 * ultracode block in the prompt array.
 */
export function withUltracodeReminder(
  systemPrompt: readonly string[],
): string[] {
  return [...systemPrompt, getUltracodeReminder()]
}
