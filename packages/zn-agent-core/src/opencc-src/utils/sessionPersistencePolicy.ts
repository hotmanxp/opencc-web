import { isSessionPersistenceDisabled } from '../bootstrap/state.ts'
import { isEnvTruthy } from './envUtils.ts'
import { getSettings_DEPRECATED } from './settings/settings.ts'

export function shouldSkipSessionPersistence(): boolean {
  const allowTestPersistence = isEnvTruthy(
    process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  )
  if (allowTestPersistence) {
    return false
  }
  return (
    (process.env.NODE_ENV || 'development') === 'test' ||
    getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
  )
}