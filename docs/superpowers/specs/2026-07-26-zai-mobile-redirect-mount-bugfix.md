# zai 移动端重定向 mount 语义 bug 修复

**作者**: zai 平台组
**日期**: 2026-07-26
**范围**: 修复 `redirectMobileUA` 中间件在 Express `app.use('/agent', mw)` mount 写法下永远 `next()`、不执行 302 的回归 bug。
**父 spec**: `2026-07-26-zai-mobile-agent-design.md`(已交付,功能代码完整)

---

## 1. 背景

`2026-07-26-zai-mobile-agent-design.md` 已交付移动端 `/m` 路由 + UA 重定向功能,但**实际端到端验证**(2026-07-26 在 iPhone UA 下 `curl /agent?sid=abc123`)显示响应是 200 OK + 桌面端 `index.html`,而不是预期的 302 `/m?sid=abc123`。移动端访问 `/agent?sid=xxx` 链接依然展示桌面版布局。

原因:Express `app.use('/agent', redirectMobileUA)` 的 mount 语义会**自动 strip 挂载前缀**,中间件内 `req.path` 变成 `/`(相对路径),而 `redirectMobileUA.ts:19` 的 guard:

```ts
if (req.path !== '/agent') { next(); return }
```

在 mount 场景下 `req.path` 永远不是 `/agent`,导致永远走 `next()`,重定向分支永远不执行。

---

## 2. 根因分析

`packages/zai/src/server/index.ts:144`:

```ts
app.use('/agent', redirectMobileUA);
```

Express 文档明确说明:被 mount 的中间件内 `req.url` 和 `req.path` 是**相对于挂载点**的(已 strip 前缀)。完整路径需要用 `req.baseUrl + req.path` 或 `req.originalUrl`。

最小复现验证(`node test-mount-semantics.mjs`):

```
GET /agent
mw sees: req.path="/" req.url="/" req.originalUrl="/agent"
```

- `req.path === '/'`(strip 后)
- `req.originalUrl === '/agent'`(完整路径)

中间件内部所有使用 `req.path` / `req.url` 判定 `/agent` 路径的逻辑都失效。

测试为什么没发现:`packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` 用 `mkReq('/agent', ua)` 手动构造 `req.path = '/agent'`,**绕过真实 Express mount 行为**。`baseUrl` 为空字符串,旧逻辑碰巧能跑通,生产却坏掉。

---

## 3. 修复方案

### 3.1 中间件改动(`packages/zai/src/server/middleware/redirectMobileUA.ts`)

```ts
export function redirectMobileUA(req: Request, res: Response, next: NextFunction): void {
  // Express 的 app.use('/agent', mw) 会自动 strip 挂载前缀,中间件内
  // req.path 是相对路径('/...'),req.url 也是相对路径。完整路径要用
  // req.baseUrl + req.path(Express 官方 mount 语义)。
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
  // querystring 从 originalUrl 拿 — req.url 在 mount 场景下是相对路径 '/'
  const suffix = req.originalUrl.replace(/^\/agent/, '')
  res.redirect(302, '/m' + suffix)
}
```

**3 处微改**:
1. 第 19 行 `req.path !== '/agent'` → `fullPath !== '/agent'`(`fullPath = req.baseUrl + req.path`)
2. 第 28 行 `req.url.replace(...)` → `req.originalUrl.replace(...)`
3. 加注释解释 mount 语义

`matchesMobileUA` 单独导出的纯函数继续复用,但内部 UA regex 已同步修正:原正则 `/Mobile|Android|iPhone|iPad|iPod|Safari/` 会误匹配所有 Safari UA(含桌面 Chrome 的 Safari 兼容 UA),已更正为 `/(?:iPhone|iPad|iPod|Android|Mobile|Safari.*Mobile)/` — 只匹配移动设备 UA。

### 3.2 测试改动(`packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts`)

既有 6 个用例保留(向后兼容,baseUrl 为空时新旧逻辑等价)。

**新增 2 个 mount 场景用例**,明确 `baseUrl: '/agent'` + `path: '/'` + `originalUrl: '/agent?sid=abc'`:

```ts
test('redirects /agent under mounted baseUrl (real Express scenario)', () => {
  const req = mkReq('/', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  ;(req as any).baseUrl = '/agent'
  req.originalUrl = '/agent?sid=abc&foo=bar'
  // ...期望 302 /m?sid=abc&foo=bar
})

test('does NOT redirect /api under mounted baseUrl (unrelated path)', () => {
  const req = mkReq('/agent', 'Mozilla/5.0 (iPhone)')
  ;(req as any).baseUrl = '/api'
  req.originalUrl = '/api/agent/xxx'
  // ...期望 next() 被调用,不重定向
})
```

第二个用例证明:即使 iPhone UA 命中,只要 mount 的 baseUrl 不是 `/agent`,也不重定向。

### 3.3 不动的文件

| 文件 | 原因 |
|---|---|
| `packages/zai/src/server/index.ts` | mount 写法保留(`app.use('/agent', redirectMobileUA)`),改中间件即可 |
| `packages/zai/src/web/src/router.tsx` | 前端 `/m` 路由已有 |
| `packages/zai/src/web/src/pages/MobileAgent.tsx` 等 | 移动端组件完整,无需改 |
| `docs/superpowers/specs/2026-07-26-zai-mobile-agent-design.md` | 原 spec 已正确描述设计,bug 是实现层的回归 |

---

## 4. 数据流(修复后)

```
[手机 Safari] GET /agent?sid=abc
   ↓
Express 收到请求,匹配 mount '/agent'
   ↓
redirectMobileUA 中间件:
   fullPath = req.baseUrl('/agent') + req.path('/') = '/agent' ✓
   matchesMobileUA('Mozilla/5.0 (iPhone...)') = true
   suffix = req.originalUrl.replace(/^\/agent/, '') = '?sid=abc'
   ↓
res.redirect(302, '/m?sid=abc')
   ↓
[浏览器] GET /m?sid=abc
   ↓
SPA fallback → index.html → React 启动 → /m 路由 → MobileAgent 组件
```

---

## 5. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 漏掉 mount 边界(比如 `/agent/` trailing slash) | Express `app.use('/agent', mw)` 只在 `/agent` 精确匹配时进入,trailing slash 不进 — 文档明确 |
| 影响 `/api/*` 路径 | 不影响 — `req.baseUrl === '/api'` 时 `fullPath === '/api/...'` 已被 guard 过滤 |
| 既有测试要重写 | 不重写,只新增 — 既有 6 个用例在 `baseUrl=''` 时新旧逻辑等价,继续通过 |
| 用户手动访问 `/m`(没经过 302) | 中间件 guard 显式跳过 `/m`(req.baseUrl='/agent' + req.path='/m' → fullPath='/agent/m',不等于 '/agent',next()) |
| Desktop 用户在手机上收到 `/m` 误入 | 维持现状,iPadOS 桌面伪装 UA 走桌面版(后续视需要加 forceDesktop,本期不做) |

---

## 6. 实施计划(高层)

1. 改 `redirectMobileUA.ts` 3 处
2. 改 `redirectMobileUA.test.ts` 加 2 个 mount 场景用例
3. `pnpm --filter zai test` 全过
4. 端到端 curl 验证:iPhone UA → 302 /m?sid=xxx;Desktop UA → 200 index.html;iPhone UA 访问 /api/* → 200(不被重定向)
5. commit + push

---

## 7. 后续(本期不做)

- `localStorage.forceDesktop` 路由层强校验(父 spec §11 第 1 条,留给后续)
- MobileAgent.test.tsx + AgentConversation.test.tsx(父 spec §8.2-8.3,留给后续)
- 在 CI 加 supertest 端到端 mount 场景(防类似 mount 语义回归)