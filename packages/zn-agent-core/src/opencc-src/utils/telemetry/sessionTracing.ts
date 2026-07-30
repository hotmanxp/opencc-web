// Stub: session tracing disabled in open build
export type { Span } from '@opentelemetry/api'
export { isBetaTracingEnabled, type LLMRequestNewContext } from './betaSessionTracing.js'
export const sessionTracing = {
  startSpan: () => null,
  endSpan: () => {},
}
export function startInteractionSpan(): null {
  return null
}
export function endInteractionSpan(): void {}
export function addBetaInteractionSpanAttributes(): void {}
export function startLLMRequestSpan(): null {
  return null
}
export function endLLMRequestSpan(): void {}
export function addBetaLLMSpanAttributes(): void {}
export function startToolSpan(): null {
  return null
}
export function endToolSpan(): void {}
export function addToolContentEvent(): void {}
export function startToolBlockedOnUserSpan(): void {}
export function endToolBlockedOnUserSpan(): void {}
export function startToolExecutionSpan(): void {}
export function endToolExecutionSpan(): void {}
export function addBetaToolSpanAttributes(): void {}
export function startHookSpan(): null {
  return null
}
export function endHookSpan(): void {}
