import { describe, expect, test } from 'vitest'
import { createMcpTransport, injectAuth } from '../../src/mcp/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

describe('createMcpTransport', () => {
  test('stdio kind returns StdioClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'stdio', command: 'node', args: ['m.js'] } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(StdioClientTransport)
  })

  test('sse kind returns SSEClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'sse', url: 'https://example.com/sse' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(SSEClientTransport)
  })

  test('http kind returns StreamableHTTPClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'http', url: 'https://example.com/mcp' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  test('sse kind auto-detected by url ending in /sse', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'http', url: 'https://example.com/api/sse' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(SSEClientTransport)
  })
})

describe('injectAuth', () => {
  test('bearerEnvVar injects Authorization header', () => {
    process.env.TEST_BEARER = 'secret-token'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { bearerEnvVar: 'TEST_BEARER' },
    })
    expect(out.transport).toMatchObject({
      kind: 'sse',
      headers: { Authorization: 'Bearer secret-token' },
    })
    delete process.env.TEST_BEARER
  })

  test('headerEnvVars injected verbatim', () => {
    process.env.TEST_HEADER = 'header-value'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { headerEnvVars: { 'X-Api-Key': 'TEST_HEADER' } },
    })
    expect(out.transport).toMatchObject({
      kind: 'sse',
      headers: { 'X-Api-Key': 'header-value' },
    })
    delete process.env.TEST_HEADER
  })

  test('stdio auth injected into env', () => {
    process.env.TEST_STDIO_TOKEN = 'tok'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'stdio', command: 'node' },
      auth: { bearerEnvVar: 'TEST_STDIO_TOKEN' },
    })
    if (out.transport.kind !== 'stdio') throw new Error('expected stdio')
    expect(out.transport.env).toEqual({ Authorization: 'Bearer tok' })
    delete process.env.TEST_STDIO_TOKEN
  })

  test('missing env var skipped silently', () => {
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { bearerEnvVar: 'NONEXISTENT_VAR_12345' },
    })
    expect(out.transport).toMatchObject({ kind: 'sse' })
  })
})