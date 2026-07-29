import { describe, expect, test } from 'bun:test'
import {
  extractHookResponseContent,
  fallbackHookResult,
  parsePromptHookResponse,
  stripMinimaxToolCallWrapper,
} from './execPromptHook.ts'

describe('parsePromptHookResponse', () => {
  test('parses bare JSON object', () => {
    expect(parsePromptHookResponse('{"ok": true}')).toEqual({ ok: true })
  })

  test('parses JSON wrapped in ```json code fence', () => {
    const fenced = '```json\n{"ok": true}\n```'
    expect(parsePromptHookResponse(fenced)).toEqual({ ok: true })
  })

  test('parses JSON wrapped in bare ``` code fence (no language tag)', () => {
    const fenced = '```\n{"ok": true, "reason": "x"}\n```'
    expect(parsePromptHookResponse(fenced)).toEqual({
      ok: true,
      reason: 'x',
    })
  })

  test('strips leading prose and parses embedded JSON object', () => {
    const prose = 'Here is the result: {"ok": false, "reason": "still failing"}'
    expect(parsePromptHookResponse(prose)).toEqual({
      ok: false,
      reason: 'still failing',
    })
  })

  test('returns null for empty string', () => {
    expect(parsePromptHookResponse('')).toBeNull()
  })

  test('returns null for whitespace-only string', () => {
    expect(parsePromptHookResponse('   \n  ')).toBeNull()
  })

  test('returns null for response with no JSON', () => {
    expect(parsePromptHookResponse('all good, typecheck passed')).toBeNull()
  })

  test('returns null for malformed JSON', () => {
    expect(parsePromptHookResponse('{"ok": tru}')).toBeNull()
  })

  test('handles response with leading/trailing whitespace', () => {
    expect(parsePromptHookResponse('  \n{"ok": true}\n  ')).toEqual({
      ok: true,
    })
  })

  test('handles JSON with extra text after the object', () => {
    const messy = '```json\n{"ok": true}\n```\nLet me know if you need more.'
    expect(parsePromptHookResponse(messy)).toEqual({ ok: true })
  })
})

describe('extractHookResponseContent', () => {
  test('returns empty string for empty block list', () => {
    expect(extractHookResponseContent([])).toBe('')
  })

  test('joins text blocks', () => {
    const blocks = [
      { type: 'text', text: '{"ok": true}' },
    ]
    expect(extractHookResponseContent(blocks)).toBe('{"ok": true}')
  })

  test('falls back to tool_use.input when no text block carries parseable JSON', () => {
    // Reproduces the observed bug: MiniMax-M2.7-highspeed returns a tool_use
    // block with `{ok:true}` in `input` and no text block at all. The previous
    // extractor (`extractTextContent`) returned "" → JSON.parse EOF → failure.
    const blocks = [
      { type: 'tool_use', input: { ok: true } },
    ]
    expect(extractHookResponseContent(blocks)).toBe('{"ok":true}')
  })

  test('falls back to tool_use.input with reason field', () => {
    const blocks = [
      { type: 'tool_use', input: { ok: false, reason: 'still failing' } },
    ]
    expect(extractHookResponseContent(blocks)).toBe(
      '{"ok":false,"reason":"still failing"}',
    )
  })

  test('prefers text block when both text and tool_use are present', () => {
    // If the model DID return text (success case), keep the original behavior:
    // use the text block, not the tool_use input.
    const blocks = [
      { type: 'text', text: '{"ok": true}' },
      { type: 'tool_use', input: { ok: false, reason: 'noise' } },
    ]
    expect(extractHookResponseContent(blocks)).toBe('{"ok": true}')
  })

  test('returns empty string for tool_use block whose input does not look like the schema', () => {
    // Don't stringify arbitrary tool_use input — if the model invoked a real
    // tool, we want the caller to fail loudly (existing behavior), not silently
    // accept non-schema JSON.
    const blocks = [
      { type: 'tool_use', input: { name: 'Bash', command: 'rm -rf /' } },
    ]
    expect(extractHookResponseContent(blocks)).toBe('')
  })
})

describe('stripMinimaxToolCallWrapper', () => {
  test('returns input unchanged when no wrapper present', () => {
    expect(stripMinimaxToolCallWrapper('{"ok": true}')).toBe('{"ok": true}')
  })

  test('strips a single [TOOL_CALL]...[/TOOL_CALL] block (Perl-heredoc style)', () => {
    // Reproduces the actual MiniMax-M2.7-highspeed failure mode observed on
    // 2026-06-13: the model emits `[TOOL_CALL]...[/TOOL_CALL]` with a Perl
    // hash inside, which trips up extractFirstBalancedObject because the
    // first `{` belongs to `{tool => "Read"...}` not the JSON we want.
    // Note: leading prose ("Let me check...") is NOT this function's job;
    // that gets handled by parsePromptHookResponse's balanced-brace path.
    const wrapped =
      'Let me check the transcript.\n[TOOL_CALL]\n{tool => "Read", args => { --path "/foo" }}\n[/TOOL_CALL]\n{"ok": true}'
    expect(stripMinimaxToolCallWrapper(wrapped)).toBe(
      'Let me check the transcript.\n\n{"ok": true}',
    )
  })

  test('strips a single <minimax:tool_call>...</minimax:tool_call> block (XML style)', () => {
    // Older MiniMax emission observed on 2026-06-13 — keep this case alive so
    // both shapes are covered. Stripping is harmless if the model switches
    // back to XML output.
    const input = '{"ok": true}'
    const wrapped =
      '<minimax:tool_call>\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>\n' +
      input
    expect(stripMinimaxToolCallWrapper(wrapped)).toBe(input)
  })

  test('returns "" when input is purely a tool_call wrapper with no JSON', () => {
    const wrapped =
      '[TOOL_CALL]\n{tool => "Bash", args => { --command "ls" }}\n[/TOOL_CALL]'
    expect(stripMinimaxToolCallWrapper(wrapped)).toBe('')
  })

  test('handles multiple wrappers (mixed styles) and keeps JSON in between', () => {
    const input = '{"ok": false, "reason": "no"}'
    const wrapped =
      '[TOOL_CALL]foo[/TOOL_CALL]\n' +
      input +
      '\n<minimax:tool_call>bar</minimax:tool_call>'
    expect(stripMinimaxToolCallWrapper(wrapped)).toBe(input)
  })
})

describe('fallbackHookResult', () => {
  test('returns ok=false fallback when called with a prose-only response', () => {
    // Last-resort safety net for /goal Stop-hook on 2026-06-13:
    // MiniMax-M2.7-highspeed sometimes emits pure prose ("Let me check the
    // transcript...") with no `{ok:true}` JSON anywhere. After stripping
    // tool-call wrappers, all parse strategies fail. Strict default to
    // {ok:false} (per user feedback 2026-06-13): "no parseable evidence =
    // not satisfied". The agent must continue working and produce clearer
    // evidence on the next turn; we err on the side of more work, not less.
    expect(fallbackHookResult('Let me check the transcript.')).toEqual({
      ok: false,
      reason: 'hook returned no parseable JSON; defaulting to ok=false (strict)',
    })
  })

  test('returns null when called with parseable JSON (caller should not invoke fallback)', () => {
    // Documenting the contract: fallbackHookResult is only used when
    // parsePromptHookResponse returned null AND we're about to give up.
    // Even empty/whitespace returns the fallback — that's the whole point
    // of the safety net for the /goal bug on 2026-06-13 (Stop #3 had a
    // model response of "" after stripping the `<minimax:tool_call>` block
    // with no surrounding text).
    expect(fallbackHookResult('{"ok": false, "reason": "x"}')).toBeNull()
  })

  test('returns ok=false fallback for empty/whitespace input (Stop #3 case)', () => {
    // This is the exact shape seen at Stop #3 on 2026-06-13: model emitted
    // only `<minimax:tool_call>...</minimax:tool_call>` wrappers with no
    // text block, so after stripping the lastRawResponse is "". The
    // fallback must still fire — strict default blocks the agent from
    // stopping until clearer evidence is produced.
    expect(fallbackHookResult('')).toEqual({
      ok: false,
      reason: 'hook returned empty response; defaulting to ok=false (strict)',
    })
    expect(fallbackHookResult('   \n  ')).toEqual({
      ok: false,
      reason: 'hook returned empty response; defaulting to ok=false (strict)',
    })
  })
})