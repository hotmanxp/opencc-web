import { describe, expect, test } from 'bun:test'
import { McpServerError } from '../../src/mcp/errors.js'

describe('McpServerError', () => {
  test('carries serverName and retryable', () => {
    const err = new McpServerError('connect failed', { serverName: 'github', retryable: true })
    expect(err.serverName).toBe('github')
    expect(err.retryable).toBe(true)
    expect(err.message).toBe('connect failed')
  })
})