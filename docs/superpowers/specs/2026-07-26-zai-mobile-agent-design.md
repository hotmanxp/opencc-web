# zai Mobile /agent 页面

**作者**: zai 平台组
**日期**: 2026-07-26
**范围**: 在现有 Agent SPA 旁新增移动端容器,让分享到 LAN 的 `/agent?sid=xxx` 链接在手机/平板上自动进入只读风格 + 触摸优化 + 虚拟键盘适配的对话视图。

---

## 1. 背景

zai 当前 `/agent` 页面是按桌面端布局设计的:`AntLayout` + 左侧 Sider(导航)+ 左侧 40/140px 会话历史栏 + 主对话区 + 右侧 SplitPane(可达 60vw)+ 多个 Drawer/Modal。这套结构在 1024px 以下通过 `RESPONSIVE_BREAKPOINT` 把 SplitPane 自动收起,但其它部分(140px 会话栏、378px SettingsDrawer 等)在手机视口(典型 360-414px 宽)里仍然挤压对话区,TextArea 输入框被虚拟键盘遮挡,SharePopover 生成的 LAN 链接在手机上打开后体验差。

需求:
1. **复用现有分享链接语义** —— `SharePopover` 已经会生成 `http://<LAN-IP>:<port>/agent?sid=xxx`,手机点开后要自动进入只显示对话内容的视图。
2. **复用现有组件** —— `MessageListView`、`QuestionCard`、`AgentInputBox`、`ConfigStatusBar`、`TodoZone` 等都是完备的,移动端不重新实现。
3. **新增独立容器** —— `/agent` 与 `/m` 走两套页面组件,移动端不渲染 SplitPane / 左侧会话历史栏(改为 Drawer)/ Sider 导航栏。
4. **服务器侧检测 + 302 重定向** —— UA 命中移动设备时,把 `/agent?sid=xxx` 一次性 302 到 `/m?sid=xxx`,保留所有 querystring。
5. **虚拟键盘适配** —— iOS Safari / Android Chrome 弹出键盘时,容器高度跟随 `visualViewport` 调整,输入框始终可见。

---

## 2. 范围与非目标

### 范围

- 新增 `/m` 路由 + `MobileAgent` 页面组件
- 新增 `MobileLayout`(无 Sider)+ `MobileHeader` + `MobileSessionDrawer`
- 新增 `useVisualViewportHeight` hook
- 重构 `Agent.tsx`,把对话核心 JSX 抽到 `AgentConversation` 共享组件
- 服务端 `redirectMobileUA` 中间件
- 服务端 `redirectMobileUA.test.ts` + 前端 `MobileAgent.test.tsx` + `AgentConversation.test.tsx`

### 非目标(本期不做)

- 不做触摸手势(左右滑切换会话、长按弹出菜单)
- 不做 PWA 安装提示 / Service Worker / 离线缓存
- 不重写 `MarkdownText` 样式(已在另一个修复分支处理代码块溢出)
- 不改 SSE / AgentRuntime 协议;`useAgentStore` 与 `useEventStream` 完全复用
- 不做深色/浅色主题切换
- 不做横屏/竖屏自适应布局差异(竖屏单栏,横屏可能不优但不专门优化)

---

## 3. 路由与服务端入口

### 3.1 服务端重定向

```
GET /agent?sid=xxx
  ↓
redirectMobileUA(req, res, next)
  ├─ req.path !== '/agent'        → next()  // 不干预其它路径
  ├─ !matchesMobileUA(req.ua)     → next()  // 桌面浏览器直接放行
  └─ 命中:
       res.redirect(302, '/m' + req.url.replace(/^\/agent/, ''))
       // req.url 是 '/agent?sid=xxx&...',strip 前缀后变成 '?sid=xxx&...'
       // '?' 前缀保留,所以最终 Location = '/m?sid=xxx&...'
```

UA 匹配规则(白名单,最小集,易维护):

```ts
const MOBILE_UA_RE = /Mobile|iPhone|iPad|iPod|Android.*Mobile|Mobile.*Safari/
```

- `req.headers['user-agent']` 为 undefined 时直接 `next()`。
- 重定向只对 `/agent` 路径生效;`/login` `/dashboard` 等路径不进这个中间件(避免 PC 用户用手机扫桌面端 QR 后被强制跳移动版)。
- `next()` 链路确保现有静态资源、SPA fallback 不受影响。

### 3.2 服务端 fallback

Express 的 SPA fallback(`*` → `index.html`)对 `/m` 同样适用;`/m?sid=xxx` 由前端路由处理,`useAgentStore` 已经能解析 `?sid=` 并 `loadTranscript`。

### 3.3 iPadOS 13+ 的桌面伪装

iPadOS 13+ Safari 默认 UA 是 `Mozilla/5.0 (Macintosh; ...)` — **会被服务端放过走桌面端**。弥补策略:

- 服务端无法读到 `navigator.maxTouchPoints`,只下发响应头 `X-Zai-Mobile-Suggest: 1`(可选,本期先不发,记为后续优化)。
- **前端兜底**:MobileAgent 页面挂载后,在 useEffect 里检查 `navigator.userAgent.match(MOBILE_UA_RE) || navigator.maxTouchPoints > 0`。如果都不命中,在 `MobileHeader` 顶部展示一条提示横幅:**"似乎在桌面浏览器访问移动版"** + 按钮 **"切回桌面版"**(写 `localStorage.setItem('zai.forceDesktop', '1')` 并 `window.location.replace('/agent' + window.location.search)`)。
- 桌面用户手动点 `/m?xxx` 不会进入 MobileAgent(由前端路由决定);用户一旦写 `forceDesktop=1`,下次任何路径 `/m` / `/agent` 都走桌面版,直到清除 localStorage。

---

## 4. 前端文件清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `packages/zai/src/web/src/pages/MobileAgent.tsx` | 新增 | 移动端主页面;装配 MobileHeader + AgentConversation + MobileSessionDrawer + 必要的 Drawer/Modal |
| `packages/zai/src/web/src/pages/AgentConversation.tsx` | 新增 | 共享对话核心,接 `onOpenSessionDrawer` / `onOpenSettings` 回调 |
| `packages/zai/src/web/src/components/MobileLayout.tsx` | 新增 | 替代 `Layout`(无 Sider),挂 `useVisualViewportHeight` + safe-area 适配 |
| `packages/zai/src/web/src/components/MobileHeader.tsx` | 新增 | 顶栏(高度 56px):左 Drawer 触发按钮 + 当前会话标题(取 `sessions.find().title`)+ 右侧 SharePopover / SettingsDrawer 触发按钮 |
| `packages/zai/src/web/src/components/MobileSessionDrawer.tsx` | 新增 | Antd `Drawer` 从左侧滑出,渲染当前 `useAgentStore.sessions` 列表 |
| `packages/zai/src/web/src/hooks/useVisualViewportHeight.ts` | 新增 | 监听 `window.visualViewport.resize`,返回当前可用高度 |
| `packages/zai/src/server/middleware/redirectMobileUA.ts` | 新增 | UA 检测 + 302 重定向 |
| `packages/zai/src/server/middleware/redirectMobileUA.test.ts` | 新增 | UA 命中/不命中/iPadOS 伪装 三组用例 |
| `packages/zai/src/web/src/pages/MobileAgent.test.tsx` | 新增 | 组件行为测试 |
| `packages/zai/src/web/src/pages/AgentConversation.test.tsx` | 新增 | 共享组件测试 |
| `packages/zai/src/web/src/router.tsx` | 修改 | 新增 `<Route path="/m" element={<MobileAgent />} />`,该路由走 `<MobileLayout>` 父路由 |
| `packages/zai/src/server/index.ts` | 修改 | 在 SPA fallback 前挂 `app.use(redirectMobileUA)`(只对 `/agent` 生效,见 §3.1) |
| `packages/zai/src/web/src/pages/Agent.tsx` | 重构 | 把对话核心 JSX 抽到 `AgentConversation.tsx`,Agent.tsx 仍负责渲染左侧栏 + SplitPane + Drawer 容器 |

### 4.1 `AgentConversation` 契约

```ts
interface AgentConversationProps {
  // 由父组件决定是否渲染"sessions 切换"按钮,以及点击后调啥
  onOpenSessionDrawer?: () => void
  // SettingsDrawer 由父组件持有,但 Conversation 可选暴露一个快捷入口
  onOpenSettings?: () => void
  // 移动端下隐藏 split-pane / transcript-collapse 按钮
  isMobile?: boolean
  // 滚动容器由 Conversation 自管(沿用 Agent.tsx 的 useAutoScrollToBottom 模式)
}
```

内部包含:
- `useAutoScrollToBottom(scrollContainerRef)` — 复用 `hooks/useAutoScrollToBottom.ts`
- `MessageListView` 渲染 `messages`
- `TodoZone` 渲染当前会话 todos
- `QuestionCard` 渲染 pendingAsk
- `AgentInputBox` 接 `isMobile` prop,在 `isMobile=true` 时不渲染 split-pane toggle 与 transcript-collapse toggle(其它按钮保留)
- `ConfigStatusBar` 接 `cwdName` / `branch` / `onTaskSelect` / `splitPaneOpen`(移动端传 `false`,ConfigStatusBar 不展示分屏相关 UI)

### 4.2 `useVisualViewportHeight` 契约

```ts
// 返回 number,单位 px;SSR/Node 测试环境下返回 0,调用方需要 `height || '100vh'` 兜底
export function useVisualViewportHeight(): number
```

实现:
```ts
export function useVisualViewportHeight(): number {
  const [h, setH] = useState(() =>
    typeof window === 'undefined' ? 0 : window.visualViewport?.height ?? window.innerHeight
  )
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setH(vv.height)
    vv.addEventListener('resize', update)
    update()
    return () => vv.removeEventListener('resize', update)
  }, [])
  return h
}
```

注意:`visualViewport` 在 iOS Safari 软键盘弹出/收起时会触发 `resize`,Android Chrome 也支持。不支持的浏览器(老桌面 Safari)降级到 `window.innerHeight`,视觉上等同固定高度 — 与现有行为一致,不引入回归。

### 4.3 `MobileLayout` 契约

```tsx
<MobileLayout>
  <MobileHeader ... />
  <Outlet /> {/* MobileAgent */}
</MobileLayout>
```

```tsx
const vvHeight = useVisualViewportHeight()
return (
  <div
    style={{
      height: vvHeight || '100vh',
      paddingBottom: 'env(safe-area-inset-bottom)',
      display: 'flex',
      flexDirection: 'column',
      background: '#0a0a0f',
      color: '#f1f5f9',
    }}
  >
    {children}
  </div>
)
```

---

## 5. 数据流

### 5.1 重定向链路

```
[手机 Safari] 点 LAN 分享链接 http://192.168.x.x:8080/agent?sid=abc
   ↓
Express 收到 GET /agent
   ↓
redirectMobileUA 中间件: UA 匹配 Mobile
   ↓
302 Location: /m?sid=abc
   ↓
[浏览器] 再次 GET /m?sid=abc
   ↓
SPA fallback 返回 index.html
   ↓
React 启动 → router.tsx 匹配 /m → 渲染 MobileAgent (走 MobileLayout)
   ↓
useAgentStore 解析 sid=abc → loadSessions + loadTranscript('abc')
   ↓
MobileSessionDrawer / MessageListView / AgentInputBox 全部拿到 store 数据
```

### 5.2 会话切换

```
MobileHeader 左上角 [≡] 按钮
  ↓
AgentConversation 暴露的 onOpenSessionDrawer 回调
  ↓
MobileAgent 本地 useState<boolean>(drawerOpen)
  ↓
<Drawer open={drawerOpen} onClose={...} placement="left" width="80%">
  <MobileSessionDrawer />  // 内部读 useAgentStore.sessions
</Drawer>
   ↓
点击某条会话
   ├─ setCurrentSession(sid)
   ├─ loadTranscript(sid)
   └─ drawerOpen = false
```

### 5.3 移动端强制覆盖桌面标识

```
MobileAgent 挂载后 useEffect
  ├─ navigator.maxTouchPoints <= 0 && !UA.match(MOBILE_UA_RE)
  │   → 显示 "切回桌面版" 横幅
  │   → 用户点击 → localStorage.setItem('zai.forceDesktop', '1')
  │                → window.location.replace('/agent?sid=' + ...)
  └─ 否则不渲染横幅
```

后续若加 `zai.forceDesktop` 检查,放在路由层(router.tsx 的 mobile 路由分支)处理:**若 localStorage 含 `forceDesktop='1'`,则 `/m` 路由直接 `<Navigate to={'/agent' + search} replace />`**。本期不实现,只为后续留 hook。

---

## 6. 组件复用差异表

| 组件 | PC(Agent.tsx) | 移动(MobileAgent.tsx) |
|---|---|---|
| AntLayout Sider | ✓ | ✗(MobileLayout 没有) |
| 左侧 40/140px 会话历史栏 | ✓ 内嵌 | ✗ 改为 `MobileSessionDrawer`(Drawer) |
| `<SplitPane cwd={cwd} />` | ✓ | ✗ 不挂载 |
| `<TaskDrawer />` `<ApproveDrawer />` `<SettingsDrawer />` | ✓ | ✓ 全部挂载,SettingsDrawer 用 `width="100%"` 替代默认 378px |
| `<SessionCwdBridge />` | ✓ | ✓ |
| `<MessageListView />` | ✓ | ✓ |
| `<TodoZone />` | ✓ | ✓ |
| `<QuestionCard />` | ✓ | ✓ |
| `<AgentInputBox isMobile={true} />` | ✗(默认 false) | ✓(传 true) |
| `<ConfigStatusBar splitPaneOpen={false} />` | ✓ | ✓ |
| `<MessageBubble />` | ✓ | ✓ |
| `<SharePopover />`(通过 AgentInputBox) | ✓ | ✓ |

### AgentInputBox 改动

- 新增可选 prop `isMobile?: boolean`,默认 false。**与 `useSplitPaneCompactLock` 是平行跳过条件** — splitPane 模式下 lock 把 transcript-collapse-button 锁住;移动端不走 splitPane,lock 自然不命中;但即便 lock 没命中,`isMobile=true` 也直接跳过该按钮的渲染,确保移动端永远不暴露分屏相关的 UI 控制。
- `isMobile=true` 时,不渲染以下 UI 块:
  - `<Button icon={<MenuUnfoldOutlined />} data-testid="split-pane-toggle-inputbox" />`(split-pane toggle)
  - `transcript-collapse-button`(transcript 折叠切换;skip 条件:`isMobile` 或 `transcriptLockActive`,任一命中即不渲染)
  - `transcript-repair-button`(本期同样隐藏 — 移动端不暴露内部维护工具)
- 其它按钮(ShareAlt / Settings / Picture / ConversationInfo / 状态行)保持不变。
- 实现:把条件从 `!transcriptLockActive && (...)` 改成 `!transcriptLockActive && !isMobile && (...)`,其它两块同理用 `&& !isMobile` 收敛。

### ConfigStatusBar 改动

- 已有 `splitPaneOpen` prop,移动端传 `false` → `ConfigStatusBar` 内部不展示与 splitPane 相关的子控件(具体行为以 ConfigStatusBar 现有实现为准,不需要新逻辑)。
- 文字截断:`cwdName` / `branch` 过长时通过 CSS `text-overflow: ellipsis` 截断,不展开完整路径(避免顶栏 / 状态栏溢出)。

---

## 7. 错误处理

| 场景 | 表现 | 处理 |
|---|---|---|
| UA 无法解析(undefined / 空字符串) | 服务端放过,桌面版正常渲染 | `redirectMobileUA` 直接 `next()` |
| `/m` 路径被错误重定向 | 服务端放过(避免 `/m` → `/m` 死循环) | `redirectMobileUA` 显式跳过 `/m`(见 §3.1 第一条 guard) |
| iPadOS 13+ Safari 桌面伪装 | 服务端放过,用户在桌面版 | `MobileAgent` 顶部横幅提供"切回桌面版"按钮;桌面用户主动访问 `/m` 时不被自动重定向(中间件只对 `/agent` 生效) |
| `visualViewport` 不可用(老浏览器) | 容器高度降级到 `innerHeight` | hook 内部 `?? window.innerHeight` |
| `useAgentStore.sessions` 为空 | 显示"暂无历史会话",顶栏 [+ 新建会话] 按钮仍可用 | MobileSessionDrawer 现有渲染逻辑复用 |
| `loadTranscript(sid)` 失败 | toast 报错,停留在当前会话 | 与 PC 版一致 |
| 服务端 302 后 SPA fallback 出错 | 5xx 错误页 | 现有 fallback 行为,不动 |
| localStorage 配额满(`forceDesktop` 写不进去) | 用户每次访问都看横幅 | silent ignore — 不影响主功能 |

---

## 8. 测试策略

### 8.1 服务端 `redirectMobileUA.test.ts`

```ts
describe('redirectMobileUA', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/...', true],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/...', true],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/...', false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...', false],
    [undefined, false],
  ])('UA=%s → redirect=%s', (ua, expected) => { ... })

  test('redirects /agent?sid=abc to /m?sid=abc (querystring preserved)', ...)
  test('does NOT redirect /login or /dashboard', ...)
  test('does NOT redirect /m (avoids loop)', ...)
})
```

### 8.2 前端 `MobileAgent.test.tsx`

```ts
describe('MobileAgent', () => {
  test('renders MobileHeader with current session title', ...)
  test('clicking [≡] opens MobileSessionDrawer', ...)
  test('clicking a session in drawer closes drawer and calls loadTranscript', ...)
  test('does NOT render SplitPane', ...)
  test('AgentInputBox receives isMobile=true (no split-pane toggle rendered)', ...)
  test('shows "switch to desktop" banner when UA is desktop-like', ...)
  test('clears banner and forceDesktop flag after user clicks switch', ...)
})
```

### 8.3 `AgentConversation.test.tsx`

```ts
describe('AgentConversation', () => {
  test('renders messages via MessageListView', ...)
  test('renders QuestionCard when pendingAsk is set', ...)
  test('renders AgentInputBox with isMobile=false by default', ...)
  test('onOpenSessionDrawer is called when AgentInputBox exposes it', ...)
})
```

### 8.4 回归

- `Agent.tsx` 现有 8 个 test (`pages/Agent.test.tsx`):全部保留,确认重构未破坏 PC 行为。
- `useAgentStore.test.ts` 不动。
- `redirectMobileUA.test.ts` 与 PC 端无交集,不互相干扰。

---

## 9. 实施计划(高层)

按 §4 文件清单顺序:

1. **服务端中间件 + 测试** —— `redirectMobileUA.ts` + `.test.ts`,挂到 `server/index.ts`。
2. **共享 `AgentConversation.tsx`** —— 把 Agent.tsx 中第 565-666 行(主对话区 JSX)抽出来,Agent.tsx 改用 `<AgentConversation />`。
3. **`useVisualViewportHeight.ts` hook** + 单测。
4. **`MobileLayout.tsx` + `MobileHeader.tsx` + `MobileSessionDrawer.tsx`** + 单测。
5. **`MobileAgent.tsx`** 装配 + 单测。
6. **`router.tsx`** 加 `/m` 路由 + `<Route element={<MobileLayout />}>...` 嵌套。
7. **AgentInputBox `isMobile` prop** + 单测覆盖。
8. **回归 + 全量单测 + `pnpm test` 通过**。
9. **手动 smoke**:用 Chrome DevTools 切到 iPhone UA,访问 `/agent?sid=xxx`,确认重定向 → `/m?sid=xxx` → 移动版布局 → 关闭键盘后容器恢复。

---

## 10. 风险与权衡

| 风险 | 缓解 |
|---|---|
| iPadOS 13+ UA 伪装 | `MobileAgent` 横幅 + `forceDesktop` 标记(本期先暴露按钮,不实施强制) |
| 重定向循环(若有人写爬虫无限跳) | `/m` 路径不进 redirectMobileUA 中间件 |
| `visualViewport` 在 Android Chrome 旧版(<61)缺失 | 降级到 `window.innerHeight`,与现有体验一致 |
| `AgentConversation` 抽离后,Agent.tsx 业务逻辑泄露 | Agent.tsx 仍然持有 `cwd` / `loadSessions` / `createNewSession` 等,通过 props 注入;`AgentConversation` 只接收数据 + 回调 |
| `MessageListView` 在窄屏下宽度仍挤 | 已存在的 `flex: 1; minWidth: 0; overflowX: 'hidden'` 处理;确认 `MobileLayout` 不引入额外 padding |
| Drawer 抽屉与 AntD 默认主题差异 | 移动端用现有 `ConfigProvider` theme 即可,不引入新主题 |
| 服务器侧中间件 302 与 SPA fallback 的优先级 | `app.use(redirectMobileUA)` 放在 `express.static` 之前,SPA fallback 之前 — 让静态资源命中能直接 304,只在找不到文件时才进入 fallback |
| `localStorage` 在跨域/隐私模式失效 | `useVisualViewportHeight` 不依赖 localStorage;`forceDesktop` 写不进去时静默忽略(本期未实施 forceDesktop 强校验) |

---

## 11. 后续(本期不做,留 TODO)

- `localStorage.forceDesktop` 路由层强校验
- 触摸手势(左滑切换会话、长按显示菜单)
- PWA / 离线缓存 / 安装提示
- 横屏布局优化(横屏可考虑两栏:左会话列表 30% + 右对话 70%)
- `MarkdownText` 代码块横向滚动(另一个修复分支,不动本设计范围)