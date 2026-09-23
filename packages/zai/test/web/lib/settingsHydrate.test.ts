// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { clampSettingNumber } from '../../../src/web/src/lib/settingsHydrate.js'

describe('clampSettingNumber', () => {
  it('合法数字 floor 后原样返回', () => {
    expect(clampSettingNumber(20, 1, 1000)).toBe(20)
    expect(clampSettingNumber(20.9, 1, 1000)).toBe(20)
  })

  it('clamp 到 [min, max]', () => {
    expect(clampSettingNumber(0, 1, 1000)).toBe(1)
    expect(clampSettingNumber(-5, 1, 1000)).toBe(1)
    expect(clampSettingNumber(1e9, 1, 1000)).toBe(1000)
  })

  // 关键：手编 settings.json / 后端字段缺失时不能把 undefined 变成 NaN 灌进 store，
  // 那会让 number 行显示 "NaN"。返回 null = "本次不 hydrate，保留现有值"。
  it('非 number / 非有限值返回 null（调用方跳过 hydrate）', () => {
    expect(clampSettingNumber(undefined, 1, 1000)).toBeNull()
    expect(clampSettingNumber(null, 1, 1000)).toBeNull()
    expect(clampSettingNumber('20', 1, 1000)).toBeNull()
    expect(clampSettingNumber(NaN, 1, 1000)).toBeNull()
    expect(clampSettingNumber(Infinity, 1, 1000)).toBeNull()
  })
})
