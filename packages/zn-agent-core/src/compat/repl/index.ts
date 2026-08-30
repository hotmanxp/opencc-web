// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession barrel.
 * Single entry point; consumers import from this file.
 */

export type {
  ContentBlock,
  PermissionMode,
  UserMessage,
  InterruptRequest,
  EnqueueRequest,
  ReplSessionInput,
  ReplEvent,
  ReplEventType,
  HookTrace,
  ReplSessionOptions,
  ReplSession,
  ReplSessionLifecycleEvent,
  ReplSessionState,
} from './types.js'

export { createReplSession } from './createReplSession.js'
