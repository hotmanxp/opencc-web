// MiniMax /anthropic/v1/messages 限制: image 直接 base64 输入 ≤ 10MB
// 支持 JPEG / PNG / GIF / WEBP
// Source: https://platform.minimax.io/docs/api-reference/text-chat-anthropic (MediaSource)
const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export class ImageReadError extends Error {
  constructor(
    public reason: 'unsupported_mime' | 'too_large' | 'read_failed',
    message: string,
  ) {
    super(message)
    this.name = 'ImageReadError'
  }
}

export type ImageReadResult = {
  mime: string
  dataUrl: string
  size: number
  filename: string
}

export async function readImageAsBase64(
  file: File,
  signal?: AbortSignal,
): Promise<ImageReadResult> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new ImageReadError(
      'unsupported_mime',
      `不支持的图片格式: ${file.type || '未知'}`,
    )
  }
  if (file.size > MAX_BYTES) {
    throw new ImageReadError(
      'too_large',
      `图片超过 10MB 上限 (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
    )
  }
  if (signal?.aborted) {
    throw new ImageReadError('read_failed', '已取消')
  }
  return new Promise<ImageReadResult>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(new ImageReadError('read_failed', reader.error?.message ?? '读取失败'))
    reader.onabort = () => reject(new ImageReadError('read_failed', '已取消'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({
        mime: file.type,
        dataUrl,
        size: file.size,
        filename: file.name || 'image',
      })
    }
    if (signal) {
      signal.addEventListener(
        'abort',
        () => reader.abort(),
        { once: true },
      )
    }
    reader.readAsDataURL(file)
  })
}
