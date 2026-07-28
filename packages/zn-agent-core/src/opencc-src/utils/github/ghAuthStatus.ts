export type GhAuthStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'not_installed'

/**
 * Returns gh CLI install + auth status for telemetry.
 * Uses which() first (Bun.which — no subprocess) to detect install, then
 * exit code of `gh auth token` to detect auth. Uses `auth token` instead of
 * `auth status` because the latter makes a network request to GitHub's API,
 * while `auth token` only reads local config/keyring. Spawns with
 * stdout: 'ignore' so the token never enters this process.
 */
export async function getGhAuthStatus(): Promise<GhAuthStatus> {
  // DISABLED 2026-06-06: this fork does not use GitHub CLI integration.
  // The probe spawned `which gh` and `gh auth token` even on machines
  // where gh is deliberately not installed, producing recurring
  // `spawn gh ENOENT` errors in debug logs. The probe exists only for
  // startup telemetry (tengu_startup_telemetry event in main.tsx:312)
  // and the `gh_status` check in remote-setup/remote-setup.tsx:29, both
  // of which work correctly with a hardcoded 'not_installed' response.
  // To re-enable: remove this block and restore the original body.
  return 'not_installed'
}
