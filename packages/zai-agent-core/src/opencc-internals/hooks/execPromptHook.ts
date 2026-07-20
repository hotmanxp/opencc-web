// @ts-nocheck
import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import {
  bumpGoalIteration,
  clearActiveGoalIfActive,
} from '../../services/goal/hooks.js'
import {
  GOAL_HOOK_GENERIC_PROMPT,
  GOAL_STOP_CONDITION_PROMPT,
  RETRY_PROMPT,
} from '../../services/goal/prompts.js'
import type { ToolUseContext } from '../../Tool.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

/**
 * Strip a markdown code fence (``` or ```json), if present, and return the
 * inner text. Accepts trailing prose after the closing fence — only the
 * content between the first opener and the matching closer is returned.
 */
function stripMarkdownFence(s: string): string {
  // Match ```lang?\n ... \n``` anywhere in s
  const fenceRe = /```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```/
  const m = s.match(fenceRe)
  return m ? m[1].trim() : s
}

/**
 * Final fallback when ALL parsing strategies have failed and we are about to
 * return a `non_blocking_error`. Returns a safe default `{ok: false}`.
 *
 * Why `ok: false` (strict, not permissive)?  Per user feedback 2026-06-13:
 * when the hook LLM (Haiku / MiniMax-M2.7-highspeed) fails to produce a
 * parseable verdict, defaulting to `ok: true` was masking cases where the
 * model genuinely couldn't evaluate the goal — letting the agent stop when
 * the goal was not actually met (false negative on the eval side). Strict
 * default to `ok: false` means: "no parseable evidence = not satisfied" —
 * the agent must continue working and produce clearer evidence on the next
 * turn. This pairs with `tools: []` + `extractHookResponseContent` to push
 * the model toward the text channel; if it still fails to emit JSON, that
 * IS the signal that it couldn't decide, and we err on the side of more
 * work, not less.
 *
 * Note: this is the inverse of the previous (2026-06-13 morning) rationale,
 * which preferred `ok: true` to unblock users stranded by a Haiku eval
 * parse failure. That preference traded false positives (let stop when
 * unmet) for false negatives (block stop when met); user explicitly
 * preferred the other direction.
 *
 * Returns `null` only if the response contained parseable JSON (in which
 * case the caller should not have invoked the fallback) — empty/whitespace
 * is treated as "no signal, default to ok=false".
 */
export function fallbackHookResult(response: string): { ok: boolean; reason: string } | null {
  const trimmed = response.trim()
  // If the response contains parseable JSON, the caller should have used
  // parsePromptHookResponse and didn't — surface that as null so we don't
  // silently override a real hook verdict.
  if (trimmed && parsePromptHookResponse(trimmed) !== null) return null
  return {
    ok: false,
    reason: trimmed
      ? 'hook returned no parseable JSON; defaulting to ok=false (strict)'
      : 'hook returned empty response; defaulting to ok=false (strict)',
  }
}

/**
 * Pick the most useful text payload out of an LLM response's content blocks
 * for downstream JSON.parse.
 *
 * Primary path: join `text` blocks (existing behavior, covers models that
 * follow the system-prompt contract and return `{"ok": true}` as text).
 *
 * Fallback path: if the model returned a `tool_use` block whose `input` looks
 * like the expected `{ok: boolean, reason?: string}` schema, stringify that
 * input. This recovers the case where the model — typically a small/fast one
 * without structured-outputs beta support (e.g. MiniMax-M2.7-highspeed) —
 * short-circuits the JSON-only system prompt by emitting `{ok:true}` inside a
 * tool_use block (empty or otherwise). Without this fallback the caller sees
 * an empty string and JSON.parse fails with "Unexpected EOF".
 *
 * Safety: we only stringify `tool_use.input` if it CONFORMS to the schema
 * (boolean `ok` field, optional string `reason`). If it doesn't look like the
 * hook response schema (e.g. a real tool invocation like `Bash`), we return
 * "" and let the caller fail loudly. This avoids silently accepting arbitrary
 * payloads the model might hallucinate as "tool" calls.
 */
export function extractHookResponseContent(
  blocks: string | readonly unknown[],
): string {
  const textParts: string[] = []
  for (const b of blocks) {
    if (
      b &&
      typeof b === 'object' &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string'
    ) {
      textParts.push((b as { text: string }).text)
    }
  }
  const textJoined = textParts.join('').trim()
  if (textJoined) return textJoined

  // No text content — look for a tool_use block whose input matches the
  // hook response schema. This is the MiniMax-M2.7-highspeed failure mode
  // observed in /goal Stop-hook bug reproduction on 2026-06-13.
  for (const b of blocks) {
    if (
      !b ||
      typeof b !== 'object' ||
      (b as { type?: unknown }).type !== 'tool_use'
    ) {
      continue
    }
    const input = (b as { input?: unknown }).input
    if (
      input &&
      typeof input === 'object' &&
      typeof (input as { ok?: unknown }).ok === 'boolean'
    ) {
      const reason = (input as { reason?: unknown }).reason
      if (reason === undefined || typeof reason === 'string') {
        return JSON.stringify(input)
      }
    }
  }
  return ''
}

/**
 * Strip tool-call wrapper noise from `s`, returning the remainder trimmed.
 *
 * The small/fast model used for prompt hooks (MiniMax-M2.7-highspeed) emits
 * tool-call blocks even when told to return JSON-only and even with
 * `tools: []` passed in — it's a model-side formatting quirk, not an
 * indication that a real tool was invoked. Two wrapper shapes have been
 * observed:
 *
 *   1. `[TOOL_CALL]...[/TOOL_CALL]` — Perl-heredoc style, with `{tool =>
 *      "Read", args => { ... }}` inside. This is the most common shape on
 *      2026-06-13 and is dangerous because the inner Perl hash contains `{`
 *      that confuses `extractFirstBalancedObject` — without stripping, the
 *      balancer grabs the wrong `{...}` and the JSON.parse fails.
 *
 *   2. `<minimax:tool_call>...</minimax:tool_call>` — XML style seen on an
 *      earlier MiniMax variant. Still stripped for safety.
 *
 * If the response was pure tool-call noise with no surrounding JSON we
 * return "" so the caller can fail cleanly.
 */
export function stripMinimaxToolCallWrapper(s: string): string {
  return s
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .trim()
}

/**
 * Find the first balanced top-level `{...}` object in `s`, ignoring braces
 * inside strings and template literals. Treats runs of 3+ backticks as a
 * markdown fence delimiter (skipped as a unit). Returns null if no balanced
 * object is found.
 */
function extractFirstBalancedObject(s: string): string | null {
  let start = -1
  let depth = 0
  let inString: false | '"' | "'" | '`' = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Skip markdown fence runs (3+ backticks) entirely.
    if (c === '`' && !inString) {
      let run = 0
      while (i < s.length && s[i] === '`') {
        run++
        i++
      }
      i-- // step back so the outer for-loop advances past the run
      if (run >= 3) continue
      // Single backtick outside a string still acts as a template literal
      // delimiter for brace-counting purposes.
      inString = '`'
      continue
    }
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === inString) {
        inString = false
      }
      continue
    }
    if (c === '{') {
      if (start === -1) start = i
      depth++
      continue
    }
    if (c === '}') {
      if (start === -1) continue
      depth--
      if (depth === 0) {
        return s.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * Parse a prompt-hook LLM response into a JS object.
 *
 * LLMs (including MiniMax-M2.7-highspeed and others without structured-output
 * beta headers) often wrap JSON in markdown fences or precede it with prose.
 * We try three strategies in order:
 *   1. Direct JSON.parse on the trimmed response.
 *   2. Strip ```lang fences and retry.
 *   3. Extract the first balanced `{...}` object from the response.
 *
 * Returns null when nothing parseable is found.
 */
export function parsePromptHookResponse(response: string): unknown | null {
  const trimmed = response.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }
  const unfenced = stripMarkdownFence(trimmed)
  if (unfenced !== trimmed) {
    try {
      return JSON.parse(unfenced)
    } catch {
      // fall through
    }
  }
  const balanced = extractFirstBalancedObject(trimmed)
  if (balanced) {
    try {
      return JSON.parse(balanced)
    } catch {
      // fall through
    }
  }
  return null
}

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    // Per upstream claude-code 2.1.177: when the hook event is Stop, wrap
    // the condition with "Condition: " prefix so the LLM evaluator has
    // immediate context about what to evaluate. Non-Stop prompt hooks
    // (UserPromptSubmit, etc.) pass the prompt through unchanged.
    const userMessageContent = hookEvent === 'Stop'
      ? `Condition: ${processedPrompt}`
      : processedPrompt
    const userMessage = createUserMessage({ content: userMessageContent })

    // Prepend conversation history if provided
    const messagesToQuery: Message[] =
      messages && messages.length > 0
        ? [...messages, userMessage as Message]
        : [userMessage as Message]

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    // First-attempt system prompt. The `Retry` variant below is more
    // aggressive — used when the first response isn't parseable JSON.
    //
    // Select prompt by hook event:
    //   - Stop → detailed 3-shape guidance with "impossible" semantics
    //     (matches upstream claude-code 2.1.177)
    //   - Other events → generic 2-shape (UserPromptSubmit etc.)
    const FIRST_SYSTEM_PROMPT =
      hookEvent === 'Stop'
        ? GOAL_STOP_CONDITION_PROMPT
        : GOAL_HOOK_GENERIC_PROMPT

    const RETRY_SYSTEM_PROMPT = RETRY_PROMPT

    const MAX_ATTEMPTS = 2

    try {
      const resolvedModel = hook.model ?? getSmallFastModel()
      logForDebugging(
        `Hooks[execPromptHook DIAG]: hookName=${hookName} hookEvent=${hookEvent} ` +
          `resolvedModel=${resolvedModel} outputFormat.type=json_schema ` +
          `messagesToQuery.length=${messagesToQuery.length}`,
      )

      let json: unknown = null
      let lastRawResponse = ''
      let lastParseErr = ''
      let succeededOnAttempt = 0
      let fullResponse = ''

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal.aborted) break

        const systemPrompt =
          attempt === 1 ? FIRST_SYSTEM_PROMPT : RETRY_SYSTEM_PROMPT
        if (attempt > 1) {
          logForDebugging(
            `Hooks[execPromptHook DIAG]: retrying with stronger prompt (attempt ${attempt}/${MAX_ATTEMPTS}); previousRawResponse=${JSON.stringify(lastRawResponse).slice(0, 200)}`,
          )
        }

        const response = await queryModelWithoutStreaming({
          messages: messagesToQuery,
          systemPrompt: asSystemPrompt([systemPrompt]),
          thinkingConfig: { type: 'disabled' as const },
          // Root fix for the /goal Stop-hook bug: don't expose the agent's full
          // tool list to the hook LLM. The previous code passed
          // `toolUseContext.options.tools` (every tool the agent has, often
          // 100+) which gave the small/fast model a tool_use backdoor — it
          // would smuggle `{ok:true}` into a `tool_use[].input` block instead
          // of returning text. The text extractor dropped that block, leaving
          // "" for JSON.parse → "Unexpected EOF" → "JSON validation failed".
          // Passing `[]` forces the model to use the text channel, where
          // `extractHookResponseContent` + `parsePromptHookResponse` can
          // recover. Defense in depth: the same extractor also handles the
          // tool_use case in case another model still emits it.
          tools: [],
          signal: combinedSignal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model: resolvedModel,
            toolChoice: undefined,
            isNonInteractiveSession: true,
            hasAppendSystemPrompt: false,
            agents: [],
            querySource: 'hook_prompt',
            mcpTools: [],
            agentId: toolUseContext.agentId,
            outputFormat: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  reason: { type: 'string' },
                  impossible: { type: 'boolean' },
                },
                // Per upstream claude-code 2.1.177: both `ok` and `reason`
                // are required. `impossible` is optional (escape hatch for
                // genuinely unachievable conditions; see Task 5).
                required: ['ok', 'reason'],
                additionalProperties: false,
              },
            },
          },
        })

        // DIAG: dump raw content block shape BEFORE extracting text — if the
        // model returned a tool_use block or wrapped JSON in code fences, this
        // is the only place we see it.
        try {
          const rawBlocks = response?.message?.content
          if (Array.isArray(rawBlocks)) {
            const blockTypes = rawBlocks.map((b: any) => ({
              type: b?.type,
              hasText: typeof b?.text === 'string',
              textPreview:
                typeof b?.text === 'string'
                  ? b.text.slice(0, 200)
                  : undefined,
              hasInput: b?.input != null,
            }))
            logForDebugging(
              `Hooks[execPromptHook DIAG]: attempt ${attempt} raw content blocks = ${JSON.stringify(blockTypes)}`,
            )
          } else {
            logForDebugging(
              `Hooks[execPromptHook DIAG]: attempt ${attempt} raw content is not array, typeof=${typeof rawBlocks}`,
            )
          }
        } catch (diagErr) {
          logForDebugging(
            `Hooks[execPromptHook DIAG]: error dumping blocks: ${errorMessage(diagErr)}`,
          )
        }

        // Extract response payload from content blocks. Prefer text blocks
        // (the contract path), but fall back to `tool_use.input` so models
        // that smuggle `{ok:true}` into a tool_use block (MiniMax-M2.7-highspeed
        // observed on 2026-06-13) still parse. See extractHookResponseContent.
        const content = extractHookResponseContent(response.message.content)

        // Update response length for spinner display
        toolUseContext.setResponseLength(length => length + content.length)

        fullResponse = stripMinimaxToolCallWrapper(content.trim())
        logForDebugging(
          `Hooks[execPromptHook DIAG]: attempt ${attempt} model response: ${fullResponse}`,
        )

        // Strategy 1: direct JSON.parse
        let parsedJson: unknown = null
        let parseErrMsg = ''
        try {
          parsedJson = JSON.parse(fullResponse)
        } catch (parseErr) {
          parseErrMsg = errorMessage(parseErr)
        }

        // Strategy 2: 3-level parsePromptHookResponse (markdown fence strip,
        // balanced-brace extraction). Recovers `` ```json\n{...}\n``` `` and
        // prose-prefixed JSON for MiniMax-M2.7-highspeed and similar models
        // without structured-outputs beta headers.
        if (parsedJson === null) {
          const recovered = parsePromptHookResponse(fullResponse)
          if (recovered !== null) {
            logForDebugging(
              `Hooks[execPromptHook DIAG]: attempt ${attempt} direct JSON.parse failed (${parseErrMsg}) but parsePromptHookResponse succeeded; recovered=${JSON.stringify(recovered).slice(0, 200)}`,
            )
            parsedJson = recovered
          }
        }

        if (parsedJson !== null) {
          // Schema validation INSIDE the loop so that a response that
          // parses but doesn't conform (e.g. missing required `reason`)
          // triggers a retry, matching upstream claude-code 2.1.177
          // behavior. The post-loop zod check is kept as a final safety
          // net for the case where the retry budget is exhausted.
          const schemaCheck = hookResponseSchema().safeParse(parsedJson)
          if (schemaCheck.success) {
            json = parsedJson
            lastRawResponse = fullResponse
            lastParseErr = parseErrMsg
            succeededOnAttempt = attempt
            break
          } else {
            logForDebugging(
              `Hooks[execPromptHook DIAG]: attempt ${attempt} JSON parsed but schema check failed: ${schemaCheck.error.message}; rawResponse=${JSON.stringify(fullResponse).slice(0, 500)}`,
            )
            lastRawResponse = fullResponse
            lastParseErr = schemaCheck.error.message
            // Continue the for-loop to retry
          }
        }

        // All strategies failed for this attempt. Remember the response for
        // the retry's diagnostic log, then either retry or fall through to
        // the failure handler below.
        lastRawResponse = fullResponse
        lastParseErr = parseErrMsg
        logForDebugging(
          `Hooks[execPromptHook DIAG]: attempt ${attempt} all JSON.parse strategies failed; parseErr=${parseErrMsg}; rawResponse=${JSON.stringify(fullResponse).slice(0, 500)}`,
        )
      }

      cleanupSignal()

      if (!json) {
        // Last-resort safety net (2026-06-13 /goal Stop-hook bug): when ALL
        // attempts and ALL parse strategies have failed, the model emitted
        // something we can't read. Default to {ok:true} instead of returning
        // a non_blocking_error — see fallbackHookResult for the rationale.
        // This unblocks the user instead of stranding the goal active.
        const fallback = fallbackHookResult(lastRawResponse)
        if (fallback !== null) {
          logForDebugging(
            `Hooks[execPromptHook DIAG]: all ${MAX_ATTEMPTS} attempts unparseable; applying fallbackHookResult={ok:false} (strict default) (lastRawResponse=${JSON.stringify(lastRawResponse).slice(0, 200)})`,
          )
          json = fallback
        }
      }

      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON after ${MAX_ATTEMPTS} attempts: ${lastRawResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: lastRawResponse,
            exitCode: 1,
          }) as unknown as HookResultMessage,
        }
      }

      if (succeededOnAttempt > 1) {
        logForDebugging(
          `Hooks[execPromptHook DIAG]: succeeded on attempt ${succeededOnAttempt} (retry path recovered)`,
        )
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }) as unknown as HookResultMessage,
        }
      }

      // Per upstream claude-code 2.1.177: {ok:false, impossible:true} is
      // success-with-flag (escape hatch for genuinely unachievable conditions).
      // This is INDEPENDENT of the parse-failure strict-default fallback —
      // impossible:true is a parseable, reasoned signal; we trust it.
      //   - {ok:false, impossible:true}: model LEGITIMATELY says "I can't satisfy
      //     this in this session." Allow stop + clear goal.
      //   - parse failure → fallbackHookResult returns {ok:false} (STRICT per
      //     memory: strict-default-over-permissive-for-unparseable-hook-llm).
      //     Unparseable ≠ impossible; we err on more work when uncertain.
      if (!parsed.data.ok && parsed.data.impossible === true) {
        logForDebugging(
          `Hooks: Prompt hook condition judged impossible: ${parsed.data.reason}`,
        )
        // /goal: clear the active goal so the footer pill transitions to
        // "Goal achieved (Xs · N turn · Nk tokens)". No-op when no goal
        // is active (non-/goal hooks).
        try {
          clearActiveGoalIfActive({
            toolUseContext,
          })
        } catch (e) {
          logForDebugging(
            `Hooks: clearActiveGoalIfActive on impossible failed: ${errorMessage(e)}`,
            { level: 'error' },
          )
        }
        return {
          hook,
          outcome: 'success',
          stopReason: parsed.data.reason,
          message: createAttachmentMessage({
            type: 'hook_success',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            content: '',
          }) as unknown as HookResultMessage,
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        // /goal Stop hook rejected — bump the iteration count so the
        // footer pill shows how many times the small model refused to
        // stop. No-op when no goal is active (non-/goal hooks).
        try {
          bumpGoalIteration({
            toolUseContext: {
              ...toolUseContext,
              // Persist the bumped iteration to the messages JSONL so
              // --resume restores the same iteration count. Without
              // this the bumped-iteration attachments never land and
              // sessionRestore would rehydrate a stale iter count.
              messages: toolUseContext.messages,
            },
          })
        } catch (e) {
          logForDebugging(
            `Hooks: bumpGoalIteration side-effect failed: ${errorMessage(e)}`,
            { level: 'error' },
          )
        }
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Prompt hook condition was not met: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Prompt hook condition was met`)
      // /goal Stop hook accepted — clear activeGoal so the footer pill
      // transitions to "✔ Goal achieved" then disappears. No-op when
      // no goal is active (non-/goal hooks).
      try {
        clearActiveGoalIfActive({
          toolUseContext,
        })
      } catch (e) {
        logForDebugging(
          `Hooks: clearActiveGoalIfActive side-effect failed: ${errorMessage(e)}`,
          { level: 'error' },
        )
      }
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }) as unknown as HookResultMessage,
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }) as unknown as HookResultMessage,
    }
  }
}
