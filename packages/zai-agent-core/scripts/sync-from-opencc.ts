#!/usr/bin/env tsx
/**
 * Sync selected modules from OpenCC src/ into zai-agent-core's opencc-internals/ mirror.
 *
 * Usage:
 *   pnpm sync-from-opencc --dry-run
 *   pnpm sync-from-opencc --apply
 *
 * Strategy:
 *  - Use `find` to enumerate candidate files, then filter by an explicit
 *    WHITELIST+BLACKLIST pattern set declared in code. This is more transparent
 *    than rsync's include/exclude chain and avoids accidental over-inclusion
 *    of large subtrees (e.g. utils/permissions, utils/bash which are TUI-only).
 *  - Copy each surviving file via `cp` (not rsync), preserving OpenCC's
 *    original source unchanged in place.
 *  - Post-process synced files in place: comment out removed React/ink imports
 *    and prepend ZAI_STUB markers to deferred modules.
 */

import { execSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// OPENCC_SRC 优先读环境变量, 缺省回落到同步者本机的绝对路径. 这样测试 / CI / 别的开发者
// 都能用 OPENCC_SRC=... 覆盖, 不再硬绑定到某台机器.
const OPENCC_SRC = process.env.OPENCC_SRC ?? '/Users/liangxuechao572/code/opencc/src'
const ZAI_PKG = join(__dirname, '..')
const ZAI_INTERNALS = join(ZAI_PKG, 'src', 'opencc-internals')

// ---------------------------------------------------------------------------
// WHITELIST: relative paths from OPENCC_SRC that should be copied.
// These are the core runtime pieces (engine, tools, transcript, mcp, api, etc.).
// ---------------------------------------------------------------------------
const WHITELIST_PATTERNS: string[] = [
  // Top-level files we want.
  'query.ts',
  'QueryEngine.ts',
  'Task.ts',
  'Tool.ts',
  'tools.ts',
  'history.ts',
  'cost-tracker.ts',
  'costHook.ts',
  'projectOnboardingState.ts',
  'projectOnboardingSteps.ts',

  // types/ subdir (recursive; tests skipped).
  'types/command.ts',
  'types/hooks.ts',
  'types/ids.ts',
  'types/message.ts',
  'types/messageQueueTypes.ts',
  'types/notebook.ts',
  'types/permissions.ts',
  'types/plugin.ts',
  'types/textInputTypes.ts',
  'types/tools.ts',
  'types/utils.ts',
  'types/utils.types.test.ts', // we keep this; tests aren't synced but it's tiny
  'types/connectorText.ts',
  'types/logs.ts',

  // constants/ subdir (all production code, no test files).
  'constants/apiLimits.ts',
  'constants/betas.ts',
  'constants/codegraphSection.ts',
  'constants/common.ts',
  'constants/cyberRiskInstruction.ts',
  'constants/errorIds.ts',
  'constants/figures.ts',
  'constants/files.ts',
  'constants/github-app.ts',
  'constants/keys.ts',
  'constants/messages.ts',
  'constants/oauth.ts',
  'constants/outputStyles.ts',
  'constants/product.ts',
  'constants/promptIdentity.ts',
  'constants/prompts.ts',
  'constants/querySource.ts',
  'constants/spinnerVerbs.ts',
  'constants/system.ts',
  'constants/systemPromptSections.ts',
  'constants/toolLimits.ts',
  'constants/tools.ts',
  'constants/turnCompletionVerbs.ts',
  'constants/xml.ts',

  // services/api/ — only the production .ts files we depend on.
  'services/api/adminRequests.ts',
  'services/api/agentRouteSettings.ts',
  'services/api/agentRouting.ts',
  'services/api/authRouting.ts',
  'services/api/cacheMetrics.ts',
  'services/api/cacheStatsTracker.ts',
  'services/api/claude.ts',
  'services/api/client.ts',
  'services/api/codexOAuth.ts',
  'services/api/codexOAuthShared.ts',
  'services/api/codexShim.ts',
  'services/api/compressToolHistory.ts',
  'services/api/credentialPool.ts',
  'services/api/dumpPrompts.ts',
  'services/api/emptyUsage.ts',
  'services/api/errorUtils.ts',
  'services/api/errors.ts',
  'services/api/fetchWithProxyRetry.ts',
  'services/api/filesApi.ts',
  'services/api/firstTokenDate.ts',
  'services/api/grove.ts',
  'services/api/logging.ts',
  'services/api/metricsOptOut.ts',
  'services/api/minimaxUsage.ts',
  'services/api/openaiErrorClassification.ts',
  'services/api/openaiSchemaSanitizer.ts',
  'services/api/openaiShim.ts',
  'services/api/openaiShim/anthropicRequest.ts',
  'services/api/openaiShim/cacheBreakInjector.ts',
  'services/api/openaiShim/client.ts',
  'services/api/openaiShim/completion.ts',
  'services/api/openaiShim/contextWindow.ts',
  'services/api/openaiShim/effort.ts',
  'services/api/openaiShim/errors.ts',
  'services/api/openaiShim/messages.ts',
  'services/api/openaiShim/messagesStream.ts',
  'services/api/openaiShim/responsesStream.ts',
  'services/api/openaiShim/sse.ts',
  'services/api/openaiShim/streaming.ts',
  'services/api/openaiShim/tools.ts',
  'services/api/openaiShim/types.ts',
  'services/api/openaiShim/toolCalls.ts',
  'services/api/openaiShim/request.ts',
  'services/api/openaiShim/usage.ts',
  'services/api/overageCreditGrant.ts',
  'services/api/promptCacheBreakDetection.ts',
  'services/api/providerConfig.ts',
  'services/api/reasoningLeakSanitizer.ts',
  'services/api/referral.ts',
  'services/api/sessionIngress.ts',
  'services/api/smartModelRouting.ts',
  'services/api/thinkTagSanitizer.ts',
  'services/api/toolArgumentNormalization.ts',
  'services/api/ultrareviewQuota.ts',
  'services/api/usage.ts',
  'services/api/withRetry.ts',

  // services/mcp/ — only essentials.
  'services/mcp/client.ts',
  'services/mcp/transport.ts',
  'services/mcp/server.ts',

  // services/compact/ — selected files.
  'services/compact/apiMicrocompact.ts',
  'services/compact/autoCompact.ts',
  'services/compact/cachedMCConfig.ts',
  'services/compact/cachedMicrocompact.ts',
  'services/compact/compact.ts',
  'services/compact/compactWarningHook.ts',
  'services/compact/compactWarningState.ts',
  'services/compact/forceReasonResolver.ts',
  'services/compact/grouping.ts',
  'services/compact/microCompact.ts',
  'services/compact/reactiveCompact.ts', // stub
  'services/compact/sessionCompact.ts',

  // services/analytics/ — keep minimal surface; index.ts is stub.
  'services/analytics/index.ts', // stub
  'services/analytics/config.ts',
  'services/analytics/sink.ts',

  // migrations/ — keep useful ones (settings migrations).
  'migrations/migrateAutoUpdatesToSettings.ts',
  'migrations/migrateBypassPermissionsAcceptedToSettings.ts',
  'migrations/migrateEnableAllProjectMcpServersToSettings.ts',

  // skills/ — keep framework, not built-in skills themselves.
  'skills/bundledSkills.ts',
  'skills/loadSkillsDir.ts',
  'skills/mcpSkillBuilders.ts',
  'skills/mcpSkills.ts',

  // utils/ — minimal: only core utilities used by the files above.
  // We'll discover these transitively via the post-processing scan below if
  // they're imported by synced files. For now, whitelist a curated set.
  'utils/queryHelpers.ts',
  'utils/queryLifecycle.ts',
  'utils/queryProfiler.ts',
  'utils/sideQuery.ts',
  'utils/sideQuestion.ts',
  'utils/api.ts',
  'utils/env.ts',
  'utils/envDynamic.ts',
  'utils/envUtils.ts',
  'utils/envValidation.ts',
  'utils/cleanup.ts',
  'utils/cleanupRegistry.ts',
  'utils/lockfile.ts',
  'utils/log.ts',
  'utils/debug.ts',
  'utils/managedEnv.ts',
  'utils/managedEnvConstants.ts',
  'utils/auth.ts',
  'utils/crypto.ts',
  'utils/stream.ts',
  'utils/queueProcessor.ts',
  'utils/messages.ts',
  'utils/diff.ts',
  'utils/path.ts',
  'utils/glob.ts',
  'utils/file.ts',
  'utils/ripgrep.ts',
  'utils/config.ts',
  'utils/set.ts',
  'utils/array.ts',
  'utils/format.ts',
  'utils/json.ts',
  'utils/yaml.ts',
  'utils/uuid.ts',
  'utils/hash.ts',
  'utils/memoize.ts',
  'utils/cwd.ts',
  'utils/platform.ts',
  'utils/process.ts',
  'utils/forkedAgent.ts',
  'utils/standaloneAgent.ts',
  'utils/idleTimeout.ts',
  'utils/proxy.ts',
  'utils/hookChains.ts',
  'utils/hooks.ts',
  // AGENTS.md loading (1400+ lines, mostly standalone)
  'utils/claudemd.ts',
  'utils/projectInstructions.ts',
  'utils/memoryFileDetection.ts',
  'utils/attachments.ts',
  'utils/model.ts',
  'utils/modelCost.ts',
  'utils/sleep.ts',
  'utils/binaryCheck.ts',
  'utils/which.ts',
  'utils/objectGroupBy.ts',
  'utils/withResolvers.ts',
  'utils/signal.ts',
  'utils/streamlinedTransform.ts',

  // BashTool port — P-tier pure-logic modules (no Bun, no TUI, no analytics).
  'utils/semanticBoolean.ts',
  'utils/semanticNumber.ts',
  'utils/lazySchema.ts',
  'utils/stringUtils.ts',
  'utils/errors.ts',
  'utils/timeouts.ts',
  'utils/bash/ast.ts',
  'utils/bash/commands.ts',
  'tools/BashTool/commandSemantics.ts',
  'tools/BashTool/destructiveCommandWarning.ts',
  'tools/BashTool/sedValidation.ts',
  'tools/BashTool/sedEditParser.ts',
  'tools/BashTool/commentLabel.ts',

  // AgentTool port — fork prerequisites (runForkedAgent transitive deps).
  // NOTE: upstream opencc exports ContentReplacementState from
  // utils/toolResultStorage.ts (not a separate types/toolResultStorage.ts),
  // and utils/toolResultStorage.ts was already synced in commit 8f56820;
  // we only need to pull the remaining 3 new files here.
  'utils/sessionStorage.ts',
  'utils/abortController.ts',
  'utils/fileStateCache.ts',
]

// Files we explicitly never want (defense in depth — these would not be in WHITELIST anyway).
const HARD_EXCLUDE_FILES = new Set<string>([
  'main.tsx',
  'commands.ts',
  'commands',
  'context.ts',
  'global.d.ts',
  'interactiveHelpers.tsx',
  'dialogLaunchers.tsx',
  'replLauncher.tsx',
  'setup.ts',
  'ink.ts',
  'constants.ts',
  'tasks.ts',
  'state', // directory
])

// Files that get a ZAI_STUB marker prepended (deferred modules).
// Note: services/compact/reactiveCompact.ts was renamed/removed upstream; if
// it ever resurfaces it should be re-added here.
const STUB_FILES = new Set<string>([
  'services/compact/forceReasonResolver.ts',
  'services/analytics/index.ts',
])

// Patterns in imported file content that we comment out (TUI/React/ink).
const REMOVED_IMPORT_PATTERNS: RegExp[] = [
  /^import\s+React(\s*,\s*\{[^}]*\})?\s+from\s+['"]react['"];?$/gm,
  /^import\s+\{[^}]*\}\s+from\s+['"]react['"];?$/gm,
  /^import\s+[^;]*\s+from\s+['"]react['"];?$/gm,
  /^import\s+[^;]*\s+from\s+['"]ink['"];?$/gm,
]

function listOpenccFiles(): string[] {
  // Use `find` to enumerate everything under src. Filter in-process for clarity.
  const out = execSync(`find ${OPENCC_SRC} -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.d.ts' \\)`, {
    encoding: 'utf-8',
  })
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('__tests__'))
    .filter((p) => !/\.test\.[a-z]+$/.test(p))
}

function isHardExcluded(rel: string): boolean {
  if (HARD_EXCLUDE_FILES.has(rel)) return true
  // Drop anything under TUI/RPC/desktop subtrees entirely.
  const hardDirs = [
    'components/',
    'screens/',
    'hooks/',
    'voice/',
    'vim/',
    'proactive/',
    'ssh/',
    'upstreamproxy/',
    'native-ts/',
    'buddy/',
    'moreright/',
    'assistant/',
    'coordinator/',
    'bridge/',
    'grpc/',
    'remote/',
    'server/',
    'entrypoints/',
    'memdir/',
    'tasks/',
    'plugins/',
    'query/',
    'cli/',
    'bootstrap/',
    'outputStyles/',
    'keybindings/',
    'proto/',
    'integrations/',
    'state/',
    'commands/',
    'ink/',
  ]
  return hardDirs.some((d) => rel.startsWith(d))
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`[sync-from-opencc] mode=${dryRun ? 'dry-run' : 'apply'}`)
  console.log(`[sync-from-opencc] opencc src: ${OPENCC_SRC}`)
  console.log(`[sync-from-opencc] target:     ${ZAI_INTERNALS}`)

  const whitelistSet = new Set(WHITELIST_PATTERNS)
  const all = listOpenccFiles()
  const toCopy: string[] = []
  const skipped: string[] = []

  for (const abs of all) {
    const rel = relative(OPENCC_SRC, abs)
    if (isHardExcluded(rel)) {
      skipped.push(`${rel}  (hard-excluded dir)`)
      continue
    }
    if (!whitelistSet.has(rel)) {
      skipped.push(`${rel}  (not in whitelist)`)
      continue
    }
    toCopy.push(abs)
  }

  console.log(
    `[sync-from-opencc] candidates: ${toCopy.length} whitelisted / ${skipped.length} skipped`
  )

  if (dryRun) {
    for (const abs of toCopy) {
      console.log(`  COPY: ${relative(OPENCC_SRC, abs)}`)
    }
    console.log(`[sync-from-opencc] dry-run complete — ${toCopy.length} files would be synced`)
    return
  }

  if (!existsSync(ZAI_INTERNALS)) {
    mkdirSync(ZAI_INTERNALS, { recursive: true })
  }

  let copied = 0
  let stubbed = 0
  let cleaned = 0
  for (const src of toCopy) {
    const rel = relative(OPENCC_SRC, src)
    const dest = join(ZAI_INTERNALS, rel)
    mkdirSync(dirname(dest), { recursive: true })

    let content = readFileSync(src, 'utf-8')

    // Comment out removed TUI/React/ink imports.
    const original = content
    for (const re of REMOVED_IMPORT_PATTERNS) {
      content = content.replace(re, (m) => `// ZAI_REMOVED: ${m.trimEnd()}`)
    }
    if (content !== original) cleaned++

    // Add ZAI_STUB marker for deferred modules.
    if (STUB_FILES.has(rel) && !content.startsWith('// ZAI_STUB')) {
      content = `// ZAI_STUB: zai 暂未实现，待 web 端稳定后再补\n${content}`
      stubbed++
    }

    writeFileSync(dest, content, 'utf-8')
    copied++
  }

  console.log(`[sync-from-opencc] applied: ${copied} files`)
  console.log(`[sync-from-opencc] stubbed: ${stubbed} files`)
  console.log(`[sync-from-opencc] cleaned imports: ${cleaned} files`)
  console.log('[sync-from-opencc] done.')
}

main()
