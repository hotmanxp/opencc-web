import { describe, it, expect } from 'vitest'
import {
  parseKey,
  generateKey,
  encryptAes128Ecb,
  decryptAes128Ecb,
  assertSafeCdnUrl,
  WEIXIN_CDN_ALLOWLIST,
  mimeForMediaType,
} from '../../../src/server/services/weixinBot/mediaCrypto.js'
import { randomBytes } from 'node:crypto'

describe('MediaCrypto', () => {
  it('parseKey accepts 16-byte raw (base64-encoded)', () => {
    const raw = randomBytes(16).toString('base64')
    const buf = parseKey(raw)
    expect(buf.length).toBe(16)
  })

  it('parseKey accepts 32-char hex wrapped in base64', () => {
    const hex = randomBytes(16).toString('hex')
    const wrapped = Buffer.from(hex, 'ascii').toString('base64')
    const buf = parseKey(wrapped)
    expect(buf.length).toBe(16)
    expect(buf.toString('hex')).toBe(hex)
  })

  it('parseKey rejects bad key size', () => {
    expect(() => parseKey(Buffer.from('hello').toString('base64'))).toThrow(/aes_key/)
  })

  it('encryptAes128Ecb + decryptAes128Ecb round-trip', () => {
    const key = generateKey()
    const plaintext = Buffer.from('微信消息中包含的中文 / English / 123 emoji 🙃', 'utf-8')
    const ciphertext = encryptAes128Ecb(plaintext, key)
    expect(ciphertext.length % 16).toBe(0)
    const recovered = decryptAes128Ecb(ciphertext, key)
    expect(recovered.toString('utf-8')).toBe(plaintext.toString('utf-8'))
  })

  it('encryptAes128Ecb is deterministic with same key', () => {
    const key = generateKey()
    const a = encryptAes128Ecb(Buffer.from('msg'), key)
    const b = encryptAes128Ecb(Buffer.from('msg'), key)
    expect(a.equals(b)).toBe(true)
  })

  it('assertSafeCdnUrl allows WeChat CDN hosts', () => {
    for (const host of WEIXIN_CDN_ALLOWLIST) {
      expect(() => assertSafeCdnUrl(`https://${host}/foo?bar=1`)).not.toThrow()
    }
  })

  it('assertSafeCdnUrl rejects unknown host', () => {
    expect(() => assertSafeCdnUrl('https://evil.example.com/payload')).toThrow(/not in allowlist/)
  })

  it('assertSafeCdnUrl rejects non-http schemes', () => {
    expect(() => assertSafeCdnUrl('file:///etc/passwd')).toThrow(/scheme/)
    expect(() => assertSafeCdnUrl('javascript:alert(1)')).toThrow(/scheme/)
  })

  it('mimeForMediaType maps iLink item type to standard mime', () => {
    expect(mimeForMediaType(2)).toBe('image/jpeg')
    expect(mimeForMediaType(3)).toBe('audio/silk')
    expect(mimeForMediaType(5)).toBe('video/mp4')
    expect(mimeForMediaType(4, 'photo.png')).toBe('image/png')
    expect(mimeForMediaType(4)).toBe('application/octet-stream')
  })
})
