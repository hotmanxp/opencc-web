/**
 * weixinPersona 测试 —— 单目录解析 / 空文件不注入 / 签名缓存 / 截断 / 渲染。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  loadPersonaSnapshot,
  resetWeixinPersonaForTests,
  resolvePersonaDirPath,
  zaiWeixinPersonaDir,
  renderPersonaBlock,
  PERSONA_FILE_MAX_BYTES,
  PERSONA_TOTAL_MAX_BYTES,
} from '../../../src/server/services/weixinBot/weixinPersona.js'

let dataDir: string

const zaiDir = (): string => join(dataDir, 'weixin', 'persona')

function seed(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-wx-persona-'))
  process.env.ZAI_DATA_DIR = dataDir
  delete process.env.ZAI_WEIXIN_PERSONA_DIR
  resetWeixinPersonaForTests()
})

describe('weixinPersona', () => {
  it('目录落点唯一:<ZAI_DATA_DIR>/weixin/persona', () => {
    expect(zaiWeixinPersonaDir()).toBe(zaiDir())
    expect(resolvePersonaDirPath()).toBe(zaiDir())
  })

  it('ZAI_WEIXIN_PERSONA_DIR 整体覆盖目录(绝对 / 相对路径)', async () => {
    const custom = seed(join(dataDir, 'custom'), { 'SOUL.md': 'custom soul' })
    process.env.ZAI_WEIXIN_PERSONA_DIR = custom
    expect(resolvePersonaDirPath()).toBe(custom)

    process.env.ZAI_WEIXIN_PERSONA_DIR = 'relative-dir'
    expect(resolvePersonaDirPath()).toBe(resolve(process.cwd(), 'relative-dir'))

    // 覆盖成不存在的路径 → 无人格,不回退
    process.env.ZAI_WEIXIN_PERSONA_DIR = join(dataDir, 'does-not-exist')
    resetWeixinPersonaForTests()
    await expect(loadPersonaSnapshot()).resolves.toBeNull()
  })

  it('目录不存在 / 为空 / 只有空白文件 → null(不注入)', async () => {
    // 目录不存在
    expect(await loadPersonaSnapshot()).toBeNull()

    // 目录存在但为空
    mkdirSync(zaiDir(), { recursive: true })
    expect(await loadPersonaSnapshot()).toBeNull()

    // 只有一个空白 SOUL.md —— 仍按无人格处理
    writeFileSync(join(zaiDir(), 'SOUL.md'), '   \n\n')
    resetWeixinPersonaForTests()
    expect(await loadPersonaSnapshot()).toBeNull()
  })

  it('不再回退到 ~/.workbuddy:只认人格目录', async () => {
    // 本机真实存在 ~/.workbuddy/SOUL.md,但它已不是候选目录 ——
    // 人格目录(本次用例的临时 dataDir 下)为空时必须返回 null。
    expect(zaiDir().includes('.workbuddy')).toBe(false)
    expect(await loadPersonaSnapshot()).toBeNull()
  })

  it('按 PERSONA_FILES 顺序读多文件,空白文件被跳过', async () => {
    seed(zaiDir(), {
      'USER.md': '超哥,程序员,深圳。',
      'SOUL.md': '干脆利落,话少活多。',
      'IDENTITY.md': '   ',
    })

    const snap = await loadPersonaSnapshot()
    expect(snap?.dir).toBe(zaiDir())
    expect(snap?.files.map((f) => f.name)).toEqual(['SOUL.md', 'USER.md'])
    expect(snap?.files[0]?.bytes).toBe(Buffer.byteLength('干脆利落,话少活多。', 'utf-8'))
    expect(snap?.files.every((f) => !f.truncated)).toBe(true)
  })

  it('签名缓存:文件没改复用同一快照,改了立即重读', async () => {
    seed(zaiDir(), { 'SOUL.md': 'v1' })
    const first = await loadPersonaSnapshot()
    const second = await loadPersonaSnapshot()
    expect(second).toBe(first)

    writeFileSync(join(zaiDir(), 'SOUL.md'), 'v2 — 改了语气,更简洁')
    const third = await loadPersonaSnapshot()
    expect(third).not.toBe(first)
    expect(third?.files[0]?.content).toBe('v2 — 改了语气,更简洁')
  })

  it('超限截断:单文件超上限 → truncated + 提示,原始长度如实记录', async () => {
    const body = 'x'.repeat(PERSONA_FILE_MAX_BYTES + 500)
    seed(zaiDir(), { 'SOUL.md': body })

    const file = (await loadPersonaSnapshot())?.files[0]
    expect(file?.truncated).toBe(true)
    expect(file?.bytes).toBe(PERSONA_FILE_MAX_BYTES + 500)
    expect(file?.content.startsWith('x'.repeat(64))).toBe(true)
    expect(file?.content).toContain('truncated at')
  })

  it('renderPersonaBlock 输出 identity-context 块,含路径与正文', async () => {
    seed(zaiDir(), { 'SOUL.md': '干脆利落。', 'USER.md': '超哥,程序员。' })
    const snap = await loadPersonaSnapshot()
    expect(snap).not.toBeNull()
    const block = renderPersonaBlock(snap as NonNullable<typeof snap>)

    expect(block.startsWith('<identity-context>')).toBe(true)
    expect(block.endsWith('</identity-context>')).toBe(true)
    expect(block).toContain('## SOUL.md')
    expect(block).toContain(`Path: ${join(zaiDir(), 'SOUL.md')}`)
    expect(block).toContain('干脆利落。')
    expect(block).toContain('## USER.md')
    expect(block).toContain('超哥,程序员。')
    // 文件顺序 = PERSONA_FILES 顺序
    expect(block.indexOf('## SOUL.md')).toBeLessThan(block.indexOf('## USER.md'))
  })

  // 只给路径不给规则时,模型不会主动维护人格文件,也不知道边界 —— 这里把维护
  // 指引的要点钉住,避免以后被人顺手删掉却没人发现。
  it('renderPersonaBlock 附带维护指引(可改哪些 / 何时改 / 上限 / 生效时机)', async () => {
    seed(zaiDir(), { 'SOUL.md': '干脆利落。' })
    const snap = await loadPersonaSnapshot()
    const block = renderPersonaBlock(snap as NonNullable<typeof snap>)

    expect(block).toContain('Maintaining these files:')
    // 三个可维护文件都被点名,且明确"别新建别的"
    expect(block).toContain('SOUL.md / IDENTITY.md / USER.md')
    expect(block).toContain('Do not create other persona files')
    // 触发条件:用户明确要求时才改,含糊先问
    expect(block).toContain('ask one short question first')
    // 上限与常量同源,改常量不会让文案漂移
    expect(block).toContain(`${Math.floor(PERSONA_FILE_MAX_BYTES / 1024)}KB per file`)
    expect(block).toContain(`${Math.floor(PERSONA_TOTAL_MAX_BYTES / 1024)}KB in total`)
    // 生效时机:下一条消息,不需要重启
    expect(block).toContain('no restart is needed')
    // 维护动作走通用工具,且要求告知用户
    expect(block).toContain('Write/Edit tools')
    // USER.md 与长期记忆文件的分工要写清楚,否则模型会两边乱写
    expect(block).toContain('long-term memory file instead')
  })
})
