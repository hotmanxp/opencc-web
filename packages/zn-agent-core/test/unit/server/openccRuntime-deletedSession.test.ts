/**
 * 已删会话的守卫 —— 走 vendor **turn 主链路**（M4 /
 * `delete-session-resurrects--by-zai`）。
 *
 * 为什么单独一条:compat 侧 `legacyTranscriptStore.appendEntry` 只是旁路
 * （slash 可见行 / session-meta）。真正把 turn 内容写进 transcript 的是
 * `sessionStorage.appendEntry → appendDirectlyToFile`,而后者是
 * `mkdir(dirname) + appendFile` —— 文件没了会**重新创建**。
 *
 * `sessionStorage` 模块图在 vitest 下无法直接 import（会拉进
 * `mcp/client.js` 的 require），所以这里从主入口 `createOpenccRuntime` 驱动
 * 真实 turn，落盘路径与生产完全一致。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOpenccRuntime, createSessionFacade } from '@zn-ai/zn-agent-core'

beforeAll(() => {
  // vendor 的 shouldSkipPersistence() 在 NODE_ENV=test 下默认跳过全部写盘。
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
})

const stubQuery = async function* () {
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'stub-ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    session_id: 'stub',
    parent_tool_use_id: null,
    uuid: 'stub-uuid',
  }
}

function findTranscript(root: string, sid: string): string | null {
  const walk = (dir: string): string | null => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isFile() && e.name === `${sid}.jsonl`) return p
      if (e.isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root)
}

describe('createOpenccRuntime — 已删会话不再被 turn 写回', { timeout: 60_000 }, () => {
  it('removeSession 之后再跑一个 turn,transcript 不会被重建', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'deleted-session-turn-'))
    // vendor 的 transcript 根目录走 getClaudeConfigHomeDir()(memoize,key 含
    // CLAUDE_CONFIG_DIR),不是 runtime 的 dataDir —— 必须在 import bundle 之前设。
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const r = await createOpenccRuntime({
        dataDir: configDir,
        defaultCwd: configDir,
        runtimeId: 'deleted-session-guard',
        query: stubQuery as never,
      })
      const sid = 'sess-deleted-turn-1'

      // 第 1 轮:正常落盘
      for await (const _ of r.query({ sessionId: sid, prompt: 'before delete', cwd: configDir })) { /* drain */ }
      await new Promise((res) => setTimeout(res, 800))
      const file = findTranscript(configDir, sid)
      expect(file, 'transcript should exist before delete').toBeTruthy()

      // 删除 —— facade 的 removeSession 会 arm 守卫
      const facade = await createSessionFacade({ dataDir: configDir, cwd: configDir })
      await facade.removeSession(sid)
      expect(existsSync(file!)).toBe(false)

      // 第 2 轮:模拟「被删会话的 turn 迟到地继续跑」
      for await (const _ of r.query({ sessionId: sid, prompt: 'late write after delete', cwd: configDir })) { /* drain */ }
      await new Promise((res) => setTimeout(res, 800))

      // 关键断言:文件没有被 mkdir + append 重建
      expect(existsSync(file!), 'deleted transcript must not be resurrected').toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
