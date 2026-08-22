import { describe, it, expect, afterEach } from 'vitest';
import {
  ZAI_GLOBAL_BRIDGE_KEYS,
  installZaiGlobalBridges,
  clearZaiGlobalBridges,
  trackZaiGlobalBridge,
  hasAnyZaiGlobalBridge,
} from './globalThisBridge.js';

describe('globalThisBridge cleanup protocol', () => {
  afterEach(() => {
    // 每个测试后清理，避免污染其它测试
    clearZaiGlobalBridges()
  })

  it('启动前 globalThis 没有 zai 桥', () => {
    expect(hasAnyZaiGlobalBridge()).toBe(false)
  })

  it('installZaiGlobalBridges 注入已知 key', () => {
    const bus = { emit: () => {} }
    const ctx = { askRegistry: null }
    trackZaiGlobalBridge('__zaiEventBus', bus)
    trackZaiGlobalBridge('__zaiBridgeCtx', ctx)

    installZaiGlobalBridges({
      __zaiEventBus: bus,
      __zaiBridgeCtx: ctx,
    })

    expect((globalThis as any).__zaiEventBus).toBe(bus)
    expect((globalThis as any).__zaiBridgeCtx).toBe(ctx)
    expect(hasAnyZaiGlobalBridge()).toBe(true)
  })

  it('clearZaiGlobalBridges 清理所有已注入的 key', () => {
    const bus = { emit: () => {} }
    trackZaiGlobalBridge('__zaiEventBus', bus)
    installZaiGlobalBridges({ __zaiEventBus: bus })

    expect(hasAnyZaiGlobalBridge()).toBe(true)
    clearZaiGlobalBridges()
    expect(hasAnyZaiGlobalBridge()).toBe(false)
    expect((globalThis as any).__zaiEventBus).toBeUndefined()
  })

  it('clearZaiGlobalBridges 不删非 zai 注入的同名变量', () => {
    // 外部脚本/test fixture 自行设了同名 key（不在 installedRefs 中）
    ;(globalThis as any).__zaiEventBus = 'external-script-value'
    // 没 track，所以不在 installedRefs，clear 不删
    clearZaiGlobalBridges()
    expect((globalThis as any).__zaiEventBus).toBe('external-script-value')

    // 清理掉测试 fixture
    delete (globalThis as any).__zaiEventBus
  })

  it('install 与 clear 多次交替无残留', () => {
    for (let i = 0; i < 5; i++) {
      const bus = { id: i }
      trackZaiGlobalBridge('__zaiEventBus', bus)
      installZaiGlobalBridges({ __zaiEventBus: bus })
      expect((globalThis as any).__zaiEventBus).toBe(bus)
      clearZaiGlobalBridges()
      expect(hasAnyZaiGlobalBridge()).toBe(false)
    }
  })

  it('ZAI_GLOBAL_BRIDGE_KEYS 列表与计划 §4.1 一致', () => {
    expect(ZAI_GLOBAL_BRIDGE_KEYS).toEqual([
      '__zaiEventBus',
      '__zaiBridgeCtx',
      '__zaiSessionInbox',
      '__zaiCurrentSessionId',
    ])
  })
})