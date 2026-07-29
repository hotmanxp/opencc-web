import { describe, expect, test, mock } from 'bun:test'
import { DEFAULT_QUERY_HARD_MAX_MS } from './QueryGuard.ts'
import {
  getQueryGuardOptionsFromEnv,
  MAX_CONFIGURABLE_QUERY_HARD_MAX_MS,
} from './queryGuardConfig.ts'

describe('query guard config', () => {
  test('uses defaults when query hard max env is absent or empty', () => {
    const warn = mock<(...args: unknown[]) => unknown>(() => {})

    expect(getQueryGuardOptionsFromEnv({}, warn)).toEqual({})
    expect(
      getQueryGuardOptionsFromEnv(
        { OPENCC_QUERY_HARD_MAX_MS: '   ' },
        warn,
      ),
    ).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  test('accepts positive finite integer query hard max values', () => {
    const warn = mock<(...args: unknown[]) => unknown>(() => {})

    expect(
      getQueryGuardOptionsFromEnv(
        { OPENCC_QUERY_HARD_MAX_MS: '3600000' },
        warn,
      ),
    ).toEqual({ hardMaxQueryMs: 3_600_000 })
    expect(
      getQueryGuardOptionsFromEnv(
        { OPENCC_QUERY_HARD_MAX_MS: String(DEFAULT_QUERY_HARD_MAX_MS) },
        warn,
      ),
    ).toEqual({ hardMaxQueryMs: DEFAULT_QUERY_HARD_MAX_MS })
    expect(
      getQueryGuardOptionsFromEnv(
        {
          OPENCC_QUERY_HARD_MAX_MS: String(
            MAX_CONFIGURABLE_QUERY_HARD_MAX_MS,
          ),
        },
        warn,
      ),
    ).toEqual({ hardMaxQueryMs: MAX_CONFIGURABLE_QUERY_HARD_MAX_MS })
    expect(warn).not.toHaveBeenCalled()
  })

  test('ignores invalid query hard max values with a clear warning', () => {
    const invalidValues = [
      '0',
      '-1',
      'NaN',
      '1.5',
      'Infinity',
      '123abc',
      String(MAX_CONFIGURABLE_QUERY_HARD_MAX_MS + 1),
    ]

    for (const value of invalidValues) {
      const warn = mock<(...args: unknown[]) => unknown>(() => {})

      expect(
        getQueryGuardOptionsFromEnv(
          { OPENCC_QUERY_HARD_MAX_MS: value },
          warn,
        ),
      ).toEqual({})

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain(
        'OPENCC_QUERY_HARD_MAX_MS',
      )
      expect(warn.mock.calls[0]?.[0]).toContain(value)
      expect(warn.mock.calls[0]?.[1]).toEqual({ level: 'warn' })
    }
  })
})
