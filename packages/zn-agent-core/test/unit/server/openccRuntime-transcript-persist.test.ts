import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeAll(() => {
  // vendor 的 shouldSkipPersistence() 在 NODE_ENV=test 时默认跳过全部写盘,
  // 除非显式打开(见 sessionStorage.ts shouldSkipPersistence)。
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  }
})

/**
 * Regression: 同一 session 连续两次 query,第二条的 user 文本消息必须落盘。
 *
 * 根因(2026-08-09 会话错位 sess-1786250256612):createOpenccRuntime-impl
 * 用 `uuid: input.sessionId` 调用 QueryEngine.submitMessage,该 uuid 会直接
 * 成为本条 prompt 的 user 文本消息 uuid。recordTranscript 按 uuid 集合
 * (getSessionMessages) 去重 —— 第 1 轮写入 uuid=sessionId 后,第 2 轮起的
 * user 消息 uuid 重复,被 dedup 跳过,永不落盘。UI 刷新后只见 assistant
 * 回复不见用户消息,表现为"会话错位"。
 */
describe('createOpenccRuntime — per-turn user message transcript persistence', { timeout: 60_000 }, () => {
  it('two queries on the same session both persist their user text message', async () => {
    // 让 vendor 的 getClaudeConfigHomeDir 把 transcript 写到本测试的临时
    // 目录,避免污染真实 ~/.zai。必须在 import bundle 之前设置 env
    // (memoize key 包含 CLAUDE_CONFIG_DIR)。
    const configDir = mkdtempSync(join(tmpdir(), 'opencc-runtime-transcript-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    const { createOpenccRuntime } = await import('@zn-ai/zn-agent-core/opencc-server')

    // 绕过真实模型:stub query 直接产出一条 assistant 文本消息。QueryEngine
    // 会把 user prompt 落盘后进入 query loop,消费该消息并正常结束。
    const stubQuery = async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'stub-ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        session_id: 'stub',
        parent_tool_use_id: null,
        uuid: 'stub-uuid',
      }
    }

    const r = await createOpenccRuntime({
      dataDir: configDir,
      defaultCwd: configDir,
      runtimeId: 'transcript-persist-regression',
      query: stubQuery as never,
    })

    const sid = 'sess-transcript-persist-1'
    for (const prompt of ['first message', 'second message']) {
      const s = r.query({ sessionId: sid, prompt, cwd: configDir })
      for await (const _ of s) {
        /* drain */
      }
    }

    // enqueueWrite 是异步队列,等待 drain 落盘后再读。
    await new Promise((resolve) => setTimeout(resolve, 800))

    // 找到 vendor 写出的 <configDir>/projects/<sanitize(cwd)>/<sid>.jsonl
    const findFile = (): string => {
      const walk = (dir: string): string | null => {
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return null
        }
        for (const name of entries) {
          const p = join(dir, name)
          if (p.endsWith('.jsonl') && name.includes('sess-transcript-persist')) return p
          const sub = walk(p)
          if (sub) return sub
        }
        return null
      }
      return walk(configDir) ?? ''
    }
    const file = findFile()
    expect(file, 'transcript file should be created').toBeTruthy()

    const raw = readFileSync(file, 'utf8')
    const userTexts: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line)
        if (d?.type === 'user' && typeof d.message?.content === 'string') {
          userTexts.push(d.message.content)
        }
      } catch {
        // skip malformed lines
      }
    }

    // 修复前:第 2 条 user 消息 uuid 与第 1 条相同(都等于 sessionId),
    // 被 recordTranscript 去重 → 只有 ['first message']。
    // 修复后:每条 user 消息 uuid 唯一 → 两条都落盘。
    expect(userTexts).toEqual(['first message', 'second message'])

    await r.shutdown()
  })
})
