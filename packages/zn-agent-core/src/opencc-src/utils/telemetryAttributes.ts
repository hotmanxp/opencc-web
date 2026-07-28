// Stub: telemetry attributes disabled in open build
// Using 'any' type alias since @opentelemetry/api is no longer available
type Attributes = Record<string, unknown>
export function getTelemetryAttributes(): Attributes {
  return {}
}
