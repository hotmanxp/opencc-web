/**
 * Credential pool stub.
 *
 * Cherry-picked downstream gateways (atlas-cloud, gitlawb-opengateway, opencode-go)
 * reference `firstUsableCredential` for vendor-specific credential rotation. OpenCC
 * does not yet implement the rotation policy these vendors expect, so we expose a
 * minimal pass-through that returns the first non-empty env value from the requested
 * variable list. This keeps the type surface stable for cherry-picks while deferring
 * real rotation logic to a later change.
 */

export function firstUsableCredential(
  envVars: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { envVar: string; value: string } | null {
  for (const envVar of envVars) {
    const value = env[envVar]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { envVar, value: value.trim() }
    }
  }
  return null
}