// Barrel for the subagent provider registry. Mirrors the layout used by
// `utils/subprocess/index.ts` so callers in this codebase can import the
// surface from one path.

export {
  SubagentRegistry,
  SubagentError,
  getSubagentRegistry,
  _resetSubagentRegistryForTests,
} from './registry.js'
export type {
  SubagentProvider,
  SubagentRequest,
  SubagentContext,
  SubagentRun,
  SubagentEvent,
  SubagentResult,
  SubagentStopReason,
} from './registry.js'
