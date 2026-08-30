// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): bundle export test for createReplSession.
 *
 * Imports directly from bundle-entry.ts (main entry) so we exercise the
 * real re-export path. The bundle-entry barrel pulls many heavy vendor
 * modules (claude.ts, Tool.ts, BashTool.tsx, attachments.ts, etc.) that
 * transitively hit a pre-existing BashTool.tsx circular dep where
 * getMaxTimeoutMs is undefined at prompt.ts evaluation time under vitest
 * ESM. We mock the upstream call sites so the import resolves without
 * actually evaluating the heavy vendor chain.
 *
 * The createReplSession function itself is exercised via a call, but
 * only its surface (submit returns, dispose is callable). Real
 * integration is covered by createReplSession.smoke.test.ts and
 * createReplSession.query.test.ts.
 */

// --- Mock the heavy vendor modules pulled by bundle-entry's other exports ---
//
// Note on mock paths: vi.mock matches the IMPORT SOURCE string, not the
// resolved path. opencc vendor uses both relative (`./X.js`) and absolute
// (`src/X/Y.js`) imports for the same files, so we mock both forms.

// bash / toolchain — used via both relative and absolute paths
vi.mock('../../../opencc-src/tools/BashTool/BashTool.tsx', () => ({
  default: {},
  BashTool: {},
}))
vi.mock('../../../../opencc-src/tools/BashTool/BashTool.tsx', () => ({
  default: {},
  BashTool: {},
}))
vi.mock('../../../opencc-src/Tool.ts', () => ({
  buildTool: () => ({}),
  __esModule: true,
}))
vi.mock('../../../opencc-src/services/api/claude.ts', () => ({
  queryModelWithStreaming: () => {},
  __esModule: true,
}))

// attachments chain (its ./permissions/autoModeState.js import fails under vitest)
vi.mock('../../../opencc-src/utils/attachments.ts', () => ({
  attachImageBlocksIfNeeded: async () => {},
  extractAttachmentPaths: () => [],
  __esModule: true,
}))

// cost-tracker chain
vi.mock('../../../opencc-src/utils/modelCost.ts', () => ({
  MODEL_COSTS: {},
  __esModule: true,
}))
vi.mock('../../../opencc-src/services/analytics/index.ts', () => ({
  logEvent: () => {},
  AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: {},
  __esModule: true,
}))

// cron + scheduled task chain
vi.mock('../../../opencc-src/utils/cronScheduler.ts', () => ({
  createCronScheduler: () => ({ start: () => {}, stop: () => {} }),
  __esModule: true,
}))
vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.ts', () => ({
  isKairosCronEnabled: () => false,
  __esModule: true,
}))

// proactive + growthbook
vi.mock('../../../opencc-src/proactive/index.ts', () => ({
  subscribeToProactiveChanges: () => () => {},
  __esModule: true,
}))
vi.mock('../../../opencc-src/services/analytics/growthbook.ts', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  __esModule: true,
}))

// messageQueueManager
vi.mock('../../../opencc-src/utils/messageQueueManager.ts', () => {
  let mockQueue: any[] = []
  return {
    getCommandQueue: () => [...mockQueue],
    enqueue: (cmd: any) => {
      mockQueue.push({ ...cmd, priority: cmd.priority ?? 'next' })
    },
    dequeue: () => mockQueue.shift(),
    enqueuePendingNotification: () => {},
    resetCommandQueue: () => {
      mockQueue = []
    },
  }
})

// bootstrap/state.ts: real ALS via AsyncLocalStorage
vi.mock('../../../opencc-src/bootstrap/state.ts', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T => sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

// vendor query() — no-op
vi.mock('../../../opencc-src/query.ts', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

// sdkEventAdapter
vi.mock('../../../compat/runtime/sdkEventAdapter.ts', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// messages util
vi.mock('../../../opencc-src/utils/messages.ts', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// tasks.ts pulls a stripped-dir `./tasks/MonitorMcpTask/MonitorMcpTask.js`
// path that fails under vitest. Stub tasks.ts entirely.
vi.mock('../../../opencc-src/tasks.ts', () => ({
  registerTask: () => {},
  Task: class {},
  __esModule: true,
}))

// collapseReadSearch pulls stripped `./teamMemoryOps.js`. Stub.
vi.mock('../../../opencc-src/utils/collapseReadSearch.ts', () => ({
  collapseReadSearchGroups: () => [],
  __esModule: true,
}))

// ExitPlanModeV2Tool pulls stripped `./permissions/autoModeState.js`.
vi.mock('../../../opencc-src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts', () => ({
  ExitPlanModeV2Tool: {},
  __esModule: true,
}))

// api.ts — pulled by services/api/claude.ts as the actual API impl.
// It pulls absolute `src/tools/...` paths, has its own circular deps.
vi.mock('../../../opencc-src/utils/api.ts', () => ({
  getTools: () => [],
  __esModule: true,
}))

// constants/prompts + context.js
vi.mock('../../../opencc-src/constants/prompts.ts', () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '',
  __esModule: true,
}))
vi.mock('../../../opencc-src/context.ts', () => ({
  getSystemContext: () => ({}),
  getUserContext: () => ({}),
  __esModule: true,
}))

// services/analytics/config
vi.mock('../../../opencc-src/services/analytics/config.ts', () => ({
  isAnalyticsDisabled: () => true,
  __esModule: true,
}))

// services/mcp/client
vi.mock('../../../opencc-src/services/mcp/client.ts', () => ({
  prefetchAllMcpResources: async () => {},
  __esModule: true,
}))

// tools/FileEditTool/FileEditTool + tools/FileWriteTool/FileWriteTool
vi.mock('../../../opencc-src/tools/FileEditTool/FileEditTool.ts', () => ({
  FileEditTool: {},
  __esModule: true,
}))
vi.mock('../../../opencc-src/tools/FileWriteTool/FileWriteTool.ts', () => ({
  FileWriteTool: {},
  __esModule: true,
}))

// types/ids
vi.mock('../../../opencc-src/types/ids.ts', () => ({
  __esModule: true,
}))

// constants/system
vi.mock('../../../opencc-src/constants/system.ts', () => ({
  CLI_SYSPROMPT_PREFIXES: {},
  __esModule: true,
}))

// services/tokenEstimation
vi.mock('../../../opencc-src/services/tokenEstimation.ts', () => ({
  roughTokenCountEstimation: () => 0,
  __esModule: true,
}))

// tools.ts pulls stripped `./tools/ScheduleCronTool/CronCreateTool.js`.
vi.mock('../../../opencc-src/tools.ts', () => ({
  getToolsList: () => [],
  __esModule: true,
}))

// permissionSetup pulls stripped `./autoModeState.js`.
vi.mock('../../../opencc-src/utils/permissions/permissionSetup.ts', () => ({
  setupPermissions: () => {},
  __esModule: true,
}))

// permissions.ts pulls stripped `./classifierDecision.js`.
vi.mock('../../../opencc-src/utils/permissions/permissions.ts', () => ({
  isAutoModeAllowed: () => false,
  __esModule: true,
}))

// Import after mocks are wired.
import { createReplSession } from '../../../bundle-entry.js'

describe('createReplSession bundle export', () => {
  it('is exported from bundle-entry', () => {
    expect(typeof createReplSession).toBe('function')
  })

  it('can be called with minimal options', () => {
    const session = createReplSession({
      sessionId: 'bundle-test-1',
      cwd: process.cwd(),
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    expect(session.getState().sessionId).toBe('bundle-test-1')
    session.dispose()
  })
})
