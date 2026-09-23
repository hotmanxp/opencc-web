/**
 * weixinPersona — 微信通道的「助手人格设定」加载与注入。
 *
 * 背景(用户要求 2026-09-23):把 SOUL.md / IDENTITY.md / USER.md 那套人格设定
 * 逻辑搬进 zai,**只作用于微信通道**。
 *
 * 为什么注入点选在这里就等于"只针对微信实例":渲染函数 `renderWeixinPrompt`
 * 只被 `weixinInboundBridge` 调用,而该 bridge 只在 `app=weixin` 的专用实例上
 * 收到入站消息(见 channelProfile.ts / weixinRuntimeBoot.ts)。Web 端会话完全
 * 不经这条路径 —— 主实例的 agent 人格与系统提示词不受任何影响。
 *
 * 人格目录(唯一落点):
 *   `<ZAI_DATA_DIR>/weixin/persona/`,即默认的 `~/.zai/weixin/persona/`,
 *   与同级的 sessions.json / memory/ / accounts/ 平级 —— 人格**只属于微信**。
 *   `ZAI_WEIXIN_PERSONA_DIR` 可整体覆盖该目录(绝对/相对路径均可),
 *   用于临时试验或把人格放在别处;它没有回退语义,指错就是无人格。
 *
 *   历史上曾回退到 WorkBuddy 的 `~/.workbuddy/`,2026-09-23 按用户要求移除 ——
 *   跨应用隐式读文件会让"我改了 SOUL.md 怎么没生效"这类问题极难定位。
 *   需要那份内容就显式复制进来,别让运行时替你猜。
 *
 * 缓存策略刻意**不**沿用 weixinMemory 的"冻结到会话轮转":
 * 人格文件是给人手改的,冻结到轮转才生效会让"改完没反应"变成高频困惑;
 * 而每条消息都重读文件又白白多 syscall。这里用 **mtime+size+ino 签名** 折中
 * —— 签名没变直接复用上一条已构造好的字符串(逐字节稳定,不扰动 prompt cache),
 * 签名变了立即重读,所以"保存 SOUL.md → 下一条微信消息生效",无需重启实例。
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { weixinDataDir } from '../paths.js'

/**
 * 识别的人格文件清单 —— 顺序即注入顺序:
 * SOUL = 人格与语气,IDENTITY = 助手自己的身份记录,USER = 对话方的画像。
 * 三个都可选,缺失即不注入该段。
 */
export const PERSONA_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const
export type PersonaFileName = (typeof PERSONA_FILES)[number]

/** 单个人格文件的注入上限(超出截断并附提示)。 */
export const PERSONA_FILE_MAX_BYTES = 8 * 1024
/** 全部人格文件合计上限。 */
export const PERSONA_TOTAL_MAX_BYTES = 20 * 1024

/** 目录覆盖用的环境变量。 */
export const PERSONA_DIR_ENV = 'ZAI_WEIXIN_PERSONA_DIR'

export interface PersonaFileEntry {
  name: PersonaFileName
  path: string
  content: string
  /** 原始字节数(截断前)。 */
  bytes: number
  truncated: boolean
}

export interface WeixinPersonaSnapshot {
  /** 生效的人格目录(绝对路径)。 */
  dir: string
  /** 实际读到内容的文件,按 PERSONA_FILES 顺序。恒非空(空则不产生快照)。 */
  files: PersonaFileEntry[]
}

// ─── 目录解析 ────────────────────────────────────────────────────────

/** zai 的微信人格目录(`<ZAI_DATA_DIR>/weixin/persona`) —— 每次重读 env。 */
export function zaiWeixinPersonaDir(): string {
  return join(weixinDataDir(), 'persona')
}

/**
 * 生效的人格目录绝对路径。`ZAI_WEIXIN_PERSONA_DIR` 非空时以它为准
 * (相对路径按进程 cwd 解析),否则是 `zaiWeixinPersonaDir()`。
 *
 * 纯路径计算 —— 不判断目录是否存在。权威判定看 `loadPersonaSnapshot()`。
 * 导出供面板 / 诊断展示"现在会读哪里"。
 */
export function resolvePersonaDirPath(): string {
  const override = (process.env[PERSONA_DIR_ENV] ?? '').trim()
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override)
  return zaiWeixinPersonaDir()
}

// ─── 快照加载(签名缓存) ──────────────────────────────────────────────

/**
 * 文件签名:任一文件的 mtime / 大小 / inode 变化,或文件增删,都会改变它。
 * 三个都带上是因为编辑器"原子保存"(写 tmp + rename)会换 inode,只比 mtime
 * 在某些文件系统上会漏检。
 */
async function signatureOf(dir: string): Promise<string> {
  const parts: string[] = [dir]
  for (const name of PERSONA_FILES) {
    try {
      const st = await stat(join(dir, name))
      parts.push(`${name}:${st.mtimeMs}:${st.size}:${st.ino}`)
    } catch {
      parts.push(`${name}:-`)
    }
  }
  return parts.join('|')
}

interface CacheEntry {
  signature: string
  snapshot: WeixinPersonaSnapshot
}

let cache: CacheEntry | null = null

const TRUNCATE_NOTICE = (max: number): string =>
  `\n[Note: persona file truncated at ${max} bytes. Keep persona files concise.]`

/**
 * 读取(或复用缓存的)人格快照。
 *
 * 目录不存在、或里面没读到任何非空人格文件 → 返回 null(不注入人格块,
 * 微信通道退回无人格的默认行为)。
 *
 * 判据是"读出了内容"而不是"文件存在":留一个空 SOUL.md 时按无人格处理,
 * 比注入一个空的 `<identity-context>` 更诚实(空块会让模型以为人格被清了)。
 *
 * 永不抛:人格是增强,不是消息投递的关键路径。
 */
export async function loadPersonaSnapshot(): Promise<WeixinPersonaSnapshot | null> {
  try {
    const dir = resolvePersonaDirPath()
    const signature = await signatureOf(dir)
    // 签名命中 = 这个目录上一轮产出过有效快照,直接复用同一对象引用。
    // 内容逐字节稳定,不扰动 prompt cache;也比重新构造字符串便宜。
    if (cache && cache.signature === signature) return cache.snapshot

    const files: PersonaFileEntry[] = []
    let budget = PERSONA_TOTAL_MAX_BYTES
    for (const name of PERSONA_FILES) {
      const path = join(dir, name)
      let raw: string
      try {
        raw = await readFile(path, 'utf-8')
      } catch {
        continue
      }
      if (!raw.trim()) continue
      const bytes = Buffer.byteLength(raw, 'utf-8')
      const perFileCap = Math.min(PERSONA_FILE_MAX_BYTES, budget)
      if (bytes > perFileCap) {
        // 按字节预算截断 —— 用 Buffer 切,避免把一个多字节字符劈成两半。
        const cut = Buffer.from(raw, 'utf-8').subarray(0, perFileCap).toString('utf-8')
        files.push({ name, path, content: cut + TRUNCATE_NOTICE(perFileCap), bytes, truncated: true })
        budget -= perFileCap
      } else {
        files.push({ name, path, content: raw, bytes, truncated: false })
        budget -= bytes
      }
      if (budget <= 0) break
    }
    if (files.length === 0) {
      cache = null
      return null
    }
    const snapshot: WeixinPersonaSnapshot = { dir, files }
    cache = { signature, snapshot }
    return snapshot
  } catch {
    return null
  }
}

/** 测试 / 运维:清空签名缓存(下次调用强制重读)。 */
export function resetWeixinPersonaForTests(): void {
  cache = null
}

// ─── 渲染 ────────────────────────────────────────────────────────────

/**
 * 渲染注入 LLM 的 `<identity-context>` 块。
 *
 * 块内文字是**发给模型的指令**,按仓库硬约束一律英文;文件正文是用户自己的
 * 内容,原样透传(不翻译、不改写)。
 */
export function renderPersonaBlock(persona: WeixinPersonaSnapshot): string {
  const lines: string[] = []
  lines.push('<identity-context>')
  lines.push(
    'The identity files below are injected by the runtime and define who you are in this conversation. ' +
      'They are not written by the user in this message.',
  )
  lines.push(
    'Embody the persona and tone described in SOUL.md. Treat IDENTITY.md as the record of yourself ' +
      'and USER.md as the profile of the person you are talking to.',
  )
  lines.push(
    'Stay consistent with them across every message of this conversation. Do not quote them, ' +
      'recite them, or mention that they were injected.',
  )
  // 维护指引(2026-09-23):对齐 <weixin-memory> 里那段「记忆维护」。只给路径不给
  // 规则时,模型有能力改却几乎不会主动改,也不知道边界(哪些文件能动、改前是否
  // 要确认、写多长会被截断、何时生效)。逐条写死,避免它自己发明规则。
  lines.push('')
  lines.push('Maintaining these files:')
  lines.push(
    `- Only the files listed below (${PERSONA_FILES.join(' / ')}) are yours to maintain. Do not ` +
      'create other persona files, and do not park notes, todos or memories in them.',
  )
  lines.push(
    '- Change them only when the user explicitly asks you to adjust your personality, tone, or the ' +
      'way you address them, or explicitly asks you to record how they want to be treated. If the ' +
      'intent is ambiguous, ask one short question first; otherwise just comply for this reply and ' +
      'leave the files untouched.',
  )
  lines.push(
    '- USER.md is the profile of the person you talk to — keep it to persona-relevant context such ' +
      'as how to address them and their communication preferences. Facts the user asks you to ' +
      'remember go to the long-term memory file instead; do not duplicate that job here.',
  )
  lines.push(
    `- Keep each file short: ${Math.floor(PERSONA_FILE_MAX_BYTES / 1024)}KB per file, ` +
      `${Math.floor(PERSONA_TOTAL_MAX_BYTES / 1024)}KB in total. Anything past that is truncated ` +
      'silently and you lose its tail.',
  )
  lines.push(
    '- Write with the Write/Edit tools, then tell the user in one sentence what you changed — these ' +
      'files are on the host and invisible from this chat.',
  )
  lines.push(
    '- Edits take effect on your next incoming message; no restart is needed. Never tell the user ' +
      'a restart is required.',
  )
  lines.push('')
  lines.push('This block is rebuilt from disk on every message, so what you read here is current.')
  for (const file of persona.files) {
    lines.push('')
    lines.push(`## ${file.name}`)
    lines.push(`Path: ${file.path}`)
    lines.push('---')
    lines.push(file.content.trim())
  }
  lines.push('</identity-context>')
  return lines.join('\n')
}
