/**
 * Re-export shim for `@zn-ai/zn-agent-core`'s ripgrep wrapper. The
 * actual implementation lives in
 * `packages/zn-agent-core/src/compat/vendor/ripgrep.ts` so vendor path
 * resolution is encapsulated in core — zai just consumes the API.
 *
 * Kept here as a re-export so existing imports
 * (`from '../services/ripgrep.js'`) don't break.
 */
export {
  resolveRgVendor,
  resolveRgSystem,
  resolveRgPath,
  runRipgrep,
  type SpawnResult,
  type RunRipgrepOptions,
} from '@zn-ai/zn-agent-core'
