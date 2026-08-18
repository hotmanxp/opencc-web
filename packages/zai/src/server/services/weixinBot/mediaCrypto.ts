/**
 * iLink 媒体加密 + CDN URL 守卫。
 *
 * 加密:iLink 媒体走 AES-128-ECB + PKCS#7,Node `crypto` 原生支持,无需引入
 * crypto-js。密钥 16 字节,iLink 有时给 base64,有时给 hex 文本(双重 base64),
 * parseKey 兼容两种格式。
 *
 * CDN URL:iLink 媒体走 novac2c.cdn.weixin.qq.com 等 7 个 host,任何 outbound
 * 都必须命中白名单,防止用户输入诱导 SSRF(internal AWS / 169.254.169.254)。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AES_KEY_LENGTH } from './constants.js'

export const WEIXIN_CDN_ALLOWLIST: ReadonlySet<string> = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
])

/**
 * 解析 iLink 入站 aes_key 字段。两种接受格式:
 *   - 16 字节原始 → 直接 base64 后传过来
 *   - 32 字节 hex 字符串(实际是 16 字节 hex 文本) → 双重 base64 包裹
 */
export function parseKey(raw: string): Buffer {
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === AES_KEY_LENGTH) return decoded
  if (decoded.length === AES_KEY_LENGTH * 2) {
    const asText = decoded.toString('ascii')
    if (/^[0-9a-fA-F]+$/.test(asText) && asText.length === AES_KEY_LENGTH * 2) {
      return Buffer.from(asText, 'hex')
    }
  }
  throw new Error(
    `weixin-media: aes_key must decode to ${AES_KEY_LENGTH} raw bytes or ${AES_KEY_LENGTH * 2} hex chars (got ${decoded.length})`,
  )
}

/** 出站时生成 16 字节随机 AES-128 key,字符串形式(base64 原始) */
export function generateKey(): string {
  return randomBytes(AES_KEY_LENGTH).toString('base64')
}

/** AES-128-ECB + PKCS#7 加密 */
export function encryptAes128Ecb(plaintext: Buffer, keyB64: string): Buffer {
  const key = parseKey(keyB64)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** AES-128-ECB + PKCS#7 解密 */
export function decryptAes128Ecb(ciphertext: Buffer, keyB64: string): Buffer {
  const key = parseKey(keyB64)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** CDN URL 守卫 —— 命中白名单 host + http(s) scheme,否则 throw */
export function assertSafeCdnUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch (err) {
    throw new Error(`weixin-media: unparseable URL: ${url} (${(err as Error).message})`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`weixin-media: scheme ${u.protocol} not allowed (only http/https)`)
  }
  const host = u.hostname.toLowerCase()
  if (!WEIXIN_CDN_ALLOWLIST.has(host)) {
    throw new Error(
      `weixin-media: host ${host} not in allowlist (refusing to fetch to prevent SSRF)`,
    )
  }
}

/** 给定 type(int 2/3/4/5) → 标准 MIME 类型,默认 application/octet-stream */
export function mimeForMediaType(type: number, filename?: string): string {
  switch (type) {
    case 2: return 'image/jpeg'
    case 3: return 'audio/silk'
    case 4: return filename ? guessMimeFromExt(filename) : 'application/octet-stream'
    case 5: return 'video/mp4'
    default: return 'application/octet-stream'
  }
}

function guessMimeFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return 'application/octet-stream'
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
    silk: 'audio/silk', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg',
    wav: 'audio/wav', m4a: 'audio/mp4',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}
