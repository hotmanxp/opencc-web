import { readFile, mkdir } from 'node:fs/promises'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentKernel, ZaiSettings } from '../../shared/settings.js'
import { writeZaiSettings, zaiSettingsPath } from './zaiSettingsStore.js'

/**
 * 项目级 zai 设置覆盖层 — B0 T0.1。
 *
 * 三层优先级（主计划 §4.1）：
 *   1. 项目级 `<cwd>/.zai/settings.json` （新）
 *   2. 用户级 `~/.zai/settings.json`  （现有）
 *   3. 内置默认值                     （现有）
 *
 * 合并语义：浅合并 — 项目级字段覆盖用户级字段；其余字段保留用户级原值。
 * 这是最简实现，主计划 §4.1 明确接受「最简实现：项目级存在则浅合并到用户级副本上」。
 *
 * 非法值 fail loud：B0 验收要求 3 — `agent.kernel` 非法值时启动失败并给修复指引，
 * 不静默回落。理由：避免误配（如手写成 `'DSH'`）触发 dsh 代码路径但行为未知。
 *
 * 注意：当前 zaiSettingsStore 的缓存层（zaiSettingsCache.ts）只缓存用户级解析结果。
 * 项目级覆盖在 read 时即时合并（每次调用 readProjectAwareZaiSettings），不污染
 * 现有 cache 接口；这是最简实现，性能开销可接受（项目级 settings.json < 1KB）。
 *
 * B0 验收要求 6：「项目级配置覆盖可用（用户级 + 项目级 + 默认 三层）」。
 */

const PROJECT_ZAI_DIRNAME = '.zai'
const PROJECT_SETTINGS_FILENAME = 'settings.json'

/**
 * CLI `--kernel` 覆盖值在 boot 阶段被写入此 env,后续 resolveAgentKernel
 * 读 env 优先于 settings.json。这条路径**不**写持久化配置 —— 用户改
 * `settings.json` 或下次不带 `--kernel` 启动都自然回到 settings 解析。
 *
 * env 来源:cli/index.ts → runDev/runStart → createApp(...)
 * → createApp 顶部 `process.env.ZAI_KERNEL_OVERRIDE = opts.kernelOverride`
 * → resolveAgentKernel 顶部 readKernelOverride() 命中。
 *
 * 非法值(env 设了 'foo')由 readKernelOverride 抛 InvalidAgentKernelError,
 * 与 settings 非法值走同一条 fail loud 路径 — 避免 CLI 误拼写(如
 * `--kernel=DSH`)被静默忽略导致 dsh 路径意外加载。
 */
export const KERNEL_OVERRIDE_ENV = 'ZAI_KERNEL_OVERRIDE'

const VALID_AGENT_KERNELS: ReadonlySet<AgentKernel> = new Set<AgentKernel>(['opencc', 'dsh'])

/**
 * 读取 CLI --kernel 覆盖值。返回 undefined 表示无覆盖(走 settings)。
 * 非法值抛 InvalidAgentKernelError。
 */
export function readKernelOverride(): AgentKernel | undefined {
  const raw = process.env[KERNEL_OVERRIDE_ENV]
  if (raw === undefined || raw === '') return undefined
  if (VALID_AGENT_KERNELS.has(raw as AgentKernel)) {
    return raw as AgentKernel
  }
  throw new InvalidAgentKernelError(raw)
}

/** 项目级 settings.json 路径 — 跟 cwd 拼装，不依赖 ENV。 */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_ZAI_DIRNAME, PROJECT_SETTINGS_FILENAME)
}

/**
 * 读取项目级 settings.json（若存在）。文件缺失 / 非法 JSON → undefined，调用方
 * 走用户级 fallback。
 */
export async function tryReadProjectSettings(cwd: string): Promise<ZaiSettings | undefined> {
  const path = projectSettingsPath(cwd)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as ZaiSettings
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (err instanceof SyntaxError) return undefined
    throw err
  }
}

/**
 * 三层合并：项目级 > 用户级 > builtin 默认。
 *
 * @param user 用户级（已解析）settings，可能为 builtin 默认填充
 * @param project 项目级 settings，若 undefined 则视为空覆盖
 */
export function mergeSettings(user: ZaiSettings, project: ZaiSettings | undefined): ZaiSettings {
  if (project === undefined) return user
  // 浅合并 — 项目级字段覆盖用户级字段；其它键保留用户级原值。
  // 这是 B0 最简实现（主计划 §4.1）：不深递归，未来若需要嵌套合并可换成 deep merge。
  return { ...user, ...project }
}

/**
 * 校验 `agent.kernel` 字段合法性。非法值抛错 — 不静默回落。
 *
 * 错误信息含修复指引（提示要么改值要么删字段）。
 */
export class InvalidAgentKernelError extends Error {
  readonly received: unknown
  constructor(received: unknown) {
    const valueStr = JSON.stringify(received)
    super(
      `[zai-settings] agent.kernel 非法值: ${valueStr}。合法值为 'opencc' | 'dsh'。` +
        `请编辑 ~/.zai/settings.json 或 <cwd>/.zai/settings.json 修正后重启 zai。`,
    )
    this.name = 'InvalidAgentKernelError'
    this.received = received
  }
}

/** 校验 settings 整体的 agent.kernel 字段；无字段 / undefined 直接通过。 */
export function validateAgentKernel(settings: ZaiSettings): void {
  const kernel = settings.agent?.kernel
  if (kernel === undefined) return
  if (typeof kernel !== 'string' || !VALID_AGENT_KERNELS.has(kernel as AgentKernel)) {
    throw new InvalidAgentKernelError(kernel)
  }
}

/**
 * 三层合并 + 校验 — B0 启动入口推荐走这个函数：
 *
 *   const settings = await resolveProjectAwareSettings(cwd)
 *
 * 顺序：
 *   1. 读用户级（异步，缓存层已存在）
 *   2. 读项目级（若存在）
 *   3. 浅合并
 *   4. 校验 agent.kernel — 非法值 fail loud
 */
export async function resolveProjectAwareSettings(cwd: string): Promise<ZaiSettings> {
  // 用户级读取走缓存，避免每请求都打文件。
  const { readZaiSettings } = await import('./zaiSettingsStore.js')
  const user = await readZaiSettings()
  const project = await tryReadProjectSettings(cwd)
  const merged = mergeSettings(user, project)
  validateAgentKernel(merged)
  return merged
}

/**
 * 解析当前 cwd 下生效的 `agent.kernel` — createKernel 入口用。
 * 非法值由 resolveProjectAwareSettings 抛错，这里不重复校验。
 *
 * 解析优先级 (主计划 §4.1):
 *   1. CLI `--kernel` 覆盖 (process.env.ZAI_KERNEL_OVERRIDE)
 *   2. settings.agent.kernel (用户级 → 项目级合并)
 *   3. 默认 'opencc'
 *
 * 覆盖值若非法(readKernelOverride 抛 InvalidAgentKernelError)同样 fail loud,
 * 与 settings 非法值同等待遇。
 */
export async function resolveAgentKernel(cwd: string): Promise<AgentKernel> {
  const override = readKernelOverride()
  if (override !== undefined) return override
  const settings = await resolveProjectAwareSettings(cwd)
  return settings.agent?.kernel ?? 'opencc'
}

/**
 * 写项目级 settings.json — 原子写 + mkdir -p，保证 cwd/.zai/ 存在。
 * 不与用户级联动；写项目级不会触动 ~/.zai/settings.json。
 */
export async function writeProjectSettings(cwd: string, settings: ZaiSettings): Promise<void> {
  const path = projectSettingsPath(cwd)
  await mkdir(join(cwd, PROJECT_ZAI_DIRNAME), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

// 重新导出 zaiSettingsPath 与 writeZaiSettings，避免调用方多写 import。
export { zaiSettingsPath, writeZaiSettings }