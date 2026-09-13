/**
 * sendFileToUser — vendor-shape 内置工具,把本地文件通过微信发送给用户
 * (zai patch 2026-09-13, weixin-bot)。
 *
 * 背景:微信通道没有 Web UI(无 DisplayFiles 卡片),文件类产出之前只能
 * "写盘 + 回路径"。本工具补齐交付闭环:agent 调 SendFileToUser 后,
 * zai 侧 WeixinAdapter 走 iLink CDN 加密上传(sendDocument/sendImageFile,
 * 移植自 hermes weixin.py)把文件真正推到用户微信。
 *
 * 架构:依赖倒置 —— zn-agent-core 不能反向 import zai(依赖方向 zai →
 * core),所以本模块只定义工具 + 发送器注册表;真正的发送实现由 zai 在
 * WeixinBotManager 启动时经 setWeixinFileSender() 注入(closure 动态读
 * adapter,通道断开时返回错误而不是崩溃)。
 *
 * 会话定位:call 内用 getSessionId()(bootstrap/state)拿到当前会话,
 * zai 侧 sender 用 WeixinSessionMap.lookupBySessionId 反查微信 chatId ——
 * 非微信绑定会话调用会得到明确的错误文案(不是抛异常,模型可自行降级
 * 为"写盘+回路径")。
 */
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import { getSessionId } from '../bootstrap/state.js'

/** 文件出站类别(与 WeixinAdapter._sendFile 的 kind 对齐)。 */
export type WeixinFileKind = 'file' | 'image' | 'video' | 'voice'

export interface WeixinFileSendRequest {
  sessionId: string
  /** 本地绝对路径,必须已存在且是文件。 */
  filePath: string
  /** 出站类别;省略时由扩展名自动推断。 */
  kind?: WeixinFileKind
}

export type WeixinFileSender = (
  req: WeixinFileSendRequest,
) => Promise<{ success: boolean; error?: string }>

let sender: WeixinFileSender | null = null

/**
 * zai 启动时注入发送实现(WeixinAdapter 的 sendDocument/sendImageFile/
 * sendVideo/sendVoice)。重复注入覆盖 —— 单实例语义,最后注册者生效。
 */
export function setWeixinFileSender(fn: WeixinFileSender | null): void {
  sender = fn
}

/** 测试 / 运维:读当前发送器(通常不需调用)。 */
export function getWeixinFileSender(): WeixinFileSender | null {
  return sender
}

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg',
])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'])
const VOICE_EXTS = new Set(['.mp3', '.wav', '.amr', '.aac', '.ogg', '.m4a', '.flac'])

/** 扩展名 → 出站类别;未知扩展一律按 file(微信端当文档下载)。 */
function classifyKind(filePath: string): WeixinFileKind {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (VOICE_EXTS.has(ext)) return 'voice'
  return 'file'
}

/** 微信文件出站上限(iLink CDN 无公开硬限,取保守值防误传超大文件)。 */
const MAX_FILE_BYTES = 100 * 1024 * 1024

const TOOL_DESCRIPTION =
  'Send a local file to the user through WeChat (images, videos, voice notes, or ' +
  'documents). Use this to deliver report files, generated images, exports, or any ' +
  'artifact directly in the chat instead of only mentioning a file path. The file ' +
  'must already exist on disk. The delivery kind (image/video/voice/document) is ' +
  'inferred from the file extension automatically. Not available outside WeChat ' +
  'sessions — on failure, fall back to writing the file and replying with its path.'

const inputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe('Absolute path of the local file to send.'),
})

export const sendFileToUserTool = buildTool({
  name: 'SendFileToUser',
  // 发送是出站副作用,不属于只读;但对本地文件系统无写操作。
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() {
    return TOOL_DESCRIPTION
  },
  async prompt() {
    return TOOL_DESCRIPTION
  },
  get inputSchema() {
    return inputSchema
  },
  maxResultSizeChars: 2_000,
  async call({ filePath }) {
    // 1. 本地预检:存在 + 是文件 + 大小合法(错误尽早暴露给模型)。
    let size = 0
    try {
      const s = await stat(filePath)
      if (s.isDirectory()) {
        return { data: { output: 'FAILED: path is a directory, not a file' } }
      }
      size = s.size
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      return {
        data: {
          output: `FAILED: cannot access file (${e.code ?? 'ERROR'}): ${filePath}`,
        },
      }
    }
    if (size > MAX_FILE_BYTES) {
      return {
        data: {
          output: `FAILED: file too large (${size} bytes > ${MAX_FILE_BYTES} limit)`,
        },
      }
    }

    // 2. 发送器未注入 = 当前部署没有微信通道能力。
    if (!sender) {
      return {
        data: {
          output:
            'FAILED: file sending is not available in this environment (no WeChat channel)',
        },
      }
    }

    // 3. 定位会话并发送;非微信会话由 sender 返回错误文案,模型可降级。
    const sessionId = getSessionId()
    const result = await sender({
      sessionId,
      filePath,
      kind: classifyKind(filePath),
    })
    return {
      data: {
        output: result.success
          ? `SENT: ${filePath} (${size} bytes)`
          : `FAILED: ${result.error ?? 'unknown error'}`,
      },
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  // 结果就是一行状态文本,无需转写,直接回灌。
  mapToolResultToToolResultBlockParam(content: { output?: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: content?.output ?? 'done',
    }
  },
  toAutoClassifierInput() {
    return ''
  },
  checkPermissions(input) {
    return Promise.resolve({
      behavior: 'allow' as const,
      updatedInput: input,
      decisionReason: {
        type: 'mode' as const,
        mode: 'bypassPermissions' as const,
      },
    })
  },
  userFacingName: () => 'SendFileToUser',
})
