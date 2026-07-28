// @ts-nocheck
import { describe, expect, test } from 'bun:test'

import { resolveForceReason } from './forceReasonResolver.js'

describe('resolveForceReason', () => {
  test('below floor, message-count over threshold → undefined', () => {
    // tokenCount=1000 << floor=50000, so gate fails regardless of message count.
    const result = resolveForceReason({
      messageCount: 201,
      tokenCount: 1000,
      maxActiveMessages: 200,
      naturalThreshold: 200_000,
      floorPct: 25, // floor = 200_000 * 25 / 100 = 50_000
      memoryPressureFlag: false,
    })
    expect(result).toBeUndefined()
  })

  test('below floor, memory-pressure flag set → undefined', () => {
    const result = resolveForceReason({
      messageCount: 10,
      tokenCount: 1000,
      maxActiveMessages: 200,
      naturalThreshold: 200_000,
      floorPct: 25, // floor = 50_000
      memoryPressureFlag: true,
    })
    expect(result).toBeUndefined()
  })

  test('above floor, message-count over threshold, no pressure → message-count', () => {
    const result = resolveForceReason({
      messageCount: 201,
      tokenCount: 60_000,
      maxActiveMessages: 200,
      naturalThreshold: 200_000,
      floorPct: 25, // floor = 50_000
      memoryPressureFlag: false,
    })
    expect(result).toBe('message-count')
  })

  test('above floor, memory-pressure flag set, no message-count → memory-pressure', () => {
    const result = resolveForceReason({
      messageCount: 50, // under threshold
      tokenCount: 60_000,
      maxActiveMessages: 200,
      naturalThreshold: 200_000,
      floorPct: 25, // floor = 50_000
      memoryPressureFlag: true,
    })
    expect(result).toBe('memory-pressure')
  })

  test('above floor, both signals → memory-pressure (priority fix)', () => {
    // Pre-fix: message-count overwrote memory-pressure.
    // Post-fix: memory-pressure wins because it represents the more
    // urgent signal (RSS pressure vs. just a long conversation).
    const result = resolveForceReason({
      messageCount: 201,
      tokenCount: 60_000,
      maxActiveMessages: 200,
      naturalThreshold: 200_000,
      floorPct: 25, // floor = 50_000
      memoryPressureFlag: true,
    })
    expect(result).toBe('memory-pressure')
  })

  test('floorPct=1 escape hatch: allows force at very low token count', () => {
    // With floorPct=1 and naturalThreshold=100, floor=1. Any tokenCount >= 1
    // passes the gate, restoring pre-fix behavior for users who want it.
    const result = resolveForceReason({
      messageCount: 201,
      tokenCount: 100,
      maxActiveMessages: 200,
      naturalThreshold: 100,
      floorPct: 1, // floor = 1
      memoryPressureFlag: false,
    })
    expect(result).toBe('message-count')
  })
})
