/**
 * 构造并 spawn `opencc -p` 会话子进程(B1 路线)。参数对齐
 * docs/superpowers/specs/2026-08-24-zai-runtime-printts-sse-web-bridge.md §5.4
 * baseline,并参考 vendor bridge/sessionRunner.ts(同款 spawn 形态)。
 *
 * 关键点:
 * - `--session-id <纯uuid>`:vendor 校验 "must be a valid UUID"。zai 的
 *   sessionId(`sess-<uuid>` 或 `sess-<timestamp>-<rand>`)剥离前缀后不保证
 *   是 UUID,因此 SessionHost 构造时另生成稳定的 vendor UUID 传入
 *   (见 SessionHost.vendorSessionId),这里直接把 opts.sessionId 当 uuid 用。
 * - 新会话与恢复都传 `--session-id`(显式固定会话);resume 时追加
 *   `--resume` 让 vendor loadInitialMessages 从 JSONL hydrate(Phase C 使能,
 *   Phase A 不传)。
 * - `--no-session-persistence`:vendor 不落盘 —— zai 侧 sessionFacade 负责
 *   持久化,避免双写 + 文件名前缀差异污染 zai 会话列表。
 * - `--dangerously-skip-permissions`:Phase A 全局放权(权限桥 Phase B 落地,
 *   spec §5.6.3 记录了该 semantics 切换)。Bash/AskUserQuestion 等不再触发
 *   can_use_tool control_request,子进程不会卡在权限等待上。
 * - 刻意不用 `--bare`:vendor 的 `--bare` 会设 `CLAUDE_CODE_SIMPLE=1`,从而
 *   把 `getTools()`(vendor tools.ts simple mode)裁剪成只剩 Bash/Read/Edit
 *   三个工具(SessionHost 只发 prompt 不给 Windows/tools,mode 完全由 CLI 决定),
 *   导致 B1 下 Agent "可用工具" 缺失 Glob/Grep/Write/WebFetch 等。移除后走
 *   全量 built-in 工具池;代价是 hooks / LSP / CLAUDE.md 重新激活、冷启动多
 *   ~1.6s(spec §5.4 baseline 最初用 `--bare` 即为此,已按此偏离记录)。
 *   spawn env 仍显式压平 `CLAUDE_CODE_SIMPLE='0'`,防宿主 shell 泄漏该变量。
 * - 不显式传 model:zai dev 注入的 ANTHROPIC_DEFAULT_*_MODEL 已随 env 继承,
 *   vendor mainLoopModel 默认即它;持久化在 zai 的 resolveModel 层。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveSpawnCommand } from '../spawner.js'
import type { SpawnRequest } from './types.js'

export interface SessionHostHandle {
  child: ChildProcess
}

/**
 * 保留仅作文档/调试:zai sessionId → vendor sessionId 的属性换算已不再是
 * 简单剥离前缀(zai 也有 `sess-<timestamp>-<rand>` 形态),实际的 vendor
 * UUID 由 SessionHost 构造时生成并直接传入 opts.sessionId。
 */
export function toVendorSessionId(sessionId: string): string {
  return sessionId.replace(/^sess-/, '')
}

/**
 * 子进程 env 白名单 —— 最小权限透传。
 *
 * 之前 spawn 直接 `{...process.env}` 会把宿主(zai server)全部环境变量
 * 注入子进程,含 ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY / GEMINI_API_KEY 等
 * 全部 LLM provider 凭证 —— 任何宿主 shell 临时变量、CI 注入的密钥、
 * 与 zai 业务无关的 user-level 配置都会一并透传,违反最小权限原则。
 *
 * 新策略:只透传以下三类,其它一律丢弃:
 * - **runtime 必备**:PATH / HOME / USER / SHELL / LANG / LC_ALL / TZ /
 *   TMPDIR / NODE_ENV / PWD / OLDPWD / TERM —— 这些是 Node 子进程、
 *   vendor CLI、shell 调用链上的硬依赖,缺一就启动失败或行为异常。
 * - **LLM 凭证白名单前缀**:ANTHROPIC_* / OPENAI_* / GEMINI_* / GOOGLE_*
 *   / DEEPSEEK_* —— zai 业务上需要把当前选中的 provider 凭证交给
 *   vendor 子进程;按前缀匹配允许覆盖 OPENAI_BASE_URL 等自定义项。
 *   同时显式包含 `*_API_KEY` 与 `*_AUTH_TOKEN` 形式,以兼容第三方
 *   proxy / 中转服务设置的 `CUSTOM_OPENAI_API_KEY` 等命名。
 * - **业务锚点**:CLAUDE_CODE_SIMPLE = '0' 压平宿主泄漏,防 vendor 误
 *   裁剪工具池(spec §5.4 baseline 已记录)。
 *
 * 其它一律丢(包括:`DATABASE_URL` / `SSH_AUTH_SOCK` / `GIT_*` / 用户
 * shell 自定义变量 / 任何未列入白名单的 *_TOKEN / *_SECRET 等)。
 *
 * 函数纯函数化便于 vitest:无副作用,只读 `process.env`,返回新对象。
 */
const WHITELIST_EXACT = new Set<string>([
  // runtime
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'PWD',
  'OLDPWD',
  'TERM',
  // business anchor
  'CLAUDE_CODE_SIMPLE',
])

const WHITELIST_PREFIXES: readonly string[] = [
  // LLM provider 凭证 + 配置(按前缀匹配,覆盖 *_API_KEY / *_AUTH_TOKEN
  // / *_BASE_URL / *_DEFAULT_*_MODEL 等常见命名形态)
  'ANTHROPIC_',
  'OPENAI_',
  'GEMINI_',
  'GOOGLE_',
  'DEEPSEEK_',
]

export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(source)) {
    if (WHITELIST_EXACT.has(key)) {
      const value = source[key]
      if (value !== undefined) env[key] = value
      continue
    }
    if (WHITELIST_PREFIXES.some((p) => key.startsWith(p))) {
      const value = source[key]
      if (value !== undefined) env[key] = value
      continue
    }
  }
  // 业务锚点 —— 强制压平,即使宿主未注入也写死 '0',防 vendor
  // `--bare` 模式裁剪工具池(spec §5.4)。
  env.CLAUDE_CODE_SIMPLE = '0'
  return env
}

export function buildCliArgs(opts: SpawnRequest): string[] {
  const vendorSid = opts.sessionId
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--no-session-persistence',
    '--dangerously-skip-permissions',
    '--session-id',
    vendorSid,
  ]
  if (opts.resume) {
    args.push('--resume', vendorSid)
  }
  if (opts.model) {
    args.push('--model', opts.model)
  }
  return args
}

/**
 * spawn 会话子进程,stdin/stdout/stderr 全 pipe。
 * env 走 buildChildEnv() 白名单透传,只保留 runtime 必备 + LLM provider
 * 凭证 + 业务锚点,其它全部丢弃(最小权限)。
 */
export function spawnSessionHost(opts: SpawnRequest): SessionHostHandle {
  const args = buildCliArgs(opts)
  // win32 上 opencc 是 npm 装的 .cmd shim,原生 spawn 走 CreateProcess 会
  // ENOENT —— resolveSpawnCommand 统一包成 `cmd /c ...`(与 spawner 同款)。
  // 注意包装后 child 是 cmd.exe,杀进程须走 killChildTree 连树杀,见
  // SessionHost.kill()。
  const { command, args: spawnArgs } = resolveSpawnCommand('opencc', args)
  const child = spawn(command, spawnArgs, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildChildEnv(),
    windowsHide: true,
  })
  return { child }
}

export type { ChildProcess }