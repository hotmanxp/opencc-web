// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendBoundedMcpStderr,
  cleanupFailedConnection,
} from './client.ts'

test('cleanupFailedConnection awaits transport close before resolving', async () => {
  let closed = false
  let resolveClose: (() => void) | undefined

  const transport = {
    close: async () =>
      await new Promise<void>(resolve => {
        resolveClose = () => {
          closed = true
          resolve()
        }
      }),
  }

  const cleanupPromise = cleanupFailedConnection(transport)

  assert.equal(closed, false)
  resolveClose?.()
  await cleanupPromise
  assert.equal(closed, true)
})

test('cleanupFailedConnection closes in-process server and transport', async () => {
  let inProcessClosed = false
  let transportClosed = false

  const inProcessServer = {
    close: async () => {
      inProcessClosed = true
    },
  }

  const transport = {
    close: async () => {
      transportClosed = true
    },
  }

  await cleanupFailedConnection(transport, inProcessServer)

  assert.equal(inProcessClosed, true)
  assert.equal(transportClosed, true)
})

test('appendBoundedMcpStderr caps retained stderr and marks truncation', () => {
  const output = appendBoundedMcpStderr('', Buffer.alloc(300 * 1024, 'x'))

  assert.equal(output.length, 256 * 1024)
  assert.match(output, /\.\.\.\[stderr truncated\]$/)
})

test('appendBoundedMcpStderr ignores chunks after truncation', () => {
  const output = appendBoundedMcpStderr('', Buffer.alloc(300 * 1024, 'x'))
  const after = appendBoundedMcpStderr(output, 'more stderr')

  assert.equal(after, output)
})