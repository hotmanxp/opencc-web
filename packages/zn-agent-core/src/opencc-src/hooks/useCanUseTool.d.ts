/**
 * Stub .d.ts for `hooks/useCanUseTool.tsx` — zai uses its own
 * `runtime/canUseTool.ts`. Vendored .ts files did
 * `import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'`.
 * The .tsx (with React) was stripped; this .d.ts preserves the type.
 */

import type { PermissionResult } from '../types/permissions.ts'

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; [key: string]: unknown },
) => Promise<PermissionResult>