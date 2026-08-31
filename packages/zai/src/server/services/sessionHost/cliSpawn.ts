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
 * env 直接继承 zai server 进程(dev 时已注入 ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL),不显式 scrub ——
 * zai 是 localhost 自用服务,spawn 出去的子进程本就该看到同一环境。
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
    env: {
      ...process.env,
      // 压平 SIMPLE:即使宿主 shell 泄漏了 CLAUDE_CODE_SIMPLE 也不裁剪工具池。
      CLAUDE_CODE_SIMPLE: '0',
    },
    windowsHide: true,
  })
  return { child }
}

export type { ChildProcess }