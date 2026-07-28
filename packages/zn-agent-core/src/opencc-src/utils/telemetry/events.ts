// Stub: telemetry events disabled in open build
export function redactIfDisabled(content: string): string {
  return content
}
export async function logOTelEvent(
  _eventName: string,
  _metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  // noop
}
