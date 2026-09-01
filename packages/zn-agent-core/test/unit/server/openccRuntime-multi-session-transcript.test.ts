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
 * Regression (sess-1788251606074-owtqwsla, 2026-09-01): 两个 zai 会话共用
 * 同一进程内的 shared OpenccRuntime(`repl` 默认模式)。串会话根因:
 * vendor `Project` 进程级单例只有一个 `sessionFile` 指针
 * (ensureCurrentSessionFile 只在 null 时赋值),CLI 时代靠
 * switchSession+resetSessionFilePointer 刷新;zai 多会话靠
 * runWithSdkContext ALS 切会话,这两个钩子都不会跑 —— 第一个会话
 * materialize 后,后续所有新会话的 user/assistant 条目全部 append 进
 * 第一个会话的 jsonl(entry 的 sessionId 戳仍按 ALS 正确盖成新会话),
 * 表现为"新会话的回复长在旧会话里"。
 *
 * 修复:Project.sessionFileSessionId 记录指针归属;写路径
 * (appendEntry / insertMessageChain / materialize 的 pendingEntries
 * 冲刷)遇到归属不匹配的指针按"未 materialize"处理,重新派生路径。
 */
describe('createOpenccRuntime — multi-session transcript isolation', { timeout: 60_000 }, () => {
  it('second session queries write to their own jsonl, not the first session file', async () => {
    // transcript 落到临时目录,不污染真实 ~/.zai(必须在 import 前设置,
    // getClaudeConfigHomeDir memoize key 含 CLAUDE_CONFIG_DIR)。
    const configDir = mkdtempSync(join(tmpdir(), 'opencc-multi-session-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    const { createOpenccRuntime } = await import('@zn-ai/zn-agent-core')

    // 绕过真实模型:按 prompt 序号产出可区分的 assistant 文本。
    let callCount = 0
    const stubQuery = async function* () {
      callCount += 1
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `stub-reply-${callCount}` }],
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
        uuid: `stub-uuid-${callCount}`,
      }
    }

    const r = await createOpenccRuntime({
      dataDir: configDir,
      defaultCwd: configDir,
      runtimeId: 'multi-session-transcript-regression',
      query: stubQuery as never,
    })

    const sidA = 'sess-multi-a'
    const sidB = 'sess-multi-b'
    for (const [sid, prompt] of [
      [sidA, 'message addressed to A'],
      [sidB, 'message addressed to B'],
    ] as const) {
      const s = r.query({ sessionId: sid, prompt, cwd: configDir })
      for await (const _ of s) {
        /* drain */
      }
    }

    // enqueueWrite 是异步队列,等待 drain 落盘后再读。
    await new Promise((resolve) => setTimeout(resolve, 800))

    const findFile = (needle: string): string => {
      const walk = (dir: string): string | null => {
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return null
        }
        for (const name of entries) {
          const p = join(dir, name)
          if (p.endsWith('.jsonl') && name.includes(needle)) return p
          const sub = walk(p)
          if (sub) return sub
        }
        return null
      }
      return walk(configDir) ?? ''
    }

    const fileA = findFile(sidA)
    const fileB = findFile(sidB)
    expect(fileA, `${sidA}.jsonl should be created`).toBeTruthy()
    expect(fileB, `${sidB}.jsonl should be created`).toBeTruthy()

    const userTextsIn = (file: string): string[] => {
      const raw = readFileSync(file, 'utf8')
      const texts: string[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const d = JSON.parse(line)
          if (d?.type === 'user' && typeof d.message?.content === 'string') {
            texts.push(d.message.content)
          }
        } catch {
          // skip malformed lines
        }
      }
      return texts
    }

    // 修复前:query B 的条目 append 进 fileA(userTextsIn(fileA) 含两条,
    // fileB 不存在或无消息)。修复后:各归各文件。
    expect(userTextsIn(fileA)).toEqual(['message addressed to A'])
    expect(userTextsIn(fileB)).toEqual(['message addressed to B'])

    await r.shutdown()
  })
})
