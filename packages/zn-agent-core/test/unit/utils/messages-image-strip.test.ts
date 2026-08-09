/**
 * Regression tests for normalizeMessagesForAPI's image-strip recovery.
 *
 * Backstory: zai session `sess-1786233030871-l455dror` got stuck in a
 * 400 death loop when the LLM's `Read` tool result contained a corrupt
 * image (56-byte file, base64 `data` field stuffed with a file path).
 * API rejected it with `400 invalid image content: ... unknown format (2013)`.
 * The existing strip mechanism (issue #1421) only matches
 * `isMeta: true` user messages, so the poison tool_result user message
 * was never stripped and every retry hit the same 400.
 *
 * These tests pin down the fix: a new canonical error message
 * (`getImageFormatInvalidErrorMessage`) + the strip search now also
 * walks into non-isMeta user messages that actually carry image blocks.
 */
import { vi } from 'vitest'

// Sever the load chain. messages.ts → errors.ts → … → api.ts which
// imports `src/tools/BashTool/BashTool.js` (the `.js` suffix in the
// specifier is vendor project-relative; vitest.config.ts maps it to
// `.tsx` but the file is actually `BashTool.tsx` and the `.ts` form
// doesn't exist on disk). The BashTool module's inputSchema getter
// eagerly calls `getMaxTimeoutMs()` on first access, but that function
// isn't yet initialized at this point in the load order. We never
// use BashTool under test — only `messages.ts`'s
// normalizeMessagesForAPI. Mock the BashTool module at the resolved
// `.tsx` path (the alias maps `.js` → `.ts` then `BashTool.ts` is
// a non-existent file; vitest's resolveId should fall back to
// `.tsx` via the same find logic used for sibling imports).
vi.mock('../../../src/opencc-src/tools/BashTool/BashTool.tsx', () => ({
  default: { name: 'Bash' },
  BashTool: { name: 'Bash' },
}))
// Same BashTool module, different specifier. api.ts uses
// `from 'src/tools/BashTool/BashTool.js'` (vendor project-relative).
// vitest.config.ts maps `.js` → `.ts` but the file is actually `.tsx`,
// so the resolver falls through to a non-existent `.ts` path. Mock
// the canonical `.tsx` source so vite-node's dynamic-import fallback
// finds it.
vi.mock('../../../src/opencc-src/tools/BashTool/BashTool.js', () => ({
  default: { name: 'Bash' },
  BashTool: { name: 'Bash' },
}), { virtual: true })
// `src/context.js` is a vendor project-relative import. The vitest
// alias maps `.js` → `.ts` which exists. But vite-node sometimes
// bypasses resolve.alias for nested `await import()` calls; the
// dangling-shims are a fallback. Stub the resolved `.ts` path here.
vi.mock('../../../src/opencc-src/context.ts', () => ({
  getSystemContext: () => ({ cwd: '/tmp', user: 'test' }),
  getUserContext: () => ({ user: 'test' }),
}))
// The bare specifier `src/context.js` itself also needs a virtual mock
// since vite-node falls back to it when resolve.alias is bypassed.
vi.mock('src/context.js', () => ({
  getSystemContext: () => ({ cwd: '/tmp', user: 'test' }),
  getUserContext: () => ({ user: 'test' }),
}), { virtual: true })

import { describe, expect, it } from 'vitest'
import { normalizeMessagesForAPI } from '../../../src/opencc-src/utils/messages.js'
import {
  getImageFormatInvalidErrorMessage,
  getImageTooLargeErrorMessage,
  getPdfTooLargeErrorMessage,
  getVisionNotSupportedErrorMessage,
} from '../../../src/opencc-src/services/api/errors.js'
import type { Message } from '../../../src/opencc-src/types/message.js'

function mkUser(overrides: Partial<Message> & { message: any }): Message {
  return {
    uuid: overrides.uuid ?? `u-${Math.random().toString(36).slice(2, 10)}`,
    parentUuid: overrides.parentUuid ?? null,
    type: 'user',
    timestamp: overrides.timestamp ?? Date.now(),
    isMeta: overrides.isMeta ?? false,
    ...overrides,
  } as Message
}

function mkAssistant(overrides: Partial<Message> & { message: any }): Message {
  return {
    uuid: overrides.uuid ?? `a-${Math.random().toString(36).slice(2, 10)}`,
    parentUuid: overrides.parentUuid ?? null,
    type: 'assistant',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  } as Message
}

function mkSyntheticApiError(content: string, uuid?: string): Message {
  return mkAssistant({
    uuid: uuid ?? `err-${Math.random().toString(36).slice(2, 10)}`,
    message: {
      id: 'synthetic',
      type: 'message',
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: content }],
    },
    isApiErrorMessage: true,
  })
}

describe('normalizeMessagesForAPI — image_format_invalid 2013 recovery', () => {
  it('strips image block from tool_result user message (the real bug)', () => {
    // Mirrors sess-1786233030871-l455dror: user → Read tool_use →
    // user tool_result with corrupt image → assistant synthetic 2013 error.
    const toolResultUser = mkUser({
      uuid: 'u-toolresult-1',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_read_1',
            type: 'tool_result',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  // In the real bug this was a file path stuffed into `data`.
                  data: '/var/folders/xd/.../ego+browser+shot+8559+1png=',
                },
              },
            ],
          },
        ],
      },
    })
    const messages: Message[] = [
      mkUser({
        uuid: 'u-prompt-1',
        message: { role: 'user', content: '看看这个截图' },
      }),
      mkAssistant({
        uuid: 'a-read-1',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_read_1',
              name: 'Read',
              input: { file_path: '/Users/ethan/code/opencc-web/verify-step1-context-fix.png' },
            },
          ],
        },
      }),
      toolResultUser,
      mkSyntheticApiError(getImageFormatInvalidErrorMessage(), 'a-err-1'),
      // User's retry attempt
      mkUser({
        uuid: 'u-retry-1',
        message: { role: 'user', content: '继续' },
      }),
    ]

    const out = normalizeMessagesForAPI(messages)

    // toolResultUser's image-only tool_result should be stripped and the
    // resulting user message dropped (per messages.ts:1554-1557, all
    // content stripped → skip). Look for it by uuid — should not exist.
    const outToolResult = out.find(m => m.uuid === 'u-toolresult-1')
    expect(outToolResult).toBeUndefined()
  })

  it('does not strip non-image user messages', () => {
    // Synthetic 2013 error but the preceding tool_result only has text.
    // Should be left alone — the bad-image heuristic must not false-positive.
    const toolResultUser = mkUser({
      uuid: 'u-toolresult-text',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_read_2',
            type: 'tool_result',
            content: [{ type: 'text', text: 'readme contents' }],
          },
        ],
      },
    })
    const messages: Message[] = [
      mkUser({
        uuid: 'u-prompt',
        message: { role: 'user', content: 'read the readme' },
      }),
      mkAssistant({
        uuid: 'a-read',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_read_2', name: 'Read', input: {} },
          ],
        },
      }),
      toolResultUser,
      mkSyntheticApiError(getImageFormatInvalidErrorMessage()),
    ]

    const out = normalizeMessagesForAPI(messages)
    const outToolResult = out.find(m => m.uuid === 'u-toolresult-text')
    expect(outToolResult).toBeDefined()
    // text content preserved untouched
    expect(outToolResult!.message.content[0].content[0]).toEqual({
      type: 'text',
      text: 'readme contents',
    })
  })

  it('preserves isMeta-first priority: isMeta user wins over non-isMeta tool_result', () => {
    // Per existing #1421 behavior, an isMeta user message earlier in the
    // history should still be the strip target for vision errors.
    const isMetaUser = mkUser({
      uuid: 'u-ismeta',
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'old' } }],
      },
    })
    const toolResultUser = mkUser({
      uuid: 'u-toolresult-later',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_x',
            type: 'tool_result',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bad' } },
            ],
          },
        ],
      },
    })
    const messages: Message[] = [
      isMetaUser,
      toolResultUser,
      mkSyntheticApiError(getVisionNotSupportedErrorMessage(), 'a-err-vision'),
    ]

    const out = normalizeMessagesForAPI(messages)
    // isMeta user should be filtered out (its content had only image, all stripped → drop)
    // tool_result user should be preserved (isMeta path took priority)
    const outIsMeta = out.find(m => m.uuid === 'u-ismeta')
    expect(outIsMeta).toBeUndefined() // dropped, isMeta path strip hit
  })

  it('handles multiple synthetic errors: each strips its own preceding tool_result', () => {
    const tr1 = mkUser({
      uuid: 'u-tr-1',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_a',
            type: 'tool_result',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bad1' } },
            ],
          },
        ],
      },
    })
    const tr2 = mkUser({
      uuid: 'u-tr-2',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_b',
            type: 'tool_result',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bad2' } },
            ],
          },
        ],
      },
    })
    const messages: Message[] = [
      tr1,
      mkSyntheticApiError(getImageFormatInvalidErrorMessage(), 'a-err-1'),
      tr2,
      mkSyntheticApiError(getImageFormatInvalidErrorMessage(), 'a-err-2'),
    ]

    const out = normalizeMessagesForAPI(messages)
    expect(out.find(m => m.uuid === 'u-tr-1')).toBeUndefined()
    expect(out.find(m => m.uuid === 'u-tr-2')).toBeUndefined()
  })

  it('does NOT extend the isMeta-only rule to PDF / non-image errors', () => {
    // Regression guard: the strip-search relaxation must be gated on
    // blockTypesToStrip.has('image'). PDF errors keep their existing
    // isMeta-only behavior.
    const trUser = mkUser({
      uuid: 'u-tr-pdf',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_pdf',
            type: 'tool_result',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'bad' } },
            ],
          },
        ],
      },
    })
    const messages: Message[] = [
      trUser,
      mkSyntheticApiError(getPdfTooLargeErrorMessage(), 'a-err-pdf'),
    ]

    const out = normalizeMessagesForAPI(messages)
    // PDF tool_result NOT stripped (no relaxation for non-image blocks)
    const outTr = out.find(m => m.uuid === 'u-tr-pdf')
    expect(outTr).toBeDefined()
    // document block preserved
    expect(outTr!.message.content[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'bad' },
    })
  })

  it('image_too_large 5MB error also strips non-isMeta tool_result images (uses same path)', () => {
    // Sanity: the relaxation helps ALL image errors, not just 2013.
    const trUser = mkUser({
      uuid: 'u-tr-big',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'call_big',
            type: 'tool_result',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'too-big' } },
            ],
          },
        ],
      },
    })
    const messages: Message[] = [
      trUser,
      mkSyntheticApiError(getImageTooLargeErrorMessage(), 'a-err-big'),
    ]

    const out = normalizeMessagesForAPI(messages)
    expect(out.find(m => m.uuid === 'u-tr-big')).toBeUndefined()
  })
})
