/**
 * Permission mode exports — self-contained (no opencc-src dependency).
 *
 * The original compat shim re-exported from `opencc-src/types/permissions.ts`,
 * which pulled in a large transitive graph (React JSX, opentelemetry, lodash-es,
 * etc.) and broke the build. This file defines the small subset that zai needs.
 *
 * zai only consumes:
 *   - `EXTERNAL_PERMISSION_MODES` (const array, used to validate user input)
 *   - `PERMISSION_MODES` (const array, exhaustive runtime set including 'auto')
 *   - `ExternalPermissionMode` (string-literal type)
 *   - `PermissionMode` (string-literal type)
 *   - `UserFacingPermissionMode` (alias of `ExternalPermissionMode`)
 *   - `getDefaultMode` (reads ~/.zai/settings.json — fallback for legacy
 *      sessions whose transcript meta predates the permissionMode field,
 *      so the UI badge reflects the user's configured default instead of
 *      being pinned to 'default')
 *
 * If opencc's full permission model is later required (decision reasons, rule
 * sources, classifier results, etc.), add a separate module rather than
 * widening this one — the goal here is to keep the build free of UI/React
 * transitive deps.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// Exhaustive mode union for typechecking. The user-addressable runtime set
// includes zai's 'auto' mode (autonomous execution, classifier-driven).
export type PermissionMode = ExternalPermissionMode | 'auto'

export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'auto',
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

/**
 * UserFacingPermissionMode — subset of ExternalPermissionMode exposed to
 * the zai UI. Identical to ExternalPermissionMode in zai's current code.
 */
export type UserFacingPermissionMode = ExternalPermissionMode

const VALID_DEFAULT_MODES: ReadonlySet<UserFacingPermissionMode> = new Set(
  EXTERNAL_PERMISSION_MODES,
)

/**
 * zai 数据目录解析 — 与 `paths.ts` 的 `resolveZaiDir()` 同一口径。
 *
 * zai patch (2026-10-17, cl-003):此前这里写死 `join(homedir(), '.zai', …)`,
 * 完全不看 `ZAI_DATA_DIR`,于是设了隔离目录的实例读的是**用户真实**的
 * `~/.zai/settings.json`,权限模式的判定结果与实例自身配置不符。
 * (`d66d09f5` 声称「收口全部调用点」,这一处漏了。)
 *
 * compat 够不到 zai 的 `paths.ts`(那是 zai 包的服务,compat 不能反向依赖),
 * 所以自带一份 —— 这是**结构性约束而非疏忽**,同包 `taskListStore.ts` 同理。
 *
 * 两个细节照抄 `taskListStore.ts` 的理由:
 *   - 用 `homedir()` 而非 `$HOME`:与 `paths.ts:23` 同口径,Windows 上
 *     `$HOME` 通常不存在,原实现在那儿会掉到 `/tmp`。
 *   - **函数形态而非模块级常量**:ESM 顶层 import 在模块加载时即求值,而
 *     测试要在设完 `ZAI_DATA_DIR` 之后才让路径生效。
 */
function zaiDir(): string {
  return process.env.ZAI_DATA_DIR || join(homedir(), '.zai')
}

/**
 * Read the default permission mode from ~/.zai/settings.json.
 *
 * Resolution order:
 *   1. settings.permissions.defaultMode — the opencc convention (the
 *      `permissions` block also carries allow/deny/ask rules). A user who
 *      writes `permissions.defaultMode: "bypassPermissions"` expects new
 *      sessions to boot in that mode; before this fix the value lived in
 *      `permissions`, so zai silently fell back to 'default' and MCP
 *      tools (e.g. codegraph) kept prompting even though allow rules
 *      were configured.
 *   2. settings.defaultMode (legacy top-level key, if present)
 *   3. 'default' (hardcoded fallback)
 *
 * File IO errors other than ENOENT / SyntaxError are silently treated
 * as "no defaultMode configured" — same defensive pattern as the rest
 * of the zai server.
 *
 * Lives in compat (not zai/src/server) so legacyTranscriptStore can use
 * it as the permissionMode fallback for sessions whose transcript meta
 * predates the field — without taking a reverse zai→compat dependency.
 */
export function getDefaultMode(): UserFacingPermissionMode {
  try {
    const path = join(zaiDir(), 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      defaultMode?: unknown
      permissions?: { defaultMode?: unknown }
    }
    const candidate = parsed.permissions?.defaultMode ?? parsed.defaultMode
    if (
      typeof candidate === 'string' &&
      VALID_DEFAULT_MODES.has(candidate as UserFacingPermissionMode)
    ) {
      return candidate as UserFacingPermissionMode
    }
  } catch (err) {
    // ENOENT(没配过)与 SyntaxError(文件坏了)是常态,静默回落即可。其余是
    // 真 IO 错误 —— 此前这个分支**只有注释没有语句**,于是「读不到」与
    // 「读到了但没这个字段」在行为上完全不可区分,排障时看不到任何线索
    // (cl-003)。补一条 warn,不动返回语义。
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[permissions] getDefaultMode: read settings failed:', err)
    }
  }
  return 'default'
}
