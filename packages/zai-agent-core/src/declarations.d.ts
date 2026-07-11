// Declaration file to map .js imports to .d.ts stubs
// This allows excluded opencc-internals files to resolve type stubs

declare module 'src/entrypoints/agentSdkTypes.js' {
  export type HookEvent = string;
  export const HOOK_EVENTS: HookEvent[];
  export type PermissionUpdate = unknown;
  export type HookJSONOutput = Record<string, unknown>;
}

declare module 'src/types/message.js' {
  export type Message = {
    role: string;
    content: unknown;
    [key: string]: unknown;
  };
}

declare module 'src/utils/permissions/PermissionResult.js' {
  export type PermissionResult = {
    behavior: 'allow' | 'deny' | 'ask' | 'passthrough';
    reason?: string;
  };
}

declare module 'src/utils/permissions/PermissionRule.js' {
  import { z } from 'zod/v4';
  export const permissionBehaviorSchema: () => z.ZodOptional<z.ZodType<unknown>>;
}

declare module 'src/utils/permissions/PermissionUpdateSchema.js' {
  import { z } from 'zod/v4';
  export const permissionUpdateSchema: () => z.ZodOptional<z.ZodType<unknown>>;
}

declare module '../state/AppState.js' {
  export type AppState = Record<string, unknown>;
}

declare module '../utils/commitAttribution.js' {
  export type AttributionState = Record<string, unknown>;
}

declare module '../utils/lazySchema.js' {
  export function lazySchema<T>(factory: () => T): () => T;
}

declare module './abortReasons.js' {
  export type AbortReason = string;
  export const abortReasons: Record<string, AbortReason>;
  export function normalizeAbortReason(reason: unknown): AbortReason;
}

declare module '@anthropic-ai/sdk/resources/messages.mjs' {
  export type ContentBlockParam = Record<string, unknown>;
}

declare module '../bridge/sessionIdCompat.js' {
  export function toCompatSessionId(sessionId: string): string;
}

declare module '../constants.js' {
  export declare const AGENTS_INSTRUCTIONS_FILENAME = "AGENTS.md";
  export declare const AGENTS_INSTRUCTIONS_LOCAL_FILENAME = "AGENTS.local.md";
  export declare const AGENTS_FILENAME = "CLAUDE.md";
}
