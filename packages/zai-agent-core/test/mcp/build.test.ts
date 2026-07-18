import { describe, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

describe('MCP SDK import', () => {
  test('Client class is constructible', () => {
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    expect(client).toBeInstanceOf(Client)
  })
})
