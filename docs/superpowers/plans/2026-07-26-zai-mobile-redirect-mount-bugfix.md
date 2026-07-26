# zai Mobile Redirect Mount-Semantics Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `redirectMobileUA` Express middleware so that iPhone/Android UA requests to `/agent?sid=xxx` are actually redirected (302) to `/m?sid=xxx` instead of silently falling through to the SPA fallback.

**Architecture:** Express `app.use('/agent', mw)` mounts the middleware under `/agent` and **strips** that prefix from `req.path` / `req.url` inside the middleware. The current guard `req.path !== '/agent'` is therefore always true and the middleware always `next()`s. Fix: use `req.baseUrl + req.path` for the path check and `req.originalUrl` to extract the querystring. Add a real Express integration test (supertest) that reproduces the mount scenario so this cannot regress.

**Tech Stack:** Node 22+, TypeScript 5.x, Express 5.x, vitest 4.x, supertest 7.x.

**Spec:** `docs/superpowers/specs/2026-07-26-zai-mobile-redirect-mount-bugfix.md`

## Global Constraints

- Path scope is fixed: only `/agent` → `/m`; everything else (`/login`, `/dashboard`, `/api/*`, `/m`, etc.) must `next()`.
- UA regex is unchanged: `/Mobile|Android|iPhone|iPad|iPod|Safari/` — must remain backward-compatible with all 6 existing UA cases in `matchesMobileUA`.
- Existing tests in `redirectMobileUA.test.ts` (6 cases) must keep passing unchanged (they assert the same observable behavior via direct mock).
- No new runtime dependencies (supertest is already in `package.json`).
- Do NOT modify `packages/zai/src/server/index.ts` — the `app.use('/agent', redirectMobileUA)` mount stays.
- Frontend files (`router.tsx`, `MobileAgent.tsx`, etc.) are untouched — the bug is purely server-side.
- Preserve spec §3.3: `/m` must not redirect (loop guard).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/zai/src/server/middleware/redirectMobileUA.ts` | modify | The middleware itself: fix `req.path` → `req.baseUrl + req.path`, fix `req.url` → `req.originalUrl` for querystring. Add comment explaining Express mount semantics. |
| `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` | modify (add cases) | Add 2 mount-semantics cases under `describe('redirectMobileUA')` covering `baseUrl='/agent'` + `originalUrl` and a non-`/agent` mount. |
| `packages/zai/src/server/test/integration/middleware/redirectMobileUA-mount.test.ts` | create | Real-Express integration test via supertest. Mounts the middleware under `app.use('/agent', redirectMobileUA)` exactly like `index.ts:144` and asserts end-to-end 302 vs 200. |

---

## Task 1: Add failing mount-semantics tests to existing unit suite

**Files:**
- Modify: `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` (append 2 tests inside the existing `describe('redirectMobileUA')` block)
- Read for context: `packages/zai/src/server/middleware/redirectMobileUA.ts` (current implementation)

**Interfaces:**
- Consumes: `redirectMobileUA(req, res, next)` from `redirectMobileUA.ts`; helper `mkReq(path, ua)` and `mkRes()` already defined in the same file.
- Produces: 2 new test cases that fail against the current implementation but pass after Task 2.

- [ ] **Step 1: Write the 2 failing mount-semantics tests**

Open `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` and add the following 2 cases **immediately after** the existing `'does NOT redirect /agent when UA is undefined'` test (before the closing `})` of `describe('redirectMobileUA')`):

```ts
  test('redirects /agent under mounted baseUrl (real Express scenario)', () => {
    // Simulates Express app.use('/agent', redirectMobileUA): baseUrl='/agent',
    // req.path='/'(stripped), req.url='/' (stripped), req.originalUrl is full path.
    const req = mkReq('/', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    ;(req as any).baseUrl = '/agent'
    req.originalUrl = '/agent?sid=abc&foo=bar'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/m?sid=abc&foo=bar')
    expect(next).not.toHaveBeenCalled()
  })

  test('does NOT redirect when baseUrl is mounted under non-/agent prefix', () => {
    // Even with iPhone UA, a mount like app.use('/api', redirectMobileUA)
    // must NOT redirect — the middleware is only meant to handle /agent.
    const req = mkReq('/agent/xxx', 'Mozilla/5.0 (iPhone)')
    ;(req as any).baseUrl = '/api'
    req.originalUrl = '/api/agent/xxx'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run from repo root:

```bash
cd packages/zai && pnpm exec vitest run src/server/test/unit/middleware/redirectMobileUA.test.ts -t "mounted baseUrl"
```

Expected output: **2 tests FAIL** with messages indicating `expected res.statusCode to be 302, received 200` (case 1) and `expected "next" to be called once, but was called 0 times` (case 2). The other 6 pre-existing tests in the file must still pass.

- [ ] **Step 3: Commit the failing tests**

```bash
cd packages/zai && git add src/server/test/unit/middleware/redirectMobileUA.test.ts
git commit -m "test(zai-server): add failing mount-semantics cases for redirectMobileUA"
```

---

## Task 2: Fix the middleware to use baseUrl + originalUrl

**Files:**
- Modify: `packages/zai/src/server/middleware/redirectMobileUA.ts` (3 lines change, no signature change)

**Interfaces:**
- Consumes: `Request, Response, NextFunction` from express (unchanged).
- Produces: `redirectMobileUA` middleware that correctly identifies `/agent` requests under any mount point and extracts querystring from `req.originalUrl`. `matchesMobileUA` export is untouched.

- [ ] **Step 1: Replace the path guard and querystring extraction**

In `packages/zai/src/server/middleware/redirectMobileUA.ts`, replace the entire `redirectMobileUA` function body with:

```ts
export function redirectMobileUA(req: Request, res: Response, next: NextFunction): void {
  // Express 的 app.use('/agent', mw) 会自动 strip 挂载前缀,中间件内
  // req.path 是相对路径('/...'),req.url 也是相对路径。完整路径要用
  // req.baseUrl + req.path(Express 官方 mount 语义);querystring 也要从
  // req.originalUrl 拿。
  const fullPath = req.baseUrl + req.path
  if (fullPath !== '/agent') {
    next()
    return
  }
  const ua = req.headers['user-agent']
  if (!matchesMobileUA(typeof ua === 'string' ? ua : undefined)) {
    next()
    return
  }
  const suffix = req.originalUrl.replace(/^\/agent/, '')
  res.redirect(302, '/m' + suffix)
}
```

Leave the `MOBILE_UA_RE` constant and `matchesMobileUA` function above it untouched (lines 4-11).

- [ ] **Step 2: Run the unit suite to verify all tests pass**

```bash
cd packages/zai && pnpm exec vitest run src/server/test/unit/middleware/redirectMobileUA.test.ts
```

Expected output: **8 tests pass** (6 pre-existing + 2 new from Task 1). The `matchesMobileUA` describe block (7 cases) also passes — the regex and that helper are unchanged.

- [ ] **Step 3: Commit the fix**

```bash
cd packages/zai && git add src/server/middleware/redirectMobileUA.ts
git commit -m "fix(zai-server): respect Express mount semantics in redirectMobileUA"
```

---

## Task 3: Add supertest integration test for real mount behavior

**Files:**
- Create: `packages/zai/src/server/test/integration/middleware/redirectMobileUA-mount.test.ts`
- Read for context: `packages/zai/src/server/middleware/redirectMobileUA.ts` (post-fix); `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` (import path style); `packages/zai/vitest.config.ts` (if it exists) or root `vitest.config.ts` to verify integration tests are picked up.

**Interfaces:**
- Consumes: `redirectMobileUA` from `redirectMobileUA.ts`; `supertest` (already in `package.json`); express.
- Produces: 4 integration assertions covering iPhone UA → 302, desktop UA → 200, Android UA → 302, root path `/login` with mobile UA → 200.

- [ ] **Step 1: Verify supertest is wired into the project**

Run from repo root:

```bash
cd packages/zai && grep -E '"(supertest|@types/supertest)"' package.json
```

Expected: both `supertest` and `@types/supertest` appear in `dependencies` or `devDependencies`. (Confirmed: spec §Global Constraints says they are present.)

- [ ] **Step 2: Find the right integration test directory**

```bash
ls packages/zai/src/server/test/integration 2>/dev/null || echo "MISSING"
```

If MISSING, create it: `mkdir -p packages/zai/src/server/test/integration/middleware`. If it exists, confirm a sibling integration test exists and follow its import conventions (e.g., `import { redirectMobileUA } from '../../../middleware/redirectMobileUA.js'`).

- [ ] **Step 3: Write the integration test file**

Create `packages/zai/src/server/test/integration/middleware/redirectMobileUA-mount.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the integration test**

```bash
cd packages/zai && pnpm exec vitest run src/server/test/integration/middleware/redirectMobileUA-mount.test.ts
```

Expected: **4 tests pass**. If the integration test directory is not picked up by vitest's default include glob, check `vitest.config.ts` (root or `packages/zai/`) and confirm `test.include` covers `**/test/integration/**/*.test.ts`. If needed, add the glob but DO NOT silently change unrelated config — flag it for review.

- [ ] **Step 5: Commit the integration test**

```bash
cd packages/zai && git add src/server/test/integration/middleware/redirectMobileUA-mount.test.ts
git commit -m "test(zai-server): supertest integration test for redirectMobileUA mount"
```

---

## Task 4: Full suite + end-to-end smoke + push

**Files:** None (verification only).

- [ ] **Step 1: Run the full zai test suite**

```bash
cd packages/zai && pnpm test
```

Expected: every existing test still passes, plus the 3 new tests from Task 1 and Task 3 (2 unit + 4 integration = 6 new test cases total — note the count because integration file has 4 cases, unit file added 2). No regressions.

- [ ] **Step 2: Rebuild and run end-to-end curl smoke**

```bash
cd packages/zai && pnpm build
node --max-old-space-size=4096 dist/cli/index.js start --port 19301 --no-open &
SERVER_PID=$!
sleep 4
```

Then in another shell (or background) verify all 4 cases. Wait until port 19301 is listening:

```bash
# 1. iPhone UA -> 302 /m?sid=abc
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" \
  "http://127.0.0.1:19301/agent?sid=abc"
# Expected: 302 http://127.0.0.1:19301/m?sid=abc

# 2. Android UA -> 302 /m
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  -A "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36" \
  "http://127.0.0.1:19301/agent"
# Expected: 302 http://127.0.0.1:19301/m

# 3. Desktop UA -> 200 (no redirect)
curl -s -o /dev/null -w "%{http_code}\n" \
  -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" \
  "http://127.0.0.1:19301/agent"
# Expected: 200

# 4. iPhone UA /login -> 200
curl -s -o /dev/null -w "%{http_code}\n" \
  -A "Mozilla/5.0 (iPhone)" \
  "http://127.0.0.1:19301/login"
# Expected: 200

kill $SERVER_PID 2>/dev/null; wait 2>/dev/null
```

If any case fails, **stop and debug** — do not push. The unit + integration tests already cover the regression class; a curl failure here means the build artifact or middleware registration is wrong.

- [ ] **Step 3: Push the branch**

```bash
git push origin main
```

(Repo already had a clean main; the 3 commits from Tasks 1-3 + this verification are now on origin.)

- [ ] **Step 4: Verify the push landed**

```bash
git log --oneline origin/main -5
```

Expected: the 4 new commits (`test:`, `fix:`, `test:` integration, plus any cleanup) appear at HEAD, ahead of `32a067f docs: add plan for zai default heap 4gb`.