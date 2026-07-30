// Mirror of packages/zn-agent-core/scripts/strip-list.ts — single source
// of truth for vitest.config.ts + bun-protocol.mjs + future loaders.
// Adding a stripped dir here automatically wires its `src/<dir>/...`
// and `../<dir>/...` imports to dangling-shims/opencc-stripped.ts
// BEFORE the generic `src/...` / relative catch-all aliases map them
// to <OPENCC_SRC_DIR> (which doesn't exist for stripped dirs).

export const STRIPPED_DIRS = [
  // top-level dirs
  'components', 'ink', 'screens', 'buddy', 'assistant', 'vim', 'voice',
  'cli', 'commands', 'state', 'migrations', '__tests__', 'test',
  'ssh', 'grpc', 'proto', 'remote', 'upstreamproxy', 'integrations',
  'memdir', 'outputStyles', 'proactive', 'keybindings', 'moreright',
  'coordinator', 'native-ts', 'context', 'bridge',
  // tasks/* sub-paths
  'tasks/RemoteAgentTask', 'tasks/InProcessTeammateTask',
  'tasks/LocalShellTask', 'tasks/LocalAgentTask',
  // utils/* sub-paths
  'utils/processUserInput', 'utils/swarm', 'utils/computerUse',
  'utils/backgroundHousekeeping', 'utils/installationInfo',
  'utils/doctorDiagnostic', 'utils/updateStrategy', 'utils/autoUpgrade',
  'utils/autoUpdaterRouting', 'utils/handleAutoUpdate', 'utils/cleanup',
  // services/* sub-paths
  'services/voice', 'services/PromptSuggestion', 'services/MagicDocs',
  'services/wiki', 'services/extractMemories', 'services/goal',
  'services/autoDream', 'services/autoFix', 'services/SessionMemory',
  'services/teamMemorySync', 'services/AgentSummary',
  'services/remoteManagedSettings', 'services/settingsSync',
  'services/github',
  // services/analytics — barrel file `index.ts`/`index.js` is missing
  // from the vendored snapshot, but transitive imports still reach for
  // it. Stub via dangling-shims/analytics-stub.ts.
  'services/analytics',
  // utils/task/framework — strip-list removes just the .ts file, but
  // opencc's transitive imports still reach for the path. Route to
  // opencc-stripped (the dir's remaining files are dead code for the
  // bridge path).
  'utils/task/framework',
  // tools/*/UI — opencc's React UI components (BashTool/UI.tsx,
  // FileReadTool/UI.tsx, etc.) are stripped, but the tool's
  // `index.tsx` still references them. Route to opencc-stripped.
  'tools/BashTool/UI',
  'tools/BashTool/prompt',
  'tools/FileReadTool/UI',
  'tools/FileReadTool/prompt',
  'tools/EditTool/UI',
  'tools/EditTool/prompt',
  'tools/GrepTool/UI',
  'tools/WriteTool/UI',
  'tools/AgentTool/UI',
  'tools/WebFetchTool/UI',
  'tools/TaskCreateTool/UI',
  'tools/TodoWriteTool/UI',
  'tools/KillShellTool/UI',
  'tools/NotebookEditTool/UI',
  'tools/WebSearchTool/UI',
]

// Opencc's vendored source uses project-relative `src/...` specifiers
// (e.g. opencc-src/utils/permissions/filesystem.ts:7:
//   `from 'src/memdir/paths.js'`). These must route to
// dangling-shims/opencc-stripped.ts BEFORE the generic `src/...`
// catch-all maps them to <OPENCC_SRC_DIR> (where stripped dirs don't
// exist). Allow deeper paths like `src/ink/termio/csi.js` AND direct
// file imports like `src/commands.js`.
export const ABSOLUTE_RE = new RegExp(
  `^src/(?:${STRIPPED_DIRS.join('|')})/(?:.+/)?[^/]+\\.js$` +
    `|^src/(?:${STRIPPED_DIRS.join('|')})/[^/]+$` +
    `|^src/(?:${STRIPPED_DIRS.join('|')})\\.js$` +
    `|^src/(?:${STRIPPED_DIRS.join('|')})$`,
)

// Opencc also uses relative paths (`../../state/store.js`,
// `../ink/termio/csi.js`, AND `./swarm/backends/detection.js` from
// inside the same dir's stripped sibling — `./swarm` resolves to
// `utils/swarm` because worktree.ts lives in `utils/`). Same routing
// — to dangling-shims/opencc-stripped.ts. We match both the full
// stripped path AND just its leaf segment so single-dot relatives
// work too. Allow deeper paths with optional subdirectories.
const STRIPPED_LEAVES = Array.from(
  new Set(STRIPPED_DIRS.map((d) => d.split('/').pop())),
).filter(Boolean)

export const RELATIVE_RE = new RegExp(
  `(?:\\.{1,2}/)+(?:${STRIPPED_DIRS.join('|')})/(?:.+/)?[^/]+\\.js$` +
    `|(?:\\.{1,2}/)+(?:${STRIPPED_DIRS.join('|')})/[^/]+$` +
    `|(?:\\.{1,2}/)+(?:${STRIPPED_DIRS.join('|')})\\.js$` +
    `|(?:\\.{1,2}/)+(?:${STRIPPED_LEAVES.join('|')})/(?:.+/)?[^/]+\\.js$` +
    `|(?:\\.{1,2}/)+(?:${STRIPPED_LEAVES.join('|')})/[^/]+$` +
    `|(?:\\.{1,2}/)+(?:${STRIPPED_LEAVES.join('|')})\\.js$`,
)