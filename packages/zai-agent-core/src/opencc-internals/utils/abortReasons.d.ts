// @ts-nocheck
export type AbortReason = string;
export declare const abortReasons: Record<string, AbortReason>;
export declare function normalizeAbortReason(reason: unknown): AbortReason;