/**
 * weixinMemory 测试 —— 轮转摘要落盘 + 冻结快照 + 长期记忆截断。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sanitizePath } from '@zn-ai/zn-agent-core'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMemorySnapshot,
  invalidateMemorySnapshot,
  recordRotationSummary,
  weixinLongTermMemoryPath,
  weixinRotationsDir,
  weixinMemoryDirFor,
  LONG_TERM_MEMORY_MAX_BYTES,
  resetWeixinMemoryForTests,
} from '../../../src/server/services/weixinBot/weixinMemory.js'

describe('weixinMemory', () => {
  let dataDir: string
  let cwd: string
  const KEY = 'acct:dm:user_a'

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-wx-mem-'))
    cwd = mkdtempSync(join(tmpdir(), 'zai-wx-mem-proj-'))
    process.env.ZAI_DATA_DIR = dataDir
    resetWeixinMemoryForTests()
  })

  /**
   * 落一份与**真实写方**布局一致的 transcript:
   *   `${dataDir}/projects/${sanitizePath(cwd)}/${sid}.jsonl`
   * 目录名用 core 导出的 `sanitizePath`(threshold 200 + djb2 减法哈希),
   * 不能在测试里自己拼 —— 拼错就复现「读方读空」而不是验证读方(见
   * docs/bugs/fix-plan-10-05.md H4)。混一条 session-meta 行验证非消息条目
   * 被 extractReadable 过滤掉。
   */
  function seedTranscript(sessionId: string): void {
    const projDir = join(dataDir, 'projects', sanitizePath(cwd))
    mkdirSync(projDir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session-meta', sessionId, cwd }),
      JSON.stringify({ role: 'user', content: '帮我把项目构建脚本改成 pnpm' }),
      JSON.stringify({ role: 'assistant', content: '已把 build 脚本改成 pnpm build,并验证通过。' }),
      JSON.stringify({ role: 'user', content: '记住:这个项目以后都用 pnpm' }),
      JSON.stringify({ role: 'assistant', content: '好的,已记住。' }),
      JSON.stringify({ role: 'user', content: '下一步:把 CI 也切到 pnpm,还没做' }),
    ]
    writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  }

  it('recordRotationSummary(skipLlm) 读取 transcript → 落盘 rotations → 快照可见', async () => {
    const oldSid = 'sess-11111111-1111-1111-1111-111111111111'
    seedTranscript(oldSid)
    const summary = await recordRotationSummary({
      conversationKey: KEY,
      oldSessionId: oldSid,
      cwd,
      dataDir,
      skipLlm: true,
    })
    expect(summary).toContain('pnpm')
    expect(summary).toContain('CI')
    const rdir = weixinRotationsDir(KEY)
    expect(existsSync(rdir)).toBe(true)
    const files = readdirSync(rdir)
    expect(files.length).toBe(1)
    expect(files[0].endsWith('.md')).toBe(true)

    const snap = await loadMemorySnapshot(KEY)
    expect(snap.lastRotationSummary).toContain('pnpm')
    expect(snap.memoryPath).toBe(weixinLongTermMemoryPath(KEY))
  })

  it('冻结快照:会话内读到的内容不变,失效后重读', async () => {
    const memPath = weixinLongTermMemoryPath(KEY)
    mkdirSync(weixinMemoryDirFor(KEY), { recursive: true })
    writeFileSync(memPath, '用户偏好:用 pnpm')
    const s1 = await loadMemorySnapshot(KEY)
    expect(s1.longTerm).toBe('用户偏好:用 pnpm')
    // agent 写盘 → 快照不变(冻结)
    writeFileSync(memPath, '用户偏好:用 pnpm\n项目约定:上海时区')
    const s2 = await loadMemorySnapshot(KEY)
    expect(s2.longTerm).toBe('用户偏好:用 pnpm')
    // 轮转失效 → 重读新内容
    invalidateMemorySnapshot(KEY)
    const s3 = await loadMemorySnapshot(KEY)
    expect(s3.longTerm).toContain('上海时区')
  })

  it('长期记忆超限截断并附提示', async () => {
    const memPath = weixinLongTermMemoryPath(KEY)
    mkdirSync(weixinMemoryDirFor(KEY), { recursive: true })
    writeFileSync(memPath, 'x'.repeat(LONG_TERM_MEMORY_MAX_BYTES + 100))
    const snap = await loadMemorySnapshot(KEY)
    expect(snap.longTerm.length).toBeGreaterThan(LONG_TERM_MEMORY_MAX_BYTES)
    expect(snap.longTerm).toContain('已截断')
  })

  it('无 transcript / 无记忆文件 → 快照为空但不抛', async () => {
    const summary = await recordRotationSummary({
      conversationKey: KEY,
      oldSessionId: 'sess-missing',
      cwd,
      dataDir,
      skipLlm: true,
    })
    expect(summary).toBe('')
    const snap = await loadMemorySnapshot(KEY)
    expect(snap.longTerm).toBe('')
    expect(snap.lastRotationSummary).toBe('')
  })
})
