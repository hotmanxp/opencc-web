// Stub: AWS support disabled in open build
/** AWS short-term credentials format. */
export type AwsCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  Expiration?: string
}
/** Output from `aws sts get-session-token` or `aws sts assume-role`. */
export type AwsStsOutput = {
  Credentials: AwsCredentials
}
type AwsError = {
  name: string
}
export function isAwsCredentialsProviderError(err: unknown) {
  return (err as AwsError | undefined)?.name === 'CredentialsProviderError'
}
export function isValidAwsStsOutput(obj: unknown): obj is AwsStsOutput {
  if (!obj || typeof obj !== 'object') return false
  const output = obj as Record<string, unknown>
  if (!output.Credentials || typeof output.Credentials !== 'object') return false
  const credentials = output.Credentials as Record<string, unknown>
  return (
    typeof credentials.AccessKeyId === 'string' &&
    typeof credentials.SecretAccessKey === 'string' &&
    typeof credentials.SessionToken === 'string' &&
    credentials.AccessKeyId.length > 0 &&
    credentials.SecretAccessKey.length > 0 &&
    credentials.SessionToken.length > 0
  )
}
export async function checkStsCallerIdentity(): Promise<void> {
  throw new Error('AWS STS is not supported in the open build')
}
export async function clearAwsIniCache(): Promise<void> {
  // noop
}
