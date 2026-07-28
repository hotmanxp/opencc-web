/**
 * Regression tests for finish_reason='length' (max_tokens truncation).
 *
 * OpenCC upstream behavior (mirrored here):
 * - Tools with a single-string field like Write/Bash/Read/Edit/Glob/Grep
 *   ("string-arg tools") are flagged with normalizeAtStop.
 * - For these tools, the raw JSON buffer is NOT eagerly reparsed on
 *   finish. Instead it is surfaced to the consumer as-is so the downstream
 *   zod schema rejects it as `tool_use:invalid` (a much louder failure
 *   than silently writing a half-truncated file to disk).
 *
 * Background — the bug we are guarding against:
 * - The original zai translation layer called `repairPossiblyTruncatedObjectJson`
 *   for ALL tool calls on `finish_reason='length'`.
 * - For Write, when truncation fell inside the `content` string, the suffix
 *   `"}` happened to close the literal cleanly. The repaired JSON looked
 *   valid: `{file_path:"/tmp/out.txt", content:"被切到一半"}`.
 * - FileWriteTool.call then received a syntactically valid `content` and
 *   wrote the half-string to disk. The LLM later could not recover the
 *   missing tail. No error surfaced.
 *
 * What these tests assert:
 * - The raw truncated buffer must NEVER be presented as a valid Write/Bash
 *   argument via the `repairPossiblyTruncatedObjectJson` path.
 * - For string-arg tools, on truncation the consumer must receive either
 *   the raw buffer (so zod rejects) or a normalized wrap that fails zod.
 * - For non-string-arg tools (e.g. TodoWrite with arrays/objects), the
 *   repair path is still allowed and produces a valid object.
 */
import { describe, it, expect } from 'vitest'
import { OpenAIClient } from '../../src/server/services/openaiClient.js'

function streamCapture() {
  let captured: { url: string; init: RequestInit } | null = null
  const original = globalThis.fetch
  function setSseBody(body: string) {
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch
  }
  return {
    setSseBody,
    get: () => captured,
    restore: () => { globalThis.fetch = original },
  }
}

function sseChunk(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

interface RecordedEvent {
  type: string
  index?: number
  kind?: string
  partial_json?: string
  id?: string
  name?: string
  input?: unknown
}

async function collect(body: string): Promise<RecordedEvent[]> {
  const cap = streamCapture()
  cap.setSseBody(body)
  try {
    const client = new OpenAIClient({
      baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
    })
    const events: RecordedEvent[] = []
    for await (const ev of client.messages.create({
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    })) {
      events.push({
        type: ev.type,
        index: (ev as { index?: number }).index,
        kind: (ev as { content_block?: { type?: string } }).content_block?.type,
        partial_json: (ev as { delta?: { partial_json?: string } }).delta?.partial_json,
        id: (ev as { content_block?: { id?: string } }).content_block?.id,
        name: (ev as { content_block?: { name?: string } }).content_block?.name,
        input: (ev as { content_block?: { input?: unknown } }).content_block?.input,
      })
    }
    return events
  } finally {
    cap.restore()
  }
}

function reassembleInput(events: RecordedEvent[], index: number): string {
  return events
    .filter(e => e.type === 'content_block_delta'
      && e.index === index
      && typeof e.partial_json === 'string')
    .map(e => e.partial_json!)
    .join('')
}

describe('OpenAIClient — finish_reason=length truncation (Write/Bash long content)', () => {
  it('Write with content string truncated mid-literal does NOT silently write a half file', async () => {
    // Truncation falls inside the `content` string literal. The naive
    // JSON_REPAIR_SUFFIXES path appends `"}` and produces a syntactically
    // valid object whose `content` is the half-string. That is the bug:
    // FileWriteTool will write the half-string to disk.
    //
    // The fix (OpenCC semantics): for string-arg tools, do NOT repair; emit
    // a value that downstream zod will reject.
    const truncatedArgs = '{"file_path":"/tmp/out.txt","content":"这里是超长文本被切到一半'
    const events = await collect(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Write', arguments: truncatedArgs },
            }],
          },
          finish_reason: 'length',
        }],
      }) +
      'data: [DONE]\n\n',
    )

    const toolStart = events.find(e => e.type === 'content_block_start' && e.kind === 'tool_use')
    expect(toolStart).toBeDefined()
    const inputJson = reassembleInput(events, toolStart!.index!)

    let parsedOk = false
    let parsed: unknown
    try { parsed = JSON.parse(inputJson); parsedOk = true } catch { /* expected */ }

    if (parsedOk) {
      const obj = parsed as Record<string, unknown>
      // If it happens to parse, it must NOT have a usable `content` field
      // (the truncation point is inside the string, so a valid parse would
      // mean we silently "completed" the missing tail).
      expect('content' in obj).toBe(false)
    }
  })

  it('Write with arguments streamed across multiple chunks under normal completion parses cleanly', async () => {
    // Sanity check: when finish_reason is tool_calls (normal completion) the
    // consumer must still reassemble deltas into a valid Write input.
    const events = await collect(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Write', arguments: '{"file_path":"/tmp/' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'out.txt","content":"hello world"}' },
            }],
          },
        }],
      }) +
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }) +
      'data: [DONE]\n\n',
    )

    const toolStart = events.find(e => e.type === 'content_block_start' && e.kind === 'tool_use')
    expect(toolStart).toBeDefined()
    const inputJson = reassembleInput(events, toolStart!.index!)
    const parsed = JSON.parse(inputJson) as { file_path: string; content: string }
    expect(parsed.file_path).toBe('/tmp/out.txt')
    expect(parsed.content).toBe('hello world')
  })

  it('Bash with command truncated mid-string is NOT silently repaired into a valid command', async () => {
    // Same shape of bug for Bash: truncation inside `command` literal should
    // not produce a valid Bash input.
    const truncatedArgs = '{"command":"echo 这里是超长命令被切到一半'
    const events = await collect(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_2',
              type: 'function',
              function: { name: 'Bash', arguments: truncatedArgs },
            }],
          },
          finish_reason: 'length',
        }],
      }) +
      'data: [DONE]\n\n',
    )

    const toolStart = events.find(e => e.type === 'content_block_start' && e.kind === 'tool_use')
    expect(toolStart).toBeDefined()
    const inputJson = reassembleInput(events, toolStart!.index!)

    let parsedOk = false
    let parsed: unknown
    try { parsed = JSON.parse(inputJson); parsedOk = true } catch { /* expected */ }

    if (parsedOk) {
      const obj = parsed as Record<string, unknown>
      expect('command' in obj).toBe(false)
    }
  })

  it('TodoWrite with truncated JSON array still gets a best-effort repair (NOT a string-arg tool)', async () => {
    // TodoWrite is NOT in the string-arg mapping. For tools with structured
    // inputs (objects/arrays), the original repair path is still useful —
    // it lets the user keep partial data rather than losing the whole turn.
    const events = await collect(
      sseChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_4',
              type: 'function',
              function: {
                name: 'TodoWrite',
                // Truncation between two complete array entries — repair
                // closes with `]}` to produce a valid object.
                arguments: '{"todos":[{"content":"a"},{"content":"b"',
              },
            }],
          },
          finish_reason: 'length',
        }],
      }) +
      'data: [DONE]\n\n',
    )

    const toolStart = events.find(e => e.type === 'content_block_start' && e.kind === 'tool_use')
    expect(toolStart).toBeDefined()
    const inputJson = reassembleInput(events, toolStart!.index!)
    let parsed: unknown
    expect(() => { parsed = JSON.parse(inputJson) }).not.toThrow()
    const obj = parsed as { todos?: unknown[] }
    expect(Array.isArray(obj.todos)).toBe(true)
  })
})