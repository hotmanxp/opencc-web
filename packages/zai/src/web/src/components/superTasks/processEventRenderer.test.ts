import { describe, expect, it } from 'vitest'
import { toRendered } from './processEventRenderer'

describe('toRendered placeholder', () => {
  it('返回一个 null (scaffold only)', () => {
    expect(
      toRendered({
        id: '1',
        event: 'system',
        data: { seq: 1, ts: 100, type: 'system', data: {} },
      }),
    ).toBeNull()
  })
})
