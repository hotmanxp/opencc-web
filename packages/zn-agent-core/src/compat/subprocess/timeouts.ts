/**
 * Timer bounds shared by every subprocess helper in this directory.
 *
 * Why a local constant and not a shared util — deepseek-harness owns an
 * equivalent `MAX_TIMER_DELAY_MS` in `@deepseek-ai/dsh-timeout`; zai-core has
 * no timer util to import from, and pulling in one solely for this constant
 * would expand the surface for no real gain. Localizing keeps the seam
 * self-contained: if a future PR replaces this with a shared timer util, the
 * change is mechanical.
 */

/**
 * Hard upper bound for any timeout-ish ms value in this directory. Mirrors
 * `setTimeout` / `setInterval` clamping (`2^31 - 1`) so dispose grace windows
 * passed to {@link spawnSubprocess} or stored on a subagent spec can be
 * validated against it in one place.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Default grace for `killTree()` — between SIGTERM and the SIGKILL escalation.
 * Matches deepseek-harness's `DEFAULT_DISPOSE_GRACE_MS` (also 3000ms). Code
 * reviewers should treat this as a deployment-level knob; providers surface it
 * via their own config schema.
 */
export const DISPOSE_GRACE_MS_DEFAULT = 3000
