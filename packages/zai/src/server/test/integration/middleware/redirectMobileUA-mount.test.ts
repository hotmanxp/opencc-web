import { describe, test, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { redirectMobileUA } from '../../../middleware/redirectMobileUA.js'

// Mounts the middleware exactly like packages/zai/src/server/index.ts does:
//   app.use('/agent', redirectMobileUA)
// This proves the fix works against a real Express stack, not just mocks.
function buildApp() {
  const app = express()
  app.use('/agent', redirectMobileUA)
  // Stub SPA fallback so unmatched requests get a deterministic 200.
  app.use((_req, res) => {
    res.status(200).type('html').send('<html>desktop fallback</html>')
  })
  return app
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

describe('redirectMobileUA under real Express mount (/agent)', () => {
  test('iPhone UA GET /agent?sid=abc -> 302 Location /m?sid=abc', async () => {
    const res = await request(buildApp())
      .get('/agent?sid=abc')
      .set('User-Agent', IPHONE_UA)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/m?sid=abc')
  })

  test('Android UA GET /agent -> 302 Location /m', async () => {
    const res = await request(buildApp())
      .get('/agent')
      .set('User-Agent', ANDROID_UA)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/m')
  })

  test('Desktop UA GET /agent -> 200 (no redirect)', async () => {
    const res = await request(buildApp())
      .get('/agent')
      .set('User-Agent', DESKTOP_UA)
    expect(res.status).toBe(200)
  })

  test('iPhone UA GET /login -> 200 (middleware does not affect other paths)', async () => {
    const res = await request(buildApp())
      .get('/login')
      .set('User-Agent', IPHONE_UA)
    expect(res.status).toBe(200)
  })
})
