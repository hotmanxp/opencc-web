import { expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.ts'
import type { BashCommandAnalysis } from './bashCommandAnalysis.ts'
import { checkPathConstraints } from './pathValidation.ts'

test('fails closed from shared parser failure during path validation', () => {
  const analysis = {
    command: 'cat ${value + 1}',
    injectionCheckDisabled: true,
    shadowEnabled: false,
    astRoot: null,
    astResult: { kind: 'parse-unavailable' },
    astSubcommands: null,
    legacyParse: {
      kind: 'failed',
      error: 'Bad substitution: value',
      failureKind: 'expected-limitation',
      reasonCode: 'bad-substitution',
    },
  } satisfies BashCommandAnalysis

  const result = checkPathConstraints(
    { command: analysis.command } as never,
    process.cwd(),
    getEmptyToolPermissionContext(),
    false,
    undefined,
    undefined,
    analysis,
  )

  expect(result).toMatchObject({
    behavior: 'ask',
    decisionReason: {
      type: 'other',
      reason: 'Command paths could not be parsed safely',
    },
  })
})
