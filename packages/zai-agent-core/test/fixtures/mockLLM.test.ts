import { describe, expect, test } from 'vitest'
import { mockFetch, fixtures } from './mockLLM.js'

describe('mockLLM', () => {
  test('mockFetch anthropic returns SSE stream', async () => {
    const fetch = mockFetch({ provider: 'anthropic', events: fixtures.simpleChat })
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('Hello world')
  })

  test('mockFetch simulate error', async () => {
    const fetch = mockFetch({ provider: 'anthropic', events: [], simulateError: 'rate_limit' })
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })
    expect(res.status).toBe(429)
  })
})
