import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel } from '../lib/resolveModel.js'
import { resolveMainAgent } from '../services/mainAgents.js'
import { resolveArchiveKeepCount, toArchiveKeepCount } from '../services/sessionArchive.js'
import type { ModelEntry, OutputStyle, Theme, WorkMode, ZaiSettings } from '../../shared/settings.js'
import type { ProviderProfile } from '../../shared/types.js'
import { getDefaultMode } from '../services/permissionMode.js'
import { BUILTIN_PROVIDERS } from '../../shared/builtinProviders.js'
import { profilesToModelEntries } from '../../shared/profileProjection.js'
import {
  isValidAutoDreamEnabled,
  isValidAutoUpdate,
  isValidDefaultSplitScreen,
  isValidEnableComputerUse,
  isValidEnableDynamicWorkflow,
  isValidMemoryAutoWrite,
  isValidMemoryRequireApproval,
  isValidOpenccCliDangerouslySkip,
  isValidOutputStyle,
  isValidTheme,
  isValidWorkMode,
  readZaiSettings,
  resolveAutoDreamEnabled,
  resolveAutoUpdate,
  resolveDefaultSplitScreen,
  resolveEnableComputerUse,
  resolveEnableDynamicWorkflow,
  resolveMemoryAutoWrite,
  resolveMemoryRequireApproval,
  resolveOpenccCliDangerouslySkip,
  resolveOutputStyle,
  resolveTheme,
  resolveWorkMode,
  updateZaiSettings,
} from '../services/zaiSettingsStore.js'

/**
 * Read ~/.zai.json → providerProfiles. Returns empty array when the
 * file is missing or the field is absent. The OpenCC schema rejects
 * unknown fields so the read here is best-effort and untyped.
 */
function readClaudeProviderProfiles(): ProviderProfile[] {
  try {
    const path = join(homedir(), '.zai.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : []
  } catch {
    return []
  }
}

/**
 * Build the picker-visible ModelEntry list with the following precedence:
 *
 *   1. User-configured `~/.zai/settings.json → models[]` (the user
 *      owns this; nothing auto-overrides their entries).
 *   2. Saved OpenCC `~/.zai.json → providerProfiles` (projected
 *      into ModelEntry rows with capability metadata).
 *   3. System default catalog (BUILTIN_PROVIDERS) so the picker is
 *      never empty on a fresh install.
 *
 * Earlier layers win on alias collision so the user's picks stay sticky.
 */
function buildAvailableModels(settings: ZaiSettings): ModelEntry[] {
  const userEntries = settings.models ?? []
  const seen = new Set(userEntries.map((e) => e.alias))

  const fromSavedProfiles = profilesToModelEntries(readClaudeProviderProfiles())
    .filter((e) => !seen.has(e.alias))
  for (const e of fromSavedProfiles) seen.add(e.alias)

  const fromBuiltins = profilesToModelEntries(BUILTIN_PROVIDERS)
    .filter((e) => !seen.has(e.alias))

  return [...userEntries, ...fromSavedProfiles, ...fromBuiltins]
}

const router: IRouter = Router()

/**
 * GET /api/agent/settings — return the runtime defaults + alias table
 * that the picker UI consumes.
 *
 * `defaultModel` is resolved via the same 5-layer chain as
 * resolveModel() — so the UI's fallback display matches what the
 * server will actually pick at runtime when no session override is set.
 *
 * `models` merges (in order): user settings.models[] → saved
 * providerProfiles → builtin catalog. The picker is never empty even
 * on a fresh install, but user edits are preserved on alias collision.
 *
 * `outputStyle` exposes the persisted transcript rendering preference
 * so the SettingsDrawer can render the right selected row on cold
 * start (no flash of "default" before the GET resolves).
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await readZaiSettings()
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    const models = buildAvailableModels(settings)
    const outputStyle = resolveOutputStyle(settings)
    const theme = resolveTheme(settings)
    const workMode = resolveWorkMode(settings)
    const maxVisibleMessages =
      typeof settings.maxVisibleMessages === 'number'
        ? Math.max(1, Math.min(1000, Math.floor(settings.maxVisibleMessages)))
        : 20
    const defaultSplitScreen = resolveDefaultSplitScreen(settings)
    const enableDynamicWorkflow = resolveEnableDynamicWorkflow(settings)
    const enableComputerUse = resolveEnableComputerUse(settings)
    const autoUpdate = resolveAutoUpdate(settings)
    // 自动记忆三件套。前两个是 vendor `memory.*` 的原生值;autoDreamEnabled
    // 是顶层字段。SettingsDrawer 的三个 boolean 行直接订阅这三个派生值。
    const memoryAutoWrite = resolveMemoryAutoWrite(settings)
    const memoryRequireApproval = resolveMemoryRequireApproval(settings)
    const autoDreamEnabled = resolveAutoDreamEnabled(settings)
    // 会话归档保留条数（派生值，磁盘上可能是缺失 / 垃圾值）。
    const archiveKeepCount = resolveArchiveKeepCount(settings)
    // zai patch (2026-08-20): 主 Agent —— 当前选择 + 可选列表(内置 + 外置
    // ~/.zai/main-agents/*.js 合并),供 SettingsDrawer 的 Agent 选择行渲染。
    const { agent: mainAgent, agents: mainAgents } = await resolveMainAgent(
      settings.mainAgent,
    )
    res.json({
      defaultModel,
      baseURL,
      models,
      defaultMode: getDefaultMode(),
      outputStyle,
      theme,
      workMode,
      maxVisibleMessages,
      defaultSplitScreen,
      enableDynamicWorkflow,
      enableComputerUse,
      autoUpdate,
      memoryAutoWrite,
      memoryRequireApproval,
      autoDreamEnabled,
      archiveKeepCount,
      mainAgent: mainAgent.name,
      mainAgents: mainAgents.map((a) => ({
        name: a.name,
        description: a.description,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/work-mode — persist the global working mode.
 * Body is `{ workMode: 'code' | 'office' | 'general' }`.
 */
router.put('/agent/settings/work-mode', async (req: Request, res: Response) => {
  const candidate = (req.body as { workMode?: unknown } | undefined)?.workMode
  if (!isValidWorkMode(candidate)) {
    return res
      .status(400)
      .json({ error: `invalid workMode: ${String(candidate)}` })
  }
  try {
    const next = await updateZaiSettings({ workMode: candidate as WorkMode })
    res.json({ workMode: next.workMode })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/output-style — persist the web UI's
 * transcript output style. Body is
 * `{ outputStyle: 'default' | 'compact' | 'verbose' }`. The server
 * validates the value and round-trips the existing settings.json
 * (other fields preserved).
 *
 * Used by SettingsDrawer when the user changes the "输出样式" row.
 * Returns the persisted value so the client can echo the canonical
 * form back (in case it sent a typo).
 */
router.put('/agent/settings/output-style', async (req: Request, res: Response) => {
  const candidate = (req.body as { outputStyle?: unknown } | undefined)?.outputStyle
  if (!isValidOutputStyle(candidate)) {
    return res
      .status(400)
      .json({ error: `invalid outputStyle: ${String(candidate)}` })
  }
  try {
    const next = await updateZaiSettings({ outputStyle: candidate as OutputStyle })
    res.json({ outputStyle: next.outputStyle })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/theme — persist the web UI's theme preference.
 * Body is `{ theme: 'auto' | 'dark' | 'light' | 'high-contrast' }`. The
 * server validates the value and round-trips the existing settings.json
 * (other fields preserved).
 *
 * Used by SettingsDrawer when the user changes the "主题" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put('/agent/settings/theme', async (req: Request, res: Response) => {
  const candidate = (req.body as { theme?: unknown } | undefined)?.theme
  if (!isValidTheme(candidate)) {
    return res.status(400).json({ error: `invalid theme: ${String(candidate)}` })
  }
  try {
    const next = await updateZaiSettings({ theme: candidate as Theme })
    res.json({ theme: next.theme })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/max-visible-messages — persist the web UI's
 * "消息最大显示条数" setting. Body is `{ value: number }`.
 * Server clamps to [1, 1000] and floors fractional inputs.
 *
 * Used by SettingsDrawer when the user changes the "消息最大显示条数" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put(
  '/agent/settings/max-visible-messages',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: `invalid value: ${String(raw)}` })
    }
    const clamped = Math.max(1, Math.min(1000, Math.floor(n)))
    try {
      const next = await updateZaiSettings({ maxVisibleMessages: clamped })
      res.json({ value: next.maxVisibleMessages })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/archive-keep-count — 持久化「会话归档保留条数」。
 * Body 是 `{ value: number }`，服务端 floor + clamp 到 [1, 1000]。
 *
 * 与 max-visible-messages 同款：宽容接受可转数字的字符串，非法 → 400，
 * 返回持久化后的规范值让客户端回显。
 *
 * 生效时机：写盘即持久。归档扫描只在「服务启动」与「立即归档」时读配置，
 * 所以不需要重启 —— 与 memory 三件套的"重启后生效"不同。
 */
router.put(
  '/agent/settings/archive-keep-count',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    const clamped = toArchiveKeepCount(raw)
    if (clamped === null) {
      return res
        .status(400)
        .json({ error: `invalid archive.keepCount: ${String(raw)}` })
    }
    try {
      const current = await readZaiSettings()
      await updateZaiSettings({
        archive: { ...(current.archive ?? {}), keepCount: clamped },
      })
      res.json({ value: clamped })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/default-split-screen — persist the web UI's
 * "默认启动分屏" setting. Body is `{ value: boolean }`.
 *
 * Used by SettingsDrawer when the user toggles the "默认启动分屏" row.
 * Returns the persisted value so the client echoes back the canonical form.
 *
 * Note: this only seeds the first-run default in localStorage — a user who
 * has already toggled the split-pane manually retains their explicit choice
 * (see SplitPane.tsx first-run seed effect for details).
 */
router.put(
  '/agent/settings/default-split-screen',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    if (!isValidDefaultSplitScreen(raw)) {
      return res
        .status(400)
        .json({ error: `invalid defaultSplitScreen: ${String(raw)}` })
    }
    try {
      const next = await updateZaiSettings({ defaultSplitScreen: raw })
      res.json({ value: next.defaultSplitScreen })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/enable-dynamic-workflow — persist the web UI's
 * "启用动态工作流" toggle. Body is `{ value: boolean }`.
 *
 * Why this lives in zai-server (not vendor's settings pipeline):
 *   - zai controls whether the WorkflowTool gets registered into the
 *     LLM-facing tool pool. Default is OFF (workflows cost dozens of
 *     agents + tokens per run) — the user must opt in.
 *   - The toggle writes the persisted flag AND mutates
 *     `process.env.OPENCC_ENABLE_WORKFLOWS` so vendor's
 *     `isWorkflowsDisabled()` returns false on the very next
 *     `getAllBaseTools()` call. env var mutation is safe — vendor reads
 *     it fresh on every call, and a process restart will read the
 *     persisted settings.json again on boot via
 *     `enableOpenccConfigs → applyZaiWorkflowEnableFromSettings`.
 *
 * Returns the persisted value so the client echoes back the canonical
 * form (true/false, never undefined).
 */
router.put(
  '/agent/settings/enable-dynamic-workflow',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    if (!isValidEnableDynamicWorkflow(raw)) {
      return res
        .status(400)
        .json({ error: `invalid enableDynamicWorkflow: ${String(raw)}` })
    }
    try {
      const next = await updateZaiSettings({ enableDynamicWorkflow: raw })
      // Bridge to vendor's runtime gate. Mirror of the boot-time logic
      // in `enableOpenccConfigs() → applyZaiWorkflowEnableFromSettings()`:
      // mutate `process.env.OPENCC_ENABLE_WORKFLOWS` so the very next
      // `query()` call's `getAllBaseTools()` filters WorkflowTool in/out
      // accordingly. The persisted settings.json is the source of truth;
      // a process restart re-applies this bridge from disk.
      if (raw) {
        process.env.OPENCC_ENABLE_WORKFLOWS = '1'
      } else {
        delete process.env.OPENCC_ENABLE_WORKFLOWS
      }
      res.json({ value: next.enableDynamicWorkflow })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/auto-update — 持久化 zai 自身版本自动升级开关。
 * Body 是 `{ value: boolean }`。
 *
 * 与 enable-dynamic-workflow 的区别:本开关不需要同步写 process.env。
 * `maybeAutoUpdate()` 在每次启动读 settings.json 时已经走了 resolveAutoUpdate
 * (默认 true);运行中的 toggle 只影响"下次启动"的判断 — 用户切到 false 后,
 * 重启 zai 才会跳过 npm view / npm install -g,运行中的进程可能仍在
 * 后台跑完这次的 install。这是 by-design:运行中已发出的 installing
 * 不应被半路取消,免得新版本残留在 npm cache 但未安装。
 *
 * SettingsDrawer 改这一行时调用,返回持久化后的值让客户端 echo canonical。
 */
router.put('/agent/settings/auto-update', async (req: Request, res: Response) => {
  const raw = (req.body as { value?: unknown } | undefined)?.value
  if (!isValidAutoUpdate(raw)) {
    return res.status(400).json({ error: `invalid autoUpdate: ${String(raw)}` })
  }
  try {
    const next = await updateZaiSettings({ autoUpdate: raw })
    res.json({ value: next.autoUpdate })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/main-agent — 持久化主 Agent 选择。
 * Body 是 `{ mainAgent: string }`(内置或 ~/.zai/main-agents/*.js 的 agent
 * name)。值必须存在于合并后的 mainAgents 列表,否则 400。
 *
 * 生效时机:systemPrompt 槽对新会话生效、tools 槽即时、mcp 槽需重启
 * (见 docs/superpowers/specs/2026-08-20-zai-main-agent-slots-design.md)。
 */
router.put('/agent/settings/main-agent', async (req: Request, res: Response) => {
  const candidate = (req.body as { mainAgent?: unknown } | undefined)?.mainAgent
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return res.status(400).json({ error: `invalid mainAgent: ${String(candidate)}` })
  }
  try {
    const { agents } = await resolveMainAgent(undefined)
    if (!agents.some((a) => a.name === candidate)) {
      return res.status(400).json({ error: `unknown mainAgent: ${candidate}` })
    }
    const next = await updateZaiSettings({ mainAgent: candidate })
    res.json({ mainAgent: next.mainAgent })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/opencc-cli-dangerously-skip — 持久化 bypass 权限
 * 可用性开关 (zai patch 2026-08-29, plan §A)。Body 是
 * `{ openccCliDangerouslySkip: boolean }`,写入 settings.openccCliDangerouslySkip。
 *
 * 生效时机:**重启实例后**——运行时在 `initAgentRuntime` 只解析一次;且
 * env `ZAI_DANGEROUSLY_SKIP_PERMISSIONS=1` 优先级更高,会盖过本设置。
 *
 * 若 `settings.permissions.disableBypassPermissionsMode === 'disable'`,
 * 即使 option 持久化成功,`initAgentRuntime` 启动时仍会 throw 拒绝 ——
 * 不静默覆盖用户显式 opt-out。
 */
router.put(
  '/agent/settings/opencc-cli-dangerously-skip',
  async (req: Request, res: Response) => {
    const candidate = (req.body as
      | { openccCliDangerouslySkip?: unknown }
      | undefined)?.openccCliDangerouslySkip
    if (!isValidOpenccCliDangerouslySkip(candidate)) {
      return res
        .status(400)
        .json({
          error: `invalid openccCliDangerouslySkip: ${String(candidate)}`,
        })
    }
    try {
      const next = await updateZaiSettings({
        openccCliDangerouslySkip: candidate,
      })
      res.json({
        openccCliDangerouslySkip: resolveOpenccCliDangerouslySkip(next),
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/computer-use — persist the web UI's
 * "启用 Computer Use (cua-driver)" toggle. Body is `{ value: boolean }`.
 *
 * Since the 2026-09-22 OR-bridge change, the SettingsDrawer toggle
 * controls ONLY the persisted `settings.computerUse.enabled` flag.
 * `process.env.OPENCC_ENABLE_COMPUTER_USE` is treated as an independent
 * control surface (per-process ops switch) — toggling here will:
 *   - on  (`raw === true`): write settings.json AND set env to '1'
 *     (forward-bridge; lets the current process and any just-spawned
 *     children see the change without restart).
 *   - off (`raw === false`): write settings.json enabled=false ONLY.
 *     We deliberately do NOT delete `OPENCC_ENABLE_COMPUTER_USE` —
 *     the env var and settings.json are independent opt-ins per the
 *     OR-bridge contract. Ops who set the env want the channel on for
 *     this process regardless of what the UI toggles say.
 *
 * Platform gate: non-darwin rejects with 409 `requires_darwin`. The UI
 * also disables the row on non-darwin; this is the server-side
 * enforcement for the case where someone Pokes the API directly.
 *
 * The cua-driver binary itself is NOT bundled — user must install it
 * (brew install --cask cua-driver) or set `binaryPath` in
 * `~/.zai/settings.json` under `computerUse.binaryPath`. A separate
 * GET /api/agent/computer-use/status surfaces whether the binary is
 * resolvable on $PATH so the UI can show a one-line hint.
 */
router.put('/agent/settings/computer-use', async (req: Request, res: Response) => {
  const raw = (req.body as { value?: unknown } | undefined)?.value
  if (!isValidEnableComputerUse(raw)) {
    return res
      .status(400)
      .json({ error: `invalid enableComputerUse: ${String(raw)}` })
  }
  if (raw && process.platform !== 'darwin') {
    return res.status(409).json({
      error: `requires_darwin: computer use only ships on macOS (got ${process.platform})`,
    })
  }
  try {
    // Single source of truth: write to the vendor schema field
    // `settings.computerUse.enabled`. Preserves any sibling fields
    // (command / args / binaryPath / platforms) the user already set.
    const current = await readZaiSettings()
    const cu = current.computerUse ?? {}
    const next = await updateZaiSettings({
      computerUse: { ...cu, enabled: raw },
      // Mirror to the legacy flat field for any code paths that still
      // read it. The `resolveEnableComputerUse()` reader prefers the
      // nested field, so this is a pure additive write.
      enableComputerUse: raw,
    })
    // OR-bridge (2026-09-22): only set env when toggle goes ON.
    // Toggle OFF leaves any pre-existing OPENCC_ENABLE_COMPUTER_USE alone
    // so ops can keep the channel on for this process via env-only.
    if (raw) {
      process.env.OPENCC_ENABLE_COMPUTER_USE = '1'
    }
    // Toggle response reflects the *persisted* settings.json state, not
    // the runtime gate. The runtime gate = env OR settings (see
    // isComputerUseEnabled() in zn-agent-core); UI consumers who need the
    // effective value should call resolveEnableComputerUse() or hit
    // GET /api/agent/computer-use/status.
    res.json({ value: resolveEnableComputerUse(next) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * GET /api/agent/computer-use/status — probe whether the cua-driver
 * binary is resolvable so the settings drawer can show a one-line hint.
 * Returns `{ installed: boolean, path?: string, command: string, args: string[] }`.
 *
 * Cheap (a single `which` exec per call); SettingsDrawer calls it once on
 * mount. We do NOT cache — a 200ms hiccup if the user just installed
 * cua-driver is acceptable, and caching would need invalidation on PATH
 * changes.
 */
router.get('/agent/computer-use/status', async (_req: Request, res: Response) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const command = 'cua-driver'
  try {
    const { stdout } = await execFileP('which', [command])
    const resolved = stdout.split('\n')[0]?.trim()
    res.json({
      installed: typeof resolved === 'string' && resolved.length > 0,
      path: resolved && resolved.length > 0 ? resolved : undefined,
      command,
      args: ['mcp'],
    })
  } catch {
    res.json({
      installed: false,
      command,
      args: ['mcp'],
    })
  }
})

// ============================================================================
// 自动记忆(auto-memory)三件套
// ============================================================================
//
// 三个开关直接写 vendor 的原生键位(vendor 用同一份 ~/.zai/settings.json 作为
// userSettings 源),因此不做 zai 侧镜像字段 —— 写什么、vendor 就读什么:
//   memory.autoWrite                ← 总开关
//   memory.requireApprovalBeforeWrite ← 写记忆是否仍需审批
//   autoDreamEnabled                ← 夜间固化
//
// 三者的时效:**重启实例后**。vendor settings 读取走进程内缓存
// (getSettingsForSource → getCachedSettingsForSource),zai 的 PUT 只写盘。
// 与既有 opencc-cli-dangerously-skip 同款语义,UI 在 section 标题标注。
//
// 嵌套写注意:updateZaiSettings 是浅合并({...settings, ...patch}),所以写
// memory 块时必须先读出当前值再展开,否则会把同级字段抹掉(与 computer-use
// route 处理 computerUse 的写法一致)。

/**
 * PUT /api/agent/settings/memory-auto-write — 持久化「启用自动记忆」总开关。
 * Body 是 `{ value: boolean }` → `memory.autoWrite`。
 *
 * 关掉后 vendor `isAutoMemoryEnabled()` 返回 false:系统提示词不再注入记忆
 * 行为指令,MEMORY.md 既不读也不写,后台抽取与固化一并停摆。
 */
router.put('/agent/settings/memory-auto-write', async (req: Request, res: Response) => {
  const raw = (req.body as { value?: unknown } | undefined)?.value
  if (!isValidMemoryAutoWrite(raw)) {
    return res
      .status(400)
      .json({ error: `invalid memory.autoWrite: ${String(raw)}` })
  }
  try {
    const current = await readZaiSettings()
    const next = await updateZaiSettings({
      memory: { ...(current.memory ?? {}), autoWrite: raw },
    })
    res.json({ value: resolveMemoryAutoWrite(next) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * PUT /api/agent/settings/memory-require-approval — 持久化
 * `memory.requireApprovalBeforeWrite`。Body 是 `{ value: boolean }`。
 *
 * 语义按 vendor 原义:**value = true 表示"写记忆仍需用户审批"**(更安全,
 * 也是默认值)。SettingsDrawer 的「自动写入记忆」行展示的是它的反值 ——
 * 用户打开该行 = "免审批" = 这里收到 `value: false`。反转只在抽屉那一处发生,
 * 服务端与磁盘始终存 vendor 原义。
 *
 * 设为 false 会同时放开两件事(同一个同意信号):
 *   1. 主 agent 可直接写记忆,不再逐次弹确认;
 *   2. vendor `isExtractModeActive()` 成立 → turn 末后台自动抽取开始运行。
 */
router.put(
  '/agent/settings/memory-require-approval',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    if (!isValidMemoryRequireApproval(raw)) {
      return res.status(400).json({
        error: `invalid memory.requireApprovalBeforeWrite: ${String(raw)}`,
      })
    }
    try {
      const current = await readZaiSettings()
      const next = await updateZaiSettings({
        memory: { ...(current.memory ?? {}), requireApprovalBeforeWrite: raw },
      })
      res.json({ value: resolveMemoryRequireApproval(next) })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)

/**
 * PUT /api/agent/settings/auto-dream — 持久化夜间记忆固化开关。
 * Body 是 `{ value: boolean }` → 顶层 `autoDreamEnabled`。
 *
 * 注意:光打开本开关并不足以让固化运行,vendor `isGateOpen()` 还要求
 * `memory.requireApprovalBeforeWrite === false`(免审批),以及
 * "距上次 ≥24h + 活跃会话数 ≥5"的时间/会话门。
 */
router.put('/agent/settings/auto-dream', async (req: Request, res: Response) => {
  const raw = (req.body as { value?: unknown } | undefined)?.value
  if (!isValidAutoDreamEnabled(raw)) {
    return res
      .status(400)
      .json({ error: `invalid autoDreamEnabled: ${String(raw)}` })
  }
  try {
    const next = await updateZaiSettings({ autoDreamEnabled: raw })
    res.json({ value: resolveAutoDreamEnabled(next) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
