# zai Agent 输入时整页重渲染 — 设计规格

> 文档版本: 1.0 · 2026-07-18 · 状态: 设计已敲定, 待用户 review

## 0. 背景

zai Web Agent 页面 (`packages/zai/src/web/src/pages/Agent.tsx`) 在 transcript 较长时, 用户在底部 TextArea 输入字符明显卡顿 (单次按键到下一次 commit 完成 ~1240 ms), 体感"打字很缓慢"。

### 0.1 实测数据

通过 React DevTools global hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`) 在 18 条消息 + 多段代码块 + 思考块的真实 transcript 上统计一次 keystroke 触发的重渲染:

| 指标 | 实测值 |
|------|--------|
| 单次按键触发 React commit 数 | **1** |
| 单次 commit 重新执行的 FunctionComponent | **18× ThinkingBlock + 18× Markdown + 74× SyntaxHighlighter + 32× DomWrapper + 20× EllipsisTooltip + … (共 223 个业务组件)** |
| 顶层 `Agent` 自身是否 re-render | **是** |
| 单次按键耗时 (input 到 idle callback) | **~1240 ms** |

空消息时单次 commit 也涉及 ~84 个 fiber, 说明性能问题不是"消息多了才出现", 而是"整页没有为输入优化过"。

### 0.2 根因 (按影响排序)

1. **`Agent` 是单文件巨组件 (2127 行)**, `input` 是它自身的 `useState` (Agent.tsx:1053), 任何 keystroke → `setInput` → `Agent` 整体 re-render。
2. **`useAgentStore()` 无 selector** (Agent.tsx:1026-1046), 一次性 destructure 21 个字段 (`messages / status / cwd / sessions / sessionId / todosBySession / activeSessionId / stop / clearMessages / loadSessions / setCurrentSession / loadTranscript / createNewSession / deleteSession / pendingAsk / setAskAnswer / setAskNotes / submitAsk / rejectAsk`), 加上后面 `useAgentStore(s => s.patchSessionMode)`。store 任何字段变化都让 Agent re-render; 尤其 `messages` 数组在流式期间每次 delta 都换引用。
3. **消息列表无 memo** (Agent.tsx:1852-1872): `messages.map((msg, idx) => <MessageBubble … />)`, `MessageBubble` (766-1023) 自身裸函数组件, 每次 Agent render 都全量重渲染所有消息。
4. **`MessageBubble` 内部四类组件 (`MarkdownText` / `StreamingMarkdown` / `ThinkingBlock` / `ToolCallBlock`)** 全部裸函数组件, 没用 `React.memo`。
5. **`ReactMarkdown` + `react-syntax-highlighter` 每次 render 全跑**: unified pipeline 解析 + tokenize + 上色。SyntaxHighlighter 单次 commit 出现 74 次, 是耗时大头。
6. **`splitMarkdownOnIncomplete` / `linkifyText`** 在 `MessageBubble` 每次 render 都对每条消息跑一遍字符串处理。`linkify` 已经在上一轮 (2026-07-11) 引入, 没有 memo。

## 1. 方案

四个修改点, 按收益/工作量排序:

### M1. 输入框拆为独立子组件 `<AgentInputBox>`

把 `input` / `attachments` / `showSkillMenu` / `filteredSlash` / `slashItems` / 全部 slash 相关 state + `handleSend` / `handleKeyDown` / `handlePaste` / `handleDrop` / `handleFilePick` / `addAttachments` / `removeAttachment` / `selectSlashItem` / `textareaRef` 移出 `Agent`, 封装到新组件 `packages/zai/src/web/src/components/AgentInputBox.tsx`。

该组件内部:
- 自己用 `useAgentStore(s => s.sessionId)` 等细粒度 selector 取需要的 store 字段。
- 自己管 `useState(input)` / `useState(attachments)` / 三个 slash menu state。
- 自己处理 paste / drop / file pick / send / slash command 执行。
- `onSent` callback (无参) 通知外层 (外层无操作也行 — 外层本来不依赖 `input`)。
- 用 `React.memo` 包装。

效果: 任何 keystroke 只触发 `AgentInputBox` 内部的 commit, `Agent` 主体 (会话侧栏 + 消息列表 + 状态栏 + 底栏) 不再 re-render。

### M2. `Agent` 主组件用细粒度 store selector

把 `const { … } = useAgentStore()` (Agent.tsx:1026-1046) 拆为单独 selector 调用:

| 字段 | selector |
|------|----------|
| `messages` | `useAgentStore(s => s.messages)` |
| `status` | `useAgentStore(s => s.status)` |
| `cwd` | `useAgentStore(s => s.cwd)` |
| `sessions` | `useAgentStore(s => s.sessions)` |
| `sessionId` | `useAgentStore(s => s.sessionId)` |
| `todosBySession` | `useAgentStore(s => s.todosBySession)` |
| `activeSessionId` | `useAgentStore(s => s.activeSessionId)` |
| `pendingAsk` | `useAgentStore(s => s.pendingAsk)` |
| `stop` | `useAgentStore(s => s.stop)` |
| `clearMessages` | `useAgentStore(s => s.clearMessages)` |
| `loadSessions` | `useAgentStore(s => s.loadSessions)` |
| `setCurrentSession` | `useAgentStore(s => s.setCurrentSession)` |
| `loadTranscript` | `useAgentStore(s => s.loadTranscript)` |
| `createNewSession` | `useAgentStore(s => s.createNewSession)` |
| `deleteSession` | `useAgentStore(s => s.deleteSession)` |
| `setAskAnswer` | `useAgentStore(s => s.setAskAnswer)` |
| `setAskNotes` | `useAgentStore(s => s.setAskNotes)` |
| `submitAsk` | `useAgentStore(s => s.submitAsk)` |
| `rejectAsk` | `useAgentStore(s => s.rejectAsk)` |
| `patchSessionMode` | 已有 (1049) |

**收益**: zustand 默认用 `Object.is` 比较 selector 返回值, 单字段引用未变就不触发 re-render。原来 21 字段任何变化都让 Agent re-render, 改后 `messages` 数组引用变才让 Agent re-render (这本来就是合理的, 因为我们要把消息列表展示出来)。

**约束**:
- `setAskAnswer` / `setAskNotes` 还要在 `QuestionCard` 子树里使用 — 通过 props 传入, 不影响 store selector 形式。
- selector 用裸箭头函数会导致 zustand 每次返回新函数引用, 触发不必要的 store 订阅重建。**约定**: selector 在组件体外用 `useShallow` 或者写成 `useAgentStore(s => s.x)` 单字段形式 (单字段返回基本类型或稳定引用, 无需 `useShallow`); 只有多字段合并返回时用 `useShallow` (zustand 自带)。本改造全部为单字段 selector, **不需要** 引入 `useShallow`。

### M3. `MessageBubble` 与三个内部组件加 `React.memo`

修改:
- `MessageBubble` (Agent.tsx:766): `const MessageBubble = React.memo(function MessageBubble({ msg, streaming }) { … });`
- `MarkdownText` (Agent.tsx:232): `const MarkdownText = React.memo(function MarkdownText({ text }) { … });`
- `StreamingMarkdown` (Agent.tsx:257): `const StreamingMarkdown = React.memo(function StreamingMarkdown({ text }) { … });`
- `ThinkingBlock` (Agent.tsx:313): `const ThinkingBlock = React.memo(function ThinkingBlock({ text, streaming }) { … });`
- `ToolCallBlock` (Agent.tsx:527): `const ToolCallBlock = React.memo(function ToolCallBlock({ msg }) { … });`
- 新组件 `AgentInputBox` (M1): `React.memo` 包装。

**关键 prop 稳定性**:
- `msg` 由 store 引用稳定性保证 (每条消息只 upsert 一次, eventId 是稳定 key)。
- `streaming` 在 `Agent.tsx:1867-1869` 通过 `status === "streaming" && idx === messages.length - 1` 计算, 是布尔值, 变化频率低 (只在 streaming 开始/结束时切换); 即使值变, 也只有那条对应消息的 `MessageBubble` 需要 re-render。

### M4. `messages.map` 容器加 `useMemo`

在 `Agent` 主组件里:

```tsx
const messageList = useMemo(
  () => messages.map((msg, idx) => { /* 原 .map body */ }),
  [messages, status], // status 影响最后一条 streaming 判定
);
```

**为什么 `status` 在依赖里**: `streaming={status === "streaming" && idx === messages.length - 1}` 内联了 `status`, 改用 prop 后 (可选优化) 也可以; 现阶段直接 `useMemo([messages, status])` 最安全。

效果: `messages` 引用未变 (例如只是 `cwd` 改变) 时, `messageList` 保持同一个数组引用, React 不会 reconcile 列表项 → `MessageBubble.memo` 直接命中短路返回。

## 2. 文件改动

### 2.1 新建 `packages/zai/src/web/src/components/AgentInputBox.tsx`

把以下逻辑移出 `Agent.tsx`, 封装成 `AgentInputBox`:

- `useState` 全部本地: `input` / `attachments` / `slashItems` / `showSkillMenu` / `skillMenuIdx` / `skillFilter`
- `useRef`: `fileInputRef` / `textareaRef` / `textAreaRef` / `skillMenuRef`
- `useEffect`: `attachments` unmount revoke / `slash` 初次加载 / `showSkillMenu` 外部点击关闭 / 状态切回非 streaming 时 refocus
- `useMemo`: `filteredSlash` + `fuzzyMatch`
- 函数: `selectSlashItem` / `addAttachments` / `removeAttachment` / `handlePaste` / `handleDrop` / `handleFilePick` / `postPromptToLLM` / `handleSend` / `handleKeyDown`
- JSX: `<div onDrop onDragOver>` 包裹 + `<TextArea>` + slash autocomplete dropdown

从外部取:
- `useAgentStore` selector: `status` / `sessionId` / `activeSessionId` / `pendingAsk`
- `useAppStore`: `instanceContext` (cwdName / branch, 给 `ModeStatusButton` 之外无依赖, 可不取; 仅 input 自身不依赖 cwd)
- antd 主题: `theme.useToken()` (用于 slash menu 颜色 — 当前没用 token, 移过去也不依赖)
- props: 不需要从 Agent 传入任何回调 (input 自己走 store.send / postPromptToLLM)。

### 2.2 修改 `packages/zai/src/web/src/pages/Agent.tsx`

**删除**: 上面 §2.1 列出的全部本地 state / ref / handler / JSX 块 (~600 行)。

**改 store 调用**: §1.M2 列的 20 个 selector 替换原有 destructure。

**加 memo**: §1.M3 列 5 个组件加 `React.memo`。

**加 useMemo**: §1.M4 列 `messageList`。

**JSX 替换**: 把 `<div onDrop onDragOver><TextArea ... /></div>` 整块换成 `<AgentInputBox />`。

### 2.3 不动

- `useAgentStore` 接口不动 (`AgentMessage` / `AgentStatus` 类型不变)。
- `MessageBubble` / `MarkdownText` / `StreamingMarkdown` / `ThinkingBlock` / `ToolCallBlock` / `DiffBlock` / `TodoZone` / `QuestionCard` / `TaskDock` / `TaskDrawer` / `TaskDrawer.test.tsx` / 其他组件逻辑不动, 只在函数声明处加 `React.memo`。
- 后端 / SSE / store reducer 不动。
- `agent.tsx` 里 `<AgentInputBox />` 的位置紧贴原来 TextArea 在状态栏下方, 不动外层 layout。
- `markdownComponents` 模块级 const 不动 (已经是稳定的, 不需要 memo)。
- 不引入 `useShallow` / `react-window` / `react-virtual` 等新依赖。

## 3. 验收标准

### 3.1 功能不变 (回归)

- [ ] 会话侧栏展开/收起、创建/删除/切换会话、permission mode cycle 全部工作不变。
- [ ] 文本输入、Enter 发送、Shift+Enter 换行、slash autocomplete (`/` 弹出、方向键 + Tab + Enter 选择、Escape 关闭)、粘贴图片、拖拽图片、文件选择按钮, 全部不变。
- [ ] 消息流式期间 TextArea disabled、status 切回非 streaming 时 refocus 不变。
- [ ] QuestionCard 在 store `pendingAsk` 时正常出现。
- [ ] ModeStatusButton / ModelStatusButton / ConversationInfoButton / TaskDock / TaskDrawer 行为不变。

### 3.2 性能 (验收)

- **空消息 transcript**: 单次按键 commit 只影响输入子树, `Agent` 自身不 re-render。`<Agent>` 的 fiber 不出现在 commit's PerformedWork 集合里。
- **18 条消息 transcript**: 单次按键 commit 只影响输入子树; 消息列表 0 个 MessageBubble 被 re-render; SyntaxHighlighter / Markdown / ThinkingBlock 都不再出现。
- **目标指标**: 单次 keystroke input→idle ≤ 60ms (从 1240ms 起步)。回归到该值即视为通过。
- **验证方式**: 复用本次实测用的 `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` hook, 在 `pnpm dev` 起来后跑同样的 `evaluate_script` 序列, 对比修复前后 `lastCommit` 里的业务组件列表。实测命令片段:

  ```js
  // (a) 安装 hook (与本次诊断用同一段)
  window.__zaiAllCommits = [];
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  hook.onCommitFiberRoot = (renderer, root) => { /* walk fiber, push PerformedWork names */ };

  // (b) 模拟一次 keystroke
  const ta = document.querySelector('textarea.zai-agent-textarea') || document.querySelector('textarea');
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value + 'x');
  ta.dispatchEvent(new Event('input', { bubbles: true }));

  // (c) idle 后读 commit
  await new Promise(r => requestIdleCallback(r));
  console.log(window.__zaiAllCommits);

  // (d) 单次耗时
  const t0 = performance.now();
  setter.call(ta, ta.value + 'x'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => requestIdleCallback(r));
  console.log('keystroke ms:', performance.now() - t0);
  ```

  通过条件: `lastCommit` 不含 `MessageBubble / Markdown / ThinkingBlock / ToolCallBlock / SyntaxHighlighter` 任何一个; `keystroke ms` ≤ 60。

### 3.3 测试

- 不引入新测试。MessageBubble / ToolCallBlock 现有 vitest 是渲染测试, 与本次重构正交 (本次仅加 memo 包装, 不改 props shape)。
- 验证以 dev mode + chrome-devtools 实测为准。

## 4. 风险与边界

- **拆分后组件通信**: `AgentInputBox` 不再依赖 `Agent` 的任何 state, 全部本地 + store。意味着 `Agent` 不能用 `ref` / callback 触发输入区操作 — 但 codebase 现有 grep 没发现这种用法 (Agent 不向输入区写值, 只有 `selectSlashItem` 的 `setInput` 是输入区自己的事)。
- **首次输入 focus**: 现在的 `useEffect` 监听 status 变化在 status 切回非 streaming 时 refocus 输入框 (Agent.tsx:1158-1164)。这一段跟 `handleSend` 关系紧密, 搬到 `AgentInputBox` 时一并搬过去。
- **`useAgentStore.getState()` 透传**: `handleSend` 中多处用 `useAgentStore.getState()` 拿瞬时值 (例如 `loadSessions`), 这部分与 selector 改造正交, 保留原写法。
- **`flushSync`**: `useAgentStore` 已经在多处用 `flushSync` (用于把 streaming 同步落到 store), 与 React 18 batching 兼容, 不影响本次重构。
- **`messages` 引用变化频率**: 流式期间每个 delta 都通过 `applySessionEvent` 触发 `messages` 引用变更, `Agent` 仍会 re-render。但因为 M3 + M4, 整个 list 内部各 `MessageBubble` 的 `msg` 引用未变, React 会跳过 reconcile, 只更新 list 的最后一项 (那条正在增长的 assistant.text)。这条最后一项内容是 streaming 文本, 必然要 render, 无法避免 — 但 commit 范围从 223 个业务组件收敛到 ~1 个。