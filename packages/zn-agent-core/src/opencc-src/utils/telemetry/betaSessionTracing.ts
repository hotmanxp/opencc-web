// Stub: beta session tracing disabled in open build
export function clearBetaTracingState(): void {}
export function isBetaTracingEnabled(): boolean {
  return false
}
export function truncateContent(content: string): { content: string; truncated: boolean } {
  return { content, truncated: false }
}
export interface LLMRequestNewContext {
  // stub
}
export function addBetaInteractionAttributes(): void {}
export function addBetaLLMRequestAttributes(): void {}
export function addBetaLLMResponseAttributes(): void {}
export function addBetaToolInputAttributes(): void {}
export function addBetaToolResultAttributes(): void {}
