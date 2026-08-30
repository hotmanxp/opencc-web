// packages/zn-agent-core/src/compat/repl/notifications/types.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): notification kinds + event type.
 * Mirrors the 30+ React notification hooks in REPL.tsx, flattened to
 * a single typed event bus. Each ReplEvent 'notification' payload
 * carries kind + payload.
 */

export type NotificationKind =
  | 'rateLimit'
  | 'deprecation'
  | 'pluginAutoUpdate'
  | 'mcpStatus'
  | 'lspInit'
  | 'chromeExt'
  | 'feedbackSurvey'
  | 'memorySurvey'
  | 'postCompactSurvey'
  | 'skillImprovementSurvey'
  | 'installMessage'
  | 'modelMigration'
  | 'subscriptionSwitch'
  | 'ideStatus'
  | 'autoModeUnavailable'
  | 'pluginInstallation'
  | 'settingsError'
  | 'fastMode'
  | 'issueFlag'
  | 'custom'

export type NotificationEvent = {
  kind: NotificationKind
  payload?: unknown
  timestamp: number
}
