# 全局 API 错误 Toast — Design

**Date:** 2026-07-13
**Status:** Draft (pending user review)
**Author:** brainstorming session

## Goal

在 `zai` Web 前端统一拦截 `/api/*` 调用失败与 SSE 连接异常,通过 antd `notification.error` 在右上角弹 Toast。点击 Toast 内的"查看详情"按钮可看到 method/url/status/响应体,便于调试。

业务侧的 HTTP 失败 `message.error(...)` 全部移除,避免重复提示。业务级错误(如 JSON 解析失败、登录业务状态)保留原状。

## Scope

- 新增 `packages/zai/src/web/src/lib/apiError.ts`(ApiError 类 + 两个全局通知函数)
- 改造 `packages/zai/src/web/src/lib/api.ts`(`request()` 失败时通知 + 抛出 ApiError)
- 改造 `packages/zai/src/web/src/lib/sse.ts`(`useSse` 的 `onerror` 通知,区分正常结束 vs 异常断开)
- 改造 `packages/zai/src/web/src/lib/eventSource.ts`(`subscribeServerEvents` 的 `onError` 通知)
- 删除 5 个 `pages/*.tsx` 中共 10 处 `message.error(...)`,保留业务级措辞

非目标(留作后续):
- 错误队列历史抽屉
- 错误上报 / Sentry
- 错误重试 / 失败按钮触发重发

## Architecture

```
[页面] api.get / api.post / api.put
   │
   ▼
[lib/api.ts : request]   ── fetch !ok ──▶ notifyApiError(err) ─▶ antd notification.error
   │                                                       ▼
   └─ throw ApiError                                     右上角 Toast
       (调用方 try/catch 拿到的总是 ApiError)               [查看详情] → 折叠面板 method/url/status/body

[页面] useSse(path) / subscribeServerEvents(cb)
   │
   ▼
[lib/sse.ts : useSse]
   │  source.onerror 触发
   ▼
   ├─ 若之前收到过 exit → 静默(视为正常结束)
   └─ 否则 → notifySseError(path, reason) ─▶ antd notification.error
                                                          "SSE 连接断开: GET /api/install/..."
```

## Files

### New files (1)

| Path | Purpose |
|---|---|
| `packages/zai/src/web/src/lib/apiError.ts` | `ApiError` 类(携带 status/method/url/body) + `notifyApiError` / `notifySseError` 两个函数(均调 antd `notification.error`) |
| `packages/zai/test/web/apiError.test.ts` | 单测:ApiError 字段正确;`notifyApiError` 调用 `notification.error` 时配置正确(标题、duration、btn) |

### Edited files (6)

| Path | Change |
|---|---|
| `packages/zai/src/web/src/lib/api.ts` | `request()` 失败分支:读 body(`text()`,失败 fallback `statusText`)→ `notifyApiError(err)` + `throw err`。`err` 是新 `ApiError(status, method, url, body)`。`get/post/put` 包装保持原样 |
| `packages/zai/src/web/src/lib/sse.ts` | 在 `useSse` 中维护 `doneRef`(布尔)。`source.onmessage` 收到 `type === 'exit'` → `doneRef.current = true`。`source.onerror` 时:若 `doneRef.current` → 静默(`onEnd()`);否则 `notifySseError(path, '连接已断开')` 后再 `onEnd()` |
| `packages/zai/src/web/src/lib/eventSource.ts` | `es.onerror = (e) => { notifySseError('/event', '事件流断开'); onError?.(e) }` |
| `packages/zai/src/web/src/pages/Dashboard.tsx` | 删 3 处 `message.error`(lines 25 / 56 / 64)。`loadInfo/handleSetCli` 的 catch 保留用于状态清理 |
| `packages/zai/src/web/src/pages/Directory.tsx` | 删 2 处 `message.error`(lines 97 / 134)。`copy` 业务校验"复制失败"是 API 错(后端 502),归到统一拦截 |
| `packages/zai/src/web/src/pages/Config.tsx` | 删 4 处 `message.error`(lines 91 / 150 / 164 / 268 / 289 / 394)。**保留** lines 420 / 424(`JSON 解析失败` / `配置文件必须是 JSON 对象`,业务校验) + line 434 视情况(若来自后端错误则删,若来自 `JSON.stringify` 本地抛则保留 — 见下方 "Deletion matrix" 说明) |
| `packages/zai/src/web/src/pages/Resources.tsx` | 删 2 处 `message.error`(lines 95 / 132) |

### NOT edited (业务级错误保留)

- `packages/zai/src/web/src/pages/Login.tsx:128` — `登录失败: ${last.message ?? '未知错误'}` 是登录回调的业务级状态文案,**保留**
- `Config.tsx:420` / `Config.tsx:424` — JSON 解析失败的本地校验,**保留**

### Deletion matrix

下表是精确到行号的"删/留"决定:

| 文件:行 | 当前文案 | 决定 | 原因 |
|---|---|---|---|
| Dashboard.tsx:25 | `加载失败: ${err.message}` | 删 | 是 `/api/system` 或 `/api/cli` 失败的 catch |
| Dashboard.tsx:56 | `切换失败, npm 退出码 ${exitCode}` | 删 | `/api/cli/set` 失败(API 错) |
| Dashboard.tsx:64 | `切换失败: ${(err as Error).message}` | 删 | 同上 |
| Directory.tsx:97 | `加载失败: ${err}` | 删 | API 失败 |
| Directory.tsx:134 | `复制失败, 请手动选择` | 删 | 接口失败 catch;业务级"手动选择"由用户感知 |
| Config.tsx:91 | `加载 Provider 失败` | 删 | API 失败 |
| Config.tsx:150 | `${err.message}` | 删 | API 失败 |
| Config.tsx:164 | `删除失败` | 删 | API 失败 |
| Config.tsx:268 | `加载插件失败` | 删 | API 失败 |
| Config.tsx:289 | `保存失败: ${err}` | 删 | API 失败 |
| Config.tsx:394 | `加载配置失败` | 删 | API 失败 |
| Config.tsx:420 | `JSON 解析失败: ${msg}` | **保留** | 本地 `JSON.parse` 抛错 |
| Config.tsx:424 | `配置文件必须是 JSON 对象` | **保留** | 本地校验 |
| Config.tsx:434 | `保存失败: ${err}` | 视上下文 | 必须等实施阶段核对 catch 块——若仅捕获 API 失败 → 删;若同 catch 处理 API + 本地 JSON.stringify 异常 → 拆 catch,只删 API 部分,业务文案保留(参见 Risk 4) |
| Resources.tsx:95 | `加载失败: ${err}` | 删 | API 失败 |
| Resources.tsx:132 | `刷新失败: ${err}` | 删 | API 失败 |
| Login.tsx:128 | `登录失败: ${last.message}` | **保留** | 业务级回调状态 |

> 提醒:删除时同时去掉 `catch` 中的 `message.error(...)` 调用,但 `catch {}` 块本身保留(如有状态清理逻辑),并保证不引入新 lint 问题。

## ApiError design

```ts
// packages/zai/src/web/src/lib/apiError.ts
export class ApiError extends Error {
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: string
  readonly at: number

  constructor(status: number, method: string, url: string, body: string) {
    super(`${status} ${method} /api${url}`.trimEnd())
    this.name = 'ApiError'
    this.status = status
    this.method = method
    this.url = url
    this.body = body
    this.at = Date.now()
  }
}

export function notifyApiError(err: ApiError): void
export function notifySseError(path: string, reason: string): void
```

`notifyApiError` 用 antd `notification.error` 弹出:
- `message`: `${err.status} ${err.method} /api${err.url}`
- `description`: 静态文本,**详情总是展开**(避免 React state 引入复杂度)。包含 `method / url / status / time(body 截获时间) / body`(body 尝试 JSON 美化,失败回退原文)
- `duration`: 6
- (无折叠 btn — 后续若需折叠,在 Issue 上加)

`notifySseError` 弹出:
- `message`: `SSE 连接已断开`
- `description`: `path: ${path}\nreason: ${reason}`
- `duration`: 6

## 节流(去抖)

全局 module-scope `Map<string, number>` 缓存 `(method+url+status) → lastNotifyAt`。在 `notifyApiError` 入口处:若当前时间 - 上次时间 < 2000ms,**直接 return**(不弹、不抛)。`notifySseError` 同样节流,key 为 `sse:${path}`。

Map 容量上限 64,超出会 LRU 淘汰(简单实现即可)。

> 目的:避免 100 个并行失败请求造成 100 个 toast 堆叠。

## Data flow on error

```
fetch (GET /api/system)
  ↓ res.ok === false (e.g. 502)
  body = await res.text()
  err = new ApiError(502, 'GET', '/system', body)
  notifyApiError(err)
    ↓
    if (now - lastNotifyAt[502 GET /system] < 2000ms) return
    lastNotifyAt[...] = now
    antd.notification.error({ message: '502 GET /api/system', description, btn })
      ↓
      user clicks [查看详情]
        ↓
        description 展开(<pre><code>{JSON.stringify(parsedJson ?? body, null, 2)}</code></pre>)
```

## Error handling matrix

| Scenario | Behavior |
|---|---|
| `/api/*` 返回 4xx / 5xx | Toast 弹出,带 status+body;抛 ApiError 给调用方 catch |
| fetch network 异常(网络断开、CORS) | Toast 弹出,status=0,body=err.message;抛 ApiError |
| 后端返回非 JSON body | `body` 保留原始 text,详情里 JSON 美化失败时 fallback 文本 |
| 同一 URL 短时间内 100 次失败 | 节流后只弹一次 |
| SSE onerror 但之前收到过 `exit` 事件 | 静默,只调 `onEnd()` |
| SSE onerror 之前从无 exit | Toast 弹出"连接已断开",然后 `onEnd()` |
| SSE 推送的 `runtime.error` / `server.error` 事件 | 走原有路径(store/页面处理),**不**走 `notifySseError`(那只是连接级)|
| 调用方业务 `throw new Error('xxx')` | 不被拦截,正常冒泡。catch 里自己处理 |
| Login 业务 `登录失败: ${last.message}` | 保留,不被拦截 |

## Invariants

- `request()` 失败时**总是**抛 `ApiError`(不是裸 `Error`)
- `useSse` 的 `onEnd()` 在 onerror 时**总是**被调(无论是否 toast)
- `notification.error` 是单模块单例调用,可在 `apiError.ts` 的 `init()` 集中配置(目前不需要,可直接全局调)
- toast 与 Drawer/抽屉不冲突:后续可加抽屉作为详情面板,本期不做

## Testing

### `apiError.test.ts`(新)

| Case | Input | Expected |
|---|---|---|
| `ApiError` 构造 | `(502, 'GET', '/system', 'bad gateway')` | `err.name === 'ApiError'`, `err.status === 502`, `err.message` 包含 `502 GET /api/system` |
| `notifyApiError` 第 1 次调用 | `new ApiError(502, 'GET', '/system', '')` | `notification.error` 被调 1 次,参数含 `message` / `description` / `duration=6` |
| `notifyApiError` 2000ms 内重复 | 同 key 调用 2 次 | 第 2 次不调 `notification.error` |
| `notifySseError` | `('/install/resource?type=skills&name=foo', '连接已断开')` | `notification.error` 调 1 次,message 为 "SSE 连接已断开" |

> mock 策略:`vi.mock('antd', () => ({ notification: { error: vi.fn() } }))`。使用 vitest(项目已配置 vitest@4)。

### 手工验证(无法自动化)

1. 启动 `pnpm --filter @zn-ai/zai dev` → 浏览器打开
2. 后端存活 → 浏览所有页面 → 没有 toast(单元测试已覆盖失败路径,手工只验正常路径无副作用)
3. 关停后端 → 浏览器触发 `/api/system` → 看到右上角 toast
4. SSE 场景:启动一次正常 `/api/install/...` → 完成后不应弹 "SSE 连接已断开"
5. SSE 异常断开:在 InstallSseSubscriber 期间强制关停后端 → 弹 toast

## Risks

1. **重复通知 / toast 风暴** — 节流处理(2000ms / key),LRU 64 容量上限
2. **业务错误被拦截误报** — 不会,因为只对 `request()` 失败分支调通知,业务 `throw new Error('xxx')` 经调用方 catch 处理(可能调用方仍然 catch 后 `message.error` 业务文案,正常)
3. **antd `notification.error` 全局副作用** — 不影响 antd ConfigProvider,所有页面都已用同一 antd 主题
4. **Config.tsx:434 边界** — 该行 `保存失败: ${err}` 是 fetch 失败 catch 内,删;但同一 catch 中可能混入 `JSON.stringify` 后端大对象本地异常。**实施前再核对一次**:若 catch 实为前/后端共用,改为分别处理(API 失败→throw 由 request 层处理,本地解析失败→保留 message)
5. **测试 mock 与 antd 版本耦合** — antd `notification` 接口稳定,但 mock 仍按 `vi.mock` 在每个单测文件顶部声明

## Open questions

无 — 所有澄清已完成。
