import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { AssistantMessage } from '../types/message.ts'

// Mock claude.js before importing the module under test so queryHaiku resolves
// to whatever the individual test wants. We preserve every other export from
// claude.js so unrelated transitive imports still work.
const haikuMock = mock(
  async (_args: unknown): Promise<AssistantMessage> => {
    throw new Error('haikuMock not configured for this test')
  },
)

beforeEach(async () => {
  haikuMock.mockReset()
  haikuMock.mockImplementation(async () => {
    throw new Error('haikuMock not configured for this test')
  })
  const actual = await import('../services/api/claude.js')
  mock.module('../services/api/claude.js', () => ({
    ...actual,
    queryHaiku: haikuMock,
  }))
})

afterEach(() => {
  mock.restore()
})

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    type: 'assistant',
    content: text,
    message: {
      content: [{ type: 'text', text }],
      role: 'assistant',
    },
  }
}

async function runGenerateSessionTitle(
  description: string,
): Promise<string | null> {
  const nonce = `${Date.now()}-${Math.random()}`
  const { generateSessionTitle } =
    await import(`./sessionTitle.ts?ts=${nonce}`)
  const ctrl = new AbortController()
  return generateSessionTitle(description, ctrl.signal)
}

test('generateSessionTitle strips ```json code fence around response', async () => {
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage('```json\n{"title":"My Session"}\n```'),
  )

  const title = await runGenerateSessionTitle('add a login button')

  expect(title).toBe('My Session')
})

test('generateSessionTitle accepts plain JSON without code fence', async () => {
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage('{"title":"Plain"}'),
  )

  const title = await runGenerateSessionTitle('rename a file')

  expect(title).toBe('Plain')
})

test('generateSessionTitle handles leading whitespace around code fence', async () => {
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage('   ```json\n{"title":"With Whitespace"}\n```   '),
  )

  const title = await runGenerateSessionTitle('add a logout button')

  expect(title).toBe('With Whitespace')
})

test('generateSessionTitle handles prose wrapped around code fence', async () => {
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage(
      'Here is the title:\n```json\n{"title":"With Prose"}\n```',
    ),
  )

  const title = await runGenerateSessionTitle('refactor the auth module')

  expect(title).toBe('With Prose')
})

test('generateSessionTitle extracts JSON object from prose without fence', async () => {
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage(
      'Sure, the response is {"title":"Prose Only"} as you asked.',
    ),
  )

  const title = await runGenerateSessionTitle('explain the diff')

  expect(title).toBe('Prose Only')
})

test('generateSessionTitle extracts first { to last } even with trailing commentary', async () => {
  // Model returns the JSON object followed by prose with a stray `}`.
  // Greedy match `{...}` extracts the full object; zod schema then
  // validates the result.
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage(
      '{"title":"With Tail"} Hope this helps! Use it as needed :)',
    ),
  )

  const title = await runGenerateSessionTitle('add a save button')

  expect(title).toBe('With Tail')
})

test('generateSessionTitle regex matches array too, but schema rejects it', async () => {
  // The regex is intentionally permissive — it matches both `{}` and `[]`
  // so we don't miss a model output. The zod schema (z.object) then
  // rejects arrays, falling back to the 'OpenCC' default. This test
  // locks the regex behavior so a future refactor that drops the `[..]`
  // alternative (back to v3) will be caught.
  haikuMock.mockImplementation(async () =>
    makeAssistantMessage('```json\n["Just a string"]\n```'),
  )

  const title = await runGenerateSessionTitle('add a delete button')

  expect(title).toBeNull()
})
