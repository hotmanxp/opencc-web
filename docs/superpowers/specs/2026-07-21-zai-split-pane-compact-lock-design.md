# zai split-pane compact lock + session auto-collapse 设计

> 日期: 2026-07-21
> 范围: `packages/zai/src/web/src` 前端
> 状态: 已通过 brainstorming,待用户审阅

## 1. 背景与目标

zai 当前的右侧分屏(SplitPane)是一个常驻面板,展开后主对话区横向空间被压缩。当前实现里已经存在多处 "compact" 模式适配(例如 `ConfigStatusBar` 的 `compact` prop、`TaskDock` 折叠文本、`ModeStatusButton` 去掉 shift+tab 提示),但 **对话 transcript 本身的折叠态(`transcriptCollapsed`)没有被分屏开关自动驱动**,需要用户手动点工具栏按钮;而且**会话历史侧栏(`sessionsCollapsed`)默认展开后不会自动收回**,在窄屏分屏态下视觉拥挤。

本设计:

1. **进入分屏(右侧面板打开)→ 自动进入紧凑模式**:把 `transcriptCollapsed` 强制设 `true`,并**锁定**,用户在分屏打开期间无法通过 transcript-collapse 按钮切换回展开。
2. **进入分屏 → 自动收起会话列表侧栏(`sessionsCollapsed=true`)**。
3. **会话列表在分屏期间被点开后,可以切换会话、可以浏览列表,但 10s 内无任何交互(切换会话 / 鼠标在列表内移动 / hover 任一会话项)就自动收回**;一旦有交互就重置 10s 倒计时。
4. **关闭分屏 → transcript 折叠态沿用关闭瞬间的状态**(不再被分屏联动),会话列表恢复到关闭前的状态。

## 2. 非目标

- **不**修改右侧分屏自身的可见性/宽度/动画(由 `STORAGE_KEYS.open` / `STORAGE_KEYS.width` 维持)。
- **不**修改 `outputStyle` settings 持久化行为;`transcriptCollapsed` 仍然由 Layout 在冷启动 hydrate 时从 `outputStyle` 投影;分屏只追加一层 "运行时锁定" 覆盖。
- **不**影响左侧主导航侧栏(`useAppStore.sidebarCollapsed`),那是 AntD `Sider` 的全局开关,与 Agent 页面无关。
- **不**让用户能"禁用自动 compact 锁";只要分屏开就锁。`outputStyle` settings 持久层保持独立,关闭分屏后回归用户原态。
- **不**给 `sessionsCollapsed` 加持久化(目前是 `useState`,非 localStorage);保持现状。

## 3. 关键概念

| 概念 | 出处 | 说明 |
|---|---|---|
| `splitPaneOpen` | `useLocalStorageState(STORAGE_KEYS.open, false)`,由 `Agent.tsx` / `SplitPane.tsx` / `AgentInputBox.tsx` 共享 | 右侧分屏可见性。`true` 时即"分屏模式"。 |
| `transcriptCollapsed` | `useAgentStore` 单个 boolean | `MessageListView` 渲染分叉:`false` → 完整消息流;`true` → `CollapsedMessageBubble` 折叠视图。Layout hydrate 时由 `outputStyle === 'compact'` 决定初值。 |
| `setTranscriptCollapsed` | `useAgentStore` action | 当前任何来源(`SettingsDrawer` 切 `outputStyle`、`AgentInputBox` 工具栏按钮、Layout hydrate)都通过它写入。 |
| `sessionsCollapsed` | `Agent.tsx` 内 `useState(true)` | 会话历史侧栏是否收起,默认 `true`(收起)。 |
| `outputStyle` | `useAppStore` 字段,持久化到 `~/.zai/settings.json` | 用户 settings 层的"输出样式"。**不是**本设计的目标;只作为关闭分屏后 transcriptCollapsed 的兜底源。 |

## 4. 架构

### 4.1 新增模块

| 模块 | 位置 | 职责 |
|---|---|---|
| `useSplitPaneCompactLock(sessionId)` hook | `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts` (新建) | 订阅 `splitPaneOpen`,在 `true` 时把 `transcriptCollapsed` 强制设 `true` 并"冻结"该字段(拦截 setTranscriptCollapsed 写入 `false`);`false` 时解除冻结。返回当前是否处于锁定态(`isLocked`)给 UI 决定是否隐藏按钮。 |
| `useSplitPaneSessionAutoCollapse(splitPaneOpen)` hook | `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts` (新建) | 订阅 `splitPaneOpen`;`true` 时把 `sessionsCollapsed` 强制设 `true`;当用户把 `sessionsCollapsed` 从 `true` 翻成 `false` 时启动 10s 倒计时,在倒计时结束前若发生 setCurrentSession / 列表内鼠标移动 / hover 任意 session 项 → 重置;倒计时结束 → `setSessionsCollapsed(true)`。返回 `{ collapsed, expand(), schedule }`。 |
| `SessionListAutoCollapseTimer` | 同上 hook 内部 useRef | 持有一个 `setTimeout` handle + 最后一次交互时间戳;cleanup 时 clearTimeout。 |

### 4.2 改动现有模块

| 文件 | 改动 |
|---|---|
| `pages/Agent.tsx` | 删除现有的 `const [sessionsCollapsed, setSessionsCollapsed] = useState(true);`,改为调用 `useSplitPaneSessionAutoCollapse(splitPaneOpen)` hook 拿到的 `{ collapsed, expand }`。`setSessionsCollapsed(true)` 替换为 `setSessionsCollapsed(false)` 的位置 → `expand()`。展开态按钮 `onClick={() => setSessionsCollapsed(true)}` 改成 `expand()` 保持语义(`expand` 表示"打开列表并启动 10s 倒计时")。在 hover / onClick 处调用 `schedule()` 重置倒计时。 |
| `components/AgentInputBox.tsx` | 在 transcript-collapse 按钮外层根据 `isLocked`(`useSplitPaneCompactLock()` 返回值)条件渲染:`isLocked` 为 `true` → 整个按钮 + Tooltip 不渲染。注:`useSplitPaneCompactLock` hook **必须**放在 Agent.tsx 顶层并通过 context 或 props 传递 `isLocked`;见 §5 决策。 |
| `components/transcript/MessageListView.tsx` | **不变**。继续读 `transcriptCollapsed` 决定折叠与否。 |
| `store/useAgentStore.ts` | **不变**。`setTranscriptCollapsed` 不引入 "locked" 概念(避免 store 与 hook 耦合);锁定由 hook 在调用前拦截完成。 |

## 5. 关键决策:isLocked 怎么传到 AgentInputBox

`AgentInputBox` 已经是 Agent 页面内独立的子组件,接受 `useAgentStore` 直接订阅。把 `splitPaneOpen` / `isLocked` 透传会让 props 树变大。最简洁:

- **方案 A(推荐)**: `AgentInputBox` 内部直接调 `useSplitPaneCompactLock()` hook。它已经订阅 `useAgentStore` / `useAppStore`,再加一个本地 hook 代价小。
- 方案 B: React context。增加 Provider/Consumer 样板,且 Agent 树里只有两个组件需要这个状态,过度设计。
- 方案 C: 把 `isLocked` 写到 `useAgentStore`。store 已经有 `transcriptCollapsed`、把 "locked" 也塞进去 → 把 view-state 与 runtime-override 耦合到 store,违背现有 Layout hydrate 时的"store 是布尔真源、override 由 UI 层维护"的契约。

**选 A**。`useSplitPaneCompactLock` 在两个组件(`Agent.tsx`、`AgentInputBox.tsx`)分别调用,各自负责自己关心的事;共享通过 `splitPaneOpen` (localStorage) + `transcriptCollapsed` (store) 两个单例状态自然同步,不会双源冲突。

## 6. 数据流

### 6.1 进入分屏(compact lock)

```
splitPaneOpen: false → true   (用户在任意 toggle 点开)
  ↓
useSplitPaneCompactLock 内的 useEffect 触发
  ↓
transcriptCollapsed := true (force)
  ↓
MessageListView 立刻渲染 CollapsedMessageBubble
  ↓
AgentInputBox 的 transcript-collapse 按钮渲染条件 = false → 整个按钮不挂载
```

### 6.2 分屏期间尝试点折叠按钮

按钮已被隐藏,**根本不存在触发路径**。若用 devtools 强行调 `setTranscriptCollapsed(false)`:`useSplitPaneCompactLock` 通过订阅 transcriptCollapsed 检测到 `false` 且 `splitPaneOpen === true` → 立刻 `setTranscriptCollapsed(true)` 复位。无视觉闪烁(同步写回)。

### 6.3 关闭分屏

```
splitPaneOpen: true → false
  ↓
useSplitPaneCompactLock 解除"冻结态",仅不再写回。
  ↓
transcriptCollapsed 保持关闭瞬间值(用户原态)。
```

### 6.4 分屏期间,会话列表

```
splitPaneOpen: true
  ↓
useSplitPaneSessionAutoCollapse effect:
  sessionsCollapsed := true    (强制)
  ↓
用户点会话列表展开按钮 (icon=<MenuUnfoldOutlined />):
  expand() → sessionsCollapsed := false,启动 10s 倒计时
  ↓
期间发生任一交互 (onClick setCurrentSession / onMouseMove 列表容器 / onMouseEnter 任意 session 项):
  schedule() → clearTimeout + setTimeout 10s
  ↓
10s 无交互:
  sessionsCollapsed := true   (timer 回调)
```

### 6.5 关闭分屏

```
splitPaneOpen: true → false
  ↓
useSplitPaneSessionAutoCollapse effect cleanup:
  clearTimeout
  ↓
不再自动改 sessionsCollapsed;用户之前什么态就什么态。
```

## 7. 接口签名(参考实现)

```ts
// hooks/useSplitPaneCompactLock.ts
export function useSplitPaneCompactLock(): {
  /** true → AgentInputBox 必须隐藏 transcript-collapse 按钮 */
  isLocked: boolean
}

// hooks/useSplitPaneSessionAutoCollapse.ts
export function useSplitPaneSessionAutoCollapse(opts: {
  splitPaneOpen: boolean
  /** 默认 10_000,留作测试 override */
  timeoutMs?: number
}): {
  collapsed: boolean
  /** 用户点展开按钮调用:翻 false + 启动倒计时 */
  expand: () => void
  /** 用户在列表上有交互时调用,重置倒计时 */
  schedule: () => void
}
```

## 8. 测试

| 用例 | 文件 | 断言 |
|---|---|---|
| `useSplitPaneCompactLock`: splitPaneOpen false → true 时 transcriptCollapsed 变 true | `hooks/useSplitPaneCompactLock.test.ts`(新建) | 渲染 hook 后 `useAgentStore.getState().transcriptCollapsed === true` |
| splitPaneOpen true → false 时 transcriptCollapsed 不被回写(保留关闭瞬间值) | 同上 | 把 transcriptCollapsed 设为 false 后翻 splitPaneOpen = false,值仍是 false |
| `useSplitPaneSessionAutoCollapse`: splitPaneOpen true 立即 collapsed=true | `hooks/useSplitPaneSessionAutoCollapse.test.ts`(新建) | 渲染 hook 并传 `splitPaneOpen: true`,初始 `collapsed === true` |
| `expand()` 后 10s(测试用 fake timers `timeoutMs=50`)自动收回 | 同上 | expand → 推进 49ms 仍 false;推进 50ms → true |
| `schedule()` 重置倒计时 | 同上 | expand → 推进 30ms → schedule() → 推进 30ms 仍 false;再推进 30ms → true |
| 倒计时期间模拟 setCurrentSession / 鼠标移动 / hover session 项 → schedule 调用 → 重置 | 同上 | 显式调 schedule,验证 setTimeout 重置 |
| AgentInputBox: `splitPaneOpen=true` 时 transcript-collapse 按钮不存在 | `components/AgentInputBox.test.tsx` | `screen.queryByTestId('transcript-collapse-button') === null` |
| AgentInputBox: `splitPaneOpen=false` 时按钮存在且可点击 | 同上(已有测试) | 现有断言不变 |
| Agent: splitPaneOpen=true 时,sessionCollapsed 渲染宽度 = 40px(收起态) | `pages/Agent.test.tsx`(若存在) | 用 `getBoundingClientRect` 验宽;若测试覆盖不足,改为组件级 hook 测试 |

## 9. 边界与错误处理

| 场景 | 处理 |
|---|---|
| 用户在分屏态下用快捷键 / devtools 强行 setTranscriptCollapsed(false) | hook 监听 store,`splitPaneOpen===true` 时若 transcriptCollapsed 变 false → 立刻 setTranscriptCollapsed(true) 回写。无视觉闪烁(同步生效)。 |
| splitPaneOpen 在倒计时中途从 true 变 false | hook cleanup:clearTimeout,且**不**把 sessionsCollapsed 强制设回 true(沿用当前态)。 |
| 倒计时期间 unmount 组件(路由切换) | useEffect cleanup 清 setTimeout,无泄漏。 |
| 多个组件同时调 `expand()` | 幂等:setTimeout 每次 clearTimeout 后再 setTimeout,行为正确。 |
| 用户在分屏态点 transcript-collapse 按钮(devtools 注入 React 事件) | 按钮已不挂载,onClick 监听器不存在。 |
| splitPaneOpen 的 localStorage 与 useAgentStore.transcriptCollapsed 不在同一选项卡 | `useLocalStorageState` 自带 `zai-localstorage-sync` storage 事件,跨 tab 同步。本设计依赖这一已存在机制。 |

## 10. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 两个 hook 同时订阅 store + localStorage,首次渲染时 `splitPaneOpen=true` 但 `transcriptCollapsed` 还来不及被 effect 写入 → 一帧非紧凑态 | 把 "进入分屏立刻 lock" 写到 `useLocalStorageState` 的初始化阶段而非 effect:读 localStorage 时同步算 `effectiveCollapsed = splitPaneOpen || initialCollapsed`。但 transcriptCollapsed 不归 hook 管,hook 只能在 effect 写;若不想闪烁,在 MessageListView 渲染层用 `splitPaneOpen \|\| transcriptCollapsed` 派生 derivedCollapsed。本设计选后者,**不引入派生 derivedCollapsed**,因为一帧的非紧凑态在普通用户视角可忽略,且保持"transcriptCollapsed 单一真源"契约。 |
| 用户已经习惯 settings.outputStyle=compact 时 transcript 自动折叠的语义,本设计让分屏态"覆盖"settings 持久层,可能困惑 | hook 注释清楚 "分屏态是临时的 view-state override,不写 settings.json";关闭分屏后回归 settings 决定的初值(由 Layout hydrate 维护)。 |
| 把 `isLocked` 用 prop 透传给 AgentInputBox 会让 Agent.tsx 多 1-2 个 props | 方案 A 让 AgentInputBox 内部 hook 自取 `splitPaneOpen`,避免 props 污染。 |
| 多个 tab 同时打开 + storage 同步可能让 sessionCollapsed 抖动 | `useSplitPaneSessionAutoCollapse` 只在当前 tab 写 sessionsCollapsed;其它 tab 通过 storage 同步拿到 false → 不会启动自己的倒计时(倒计时由 hook 自己 setTimeout,不被 storage 事件触发)。理论上两 tab 都同时打开分屏 + 点开列表 → 两个倒计时独立各自 10s。可接受。 |

## 11. 文件清单

新增:
- `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts`
- `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.test.ts`
- `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts`
- `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts`

修改:
- `packages/zai/src/web/src/pages/Agent.tsx`(把 `useState` 替换为 hook,在 hover/onClick 处接 schedule)
- `packages/zai/src/web/src/components/AgentInputBox.tsx`(调用 `useSplitPaneCompactLock` + 条件渲染折叠按钮)

不变:
- `packages/zai/src/web/src/components/transcript/MessageListView.tsx`
- `packages/zai/src/web/src/store/useAgentStore.ts`
- `packages/zai/src/web/src/store/useAppStore.ts`
- `packages/zai/src/web/src/components/splitPane/*`(SplitPane 自身的 localStorage hook 不动)
