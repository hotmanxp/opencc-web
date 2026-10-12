/**
 * Force optional-feature gates off for the whole vitest run.
 *
 * ## Why
 *
 * `services/mcp/client.ts` evaluates `isComputerUseEnabled()` at **module load**
 * and, when it is on, `require`s `utils/computerUse/toolRendering.js` — a file
 * that exists only as `.tsx`. Bun resolves that (opencc's runtime, and what the
 * esbuild bundle reproduces); Node's CJS resolver, which is what a `require`
 * issued from inside a vite-transformed module reaches, does not. The importing
 * test file then dies with `Cannot find module` before its first assertion.
 *
 * `isComputerUseEnabled()` is `(env || settings.enabled) && platform-allowed`,
 * and the env half — `OPENCC_ENABLE_COMPUTER_USE` — is **inherited from the
 * developer's shell**. So whether a test file loads at all depends on how the
 * developer's machine is configured: the same commit passes where the flag is
 * unset and fails where it is set. That is the defect worth fixing.
 *
 * ## Scope
 *
 * Only the env gate is cleared. Deliberately **not** redirecting
 * `OPENCC_CONFIG_DIR`: several suites assert on transcript paths under the real
 * data root, and relocating it makes them fail. Clearing one feature gate is
 * enough to keep the optional-feature code paths dormant, which is what a unit
 * test of the mods runtime wants anyway.
 *
 * A test that genuinely needs Computer Use should set the variable itself, so
 * the opt-in stays visible at the call site.
 */

delete process.env.OPENCC_ENABLE_COMPUTER_USE