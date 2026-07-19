// Local stub for opencc-internals/utils/permissions/permissionSetup.ts.
// forkedAgent only calls parseToolListFromCLI() — that's the symbol reproduced
// here. The full upstream file owns permission-mode / settings-file loading
// which zai handles differently via its own RuntimeConfig; pulling that in
// would drag in the entire permission FSM.
export function parseToolListFromCLI(
  toolList: string | readonly string[],
): string[] {
  if (Array.isArray(toolList)) return [...toolList]
  if (typeof toolList !== 'string') return []
  return toolList
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

// Other exports referenced by forkedAgent / elsewhere — return inert defaults
// to satisfy type-only imports without pulling the full permission FSM.
export const SETTING_SOURCES = ['user', 'project', 'local'] as const
export type SettingSource = (typeof SETTING_SOURCES)[number]

export function applyPermissionRulesToPermissionContext(
  _rules: unknown,
  _context: unknown,
): unknown {
  return _context
}

export async function loadAllPermissionRulesFromDisk(
  _cwd?: string,
): Promise<unknown[]> {
  return []
}