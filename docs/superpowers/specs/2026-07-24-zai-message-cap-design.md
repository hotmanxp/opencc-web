# zai 对话区消息上限 + 折叠还原 设计文档

- **状态**：待评审
- **日期**：2026-07-24
- **作者**：OpenCC brainstorming session
- **范围**：`packages/zai`（web SettingsDrawer + Agent.tsx + server routes + shared settings）

## 1. 背景与动机

zai 主对话区目前始终渲染 `useAgentStore.messages` 全量。单个长会话跑几十轮工具调用后，`messages.length` 会膨胀到上百条，导致：

1. 浏览器 DOM 节点过多，渲染/滚动卡顿；
2. 关键旧信息离用户视野越来越远，靠手动滚回顶难定位；
3. 移动端窄屏尤其敏感。

用户对"保留全部历史"和"我只想看最近 N 条"两种诉求都存在。开放一个 UI 设置项，让用户在长会话里把早期消息折叠到顶部、点浮按钮一键还原，可以同时满足两种诉求而不丢任何状态。

## 2. 决策摘要

| 决策 | 选择 |
|------|------|
| 设置项名 | `消息最大显示条数` |
| 字段 key | `maxVisibleMessages` |
| 默认值 | `20` |
| 类型 | `number`（带 min/max/step 的新 SettingsRow 子类型） |
| 设置分组 | 新增 `Display` 分组 |
| 持久化 | 写 `~/.zai/settings.json`（对齐 `outputStyle` 模式） |
| 隐藏方式 | 仅 UI 隐藏：`useMemo` 切 `visibleMessages = messages.slice(hiddenCount)`；store 全保留 |
| 浮按钮 | 顶部 sticky 居中 pill，显示"显示全部 (N 条隐藏)" |
| 点开重置 | 点开后仅当再次超过 limit 才自动重新隐藏 |

## 3. 架构总览

```
SettingsDrawer (web)
  └─ SettingsRow.kind='number' 新增
       └─ 输入框 + ± 按钮
            └─ onChange('maxVisibleMessages', N)
                 ├─ useAppStore.setMaxVisibleMessages(N)
                 └─ PUT /api/agent/settings/max-visible-messages { value: N }
                      └─ zaiSettingsStore → ~/.zai/settings.json

useAppStore.hydrate (Layout mount effect)
  └─ GET /api/agent/settings → maxVisibleMessages (default 20)

Agent.tsx render
  └─ messages, maxVisibleMessages, showAllMessages
       └─ useMemo:
            hiddenCount = max(0, messages.length - maxVisibleMessages)
            effectiveHidden = showAllMessages ? 0 : hiddenCount
            visibleMessages = messages.slice(effectiveHidden)
       └─ <MessageListView messages={visibleMessages} />
       └─ showPill (hiddenCount > 0 && !showAllMessages) → <ShowAllPill hiddenCount={hiddenCount} onClick={()=>setShowAllMessages(true)} />
            (sticky top:0 z-index:10, AntD Button pill)
       └─ useEffect: showAllMessages && hiddenCount > 0 → setShowAllMessages(false)
```

### 模块边界

| 文件 | 角色 |
|------|------|
| `packages/zai/src/shared/settings.ts` | `ZaiSettings.maxVisibleMessages?: number` + `BUILTIN_DEFAULT_SETTINGS.maxVisibleMessages: 20` |
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | 新增 `SettingsRow.kind:'number'` 子类型 + `SettingsList` 渲染 number 行（输入框 + ±） + 在 buildStaticSchema 中加 `Display` section + `handleChange` 写 store + PUT |
| `packages/zai/src/web/src/store/useAppStore.ts` | `maxVisibleMessages: number` + `setMaxVisibleMessages: (n:number)=>void` |
| `packages/zai/src/web/src/pages/Agent.tsx` | `useMemo` 算 `hiddenCount`/`visibleMessages`；本地 `showAllMessages` state；浮按钮 JSX |
| `packages/zai/src/server/routes/agentSettings.ts` | 新增 `PUT /max-visible-messages` handler（仿 `output-style` handler，clamp 到 `[1, 1000]`） |
| `packages/zai/src/server/services/zaiSettingsCache.ts` | 现有 GET 路由自动透传新字段（确认 `getCachedZaiSettings` 返回 `ZaiSettings` 全量） |

## 4. Schema 设计

### `ZaiSettings`（扩展）

```ts
export interface ZaiSettings {
  env?: Record<string, string>
  model?: string
  models?: ModelEntry[]
  defaultMode?: string
  outputStyle?: OutputStyle
  /** 主对话区最大渲染消息条数; 超过时 UI 折叠早期消息 + 顶部浮按钮一键还原. 默认 20. */
  maxVisibleMessages?: number
}

export const BUILTIN_DEFAULT_SETTINGS: ZaiSettings = {
  env: {},
  defaultMode: 'default',
  outputStyle: 'default',
  maxVisibleMessages: 20,
}
```

### `SettingsRow`（新增 number 子类型）

```ts
export type SettingsRow =
  | { key: string; label: string; kind: 'boolean'; value: boolean }
  | { key: string; label: string; kind: 'enum'; value: string; options: EnumOption[] }
  | {
      key: string
      label: string
      kind: 'number'
      value: number
      min?: number
      max?: number
      step?: number
    }
```

### `useAppStore` 字段

```ts
interface AppState {
  ...
  /** 主对话区最大渲染消息条数; 默认 20. Layout mount effect 用 GET /api/agent/settings 覆写. */
  maxVisibleMessages: number
  setMaxVisibleMessages: (n: number) => void
}
```

## 5. 组件设计

### `SettingsList` number 行渲染

抽屉当前每一行右侧只读渲染 `displayValue`。number 行需要交互：选中行进入编辑态后可输入数字或点 ± 增减。

阶段 1 最简实现 —— 不引入 AntD `InputNumber` 也避免新增键盘事件复杂度：

- 选中行（高亮）按 `Enter` → 进入编辑态（行右侧变成原生 `<input type="number" min={min} max={max} step={step}>`，自动 focus）
- 编辑态按 `Enter` 或失焦 → 提交 `onChange(row.key, parsedNumber)`
- 编辑态按 `Escape` → 退出编辑态保留旧值
- 右侧始终额外渲染两个小图标按钮 `−` / `+`（按 `step` 增减），鼠标点击直接 onClick

### `Agent.tsx` 浮按钮

`scrollContainerRef` 内顶部 `position: sticky; top: 0; z-index: 10`：

```tsx
{showPill && (
  <div style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
    <Button
      shape="round"
      size="small"
      icon={<UpOutlined />}
      onClick={() => setShowAllMessages(true)}
      data-testid="show-all-messages-pill"
    >
      显示全部 ({hiddenCount} 条隐藏)
    </Button>
  </div>
)}
```

`messages.length - maxVisibleMessages > 0` 时若用户先前点过浮按钮全量展示，需重新切回折叠态 —— 通过 `useEffect([hiddenCount, showAllMessages])` 检测并 reset `showAllMessages`。

## 6. Server API

### `PUT /api/agent/settings/max-visible-messages`

仿 `routes/agentSettings.ts` 的 `output-style` handler：

- 接受 `{ value: number }`
- `value = Math.max(1, Math.min(1000, Math.floor(Number(value))))` clamp
- 调 `zaiSettingsStore.writeSettings({ ...current, maxVisibleMessages: value })`
- 写盘失败 → 返 `500`，前端 `.catch(() => {})` 吞掉

### `GET /api/agent/settings`

当前路由已返整个 `ZaiSettings`。`maxVisibleMessages` 字段自动透传；前端 `Layout` mount effect 在 hydrate 时如果字段缺失则 fallback 到 `BUILTIN_DEFAULT_SETTINGS.maxVisibleMessages: 20`。

## 7. 数据流（端到端）

### `Agent.tsx` 派生逻辑

```ts
const maxVisibleMessages = useAppStore(s => s.maxVisibleMessages)
const [showAllMessages, setShowAllMessages] = useState(false)

// hiddenCount 不受 showAllMessages 影响,纯粹由 messages.length 与 limit 派生
const { hiddenCount, visibleMessages } = useMemo(() => {
  const hc = Math.max(0, messages.length - maxVisibleMessages)
  const eff = showAllMessages ? 0 : hc
  return { hiddenCount: hc, visibleMessages: messages.slice(eff) }
}, [messages, maxVisibleMessages, showAllMessages])

// 用户点开浮按钮后,新消息持续到达,直到 messages.length 再次超出 limit,
// 自动把 showAllMessages 重置为 false,pill 重新出现.
useEffect(() => {
  if (showAllMessages && hiddenCount > 0) {
    setShowAllMessages(false)
  }
}, [showAllMessages, hiddenCount])

const showPill = hiddenCount > 0 && !showAllMessages
```

### 端到端场景

| 步骤 | 状态变化 | UI 表现 |
|------|---------|--------|
| Layout mount | `useAppStore.maxVisibleMessages` hydrate (default 20) | — |
| 用户设置 50 | `setMaxVisibleMessages(50)` + PUT 写盘 | — |
| 80 条 messages, limit 50 | `hiddenCount=30`, `visibleMessages=messages.slice(30)` | 渲染后 50 条; pill 显示 "显示全部 (30 条隐藏)" |
| 用户点 pill | `setShowAllMessages(true)` → useMemo 重算 `visibleMessages` 全量 | 渲染 80 条; pill 消失 |
| 新消息进站 → 90 条 | `hiddenCount=40` 但 `showAllMessages=true` → 全量渲染 | pill 仍隐藏 |
| effect 触发 | `showAllMessages=false` | pill 显示 "显示全部 (40 条隐藏)",渲染后 50 条 |

## 8. 边界与错误处理

| 场景 | 行为 |
|------|------|
| `value` 是 `0` / 负数 / `NaN` | server 端 clamp `[1, 1000]`，UI 输入框 `min=1 max=1000` |
| `PUT` 写盘失败 | 前端 `.catch(() => {})` 吞；store 已立即生效，下次启动重新对齐磁盘 |
| `GET` 返回的 settings 无 `maxVisibleMessages` | hydrate 时 fallback `?? 20` |
| session 切换 | `showAllMessages` 是 local state 自动重置；`maxVisibleMessages` 来自 store 跨 session 持久 |
| streaming 期间 | `messages.length` 增长触发 useMemo 重算，浮按钮显隐自然切换，无竞态 |
| 用户输入非数字 / 清空 | 输入框 `onChange` 解析 `Number(value)`；`NaN` 时不调 `onChange`（保留旧值） |
| 用户输入超过 1000 | 输入框 `max=1000` 浏览器原生限制；service 也再 clamp 一次 |

## 9. 测试

### 单元测试

- `packages/zai/src/web/src/components/SettingsDrawer.test.tsx`（如不存在则新增）
  - 断言 `maxVisibleMessages` 行存在于 schema 中
  - number 行可编辑，断言 onChange 触发 setMaxVisibleMessages
  - Enter 提交数字 → store 更新 + PUT 请求发出
- `packages/zai/src/web/src/store/useAppStore.test.ts`
  - `setMaxVisibleMessages(50)` 后 state 更新
  - 默认值 === 20

### 集成测试

- `packages/zai/src/web/src/pages/Agent.test.tsx`（如不存在则新增）
  - mock 100 条 messages → `visibleMessages.length === 20` + 浮按钮显示文案 "显示全部 (80 条隐藏)"
  - 点击浮按钮 → `visibleMessages.length === 100` + 浮按钮消失
  - 再注入 5 条 messages → useEffect → `showAllMessages` 变 false → 浮按钮重新出现，文案 "显示全部 (85 条隐藏)"

### Server 测试

- `packages/zai/src/server/routes/agentSettings.test.ts`（如不存在则新增）
  - `PUT /max-visible-messages { value: 50 }` → 200 + settings.json 写入
  - `PUT /max-visible-messages { value: -1 }` → clamp 到 1
  - `PUT /max-visible-messages { value: 99999 }` → clamp 到 1000

## 10. 阶段 1 限制 / 不做

- 不做 store 层裁剪（保留所有状态便于会话刷新后恢复）
- 不做虚拟滚动（messages 上百正是阶段 1 想解决的渲染压力来源；阶段 1 只做 UI 折叠）
- 不做"按对话轮次"折叠（按 store 消息条目计，最简单直接）
- 不做"按消息类型过滤"折叠（统一 `messages.length`）
- 不做"点开后永久不隐藏直到刷新"（新消息超 limit 自动重新隐藏更符合用户直觉）