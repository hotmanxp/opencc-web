# Spec — zai Web UI 对话「本轮产物」块

- 日期：2026-09-24
- 状态：待实现
- 相关代码（现状）：
  - `packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx`（`parseFiles` :62、`FileCard` :75 —— 已有的「文件卡片 + 点击预览」先例）
  - `packages/zai/src/web/src/lib/openFilePath.ts`（`openFilePathPreview` :91、`resolveFilePath` :55、`FILE_PREVIEW_OPEN_EVENT` :21）
  - `packages/zai/src/web/src/components/markdown/FilePathChip.tsx`（`FilePathChipInner` :29 —— 预览 + 候选 picker + 右键菜单的既有实现）
  - `packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx`（预览落地组件）
  - `packages/zai/src/web/src/components/transcript/MessageListView.tsx`（`MessageListView` :52 —— expanded / collapsed 两分支）
  - `packages/zai/src/web/src/components/AgentConversation.tsx`（`visibleMessages` 裁剪 :46-63）
  - `packages/zai/src/web/src/store/useAgentStore.ts`（`AgentMessage` / `RuntimeEvent` :74-96、`loadTranscriptMessages` :465）
  - `packages/zai/src/web/src/hooks/useSubmitPrompt.ts`（`pushUserMsg` :47 —— `user.text` 的唯一写入点）
- 先例 spec：`docs/superpowers/specs/2026-08-20-display-files-tool-design.md`（DisplayFiles 工具，文件卡片列表 + 预览）

## 0. TL;DR

AI 每轮对话结束，在该轮消息段末尾渲染一个「本轮产物」块，列出**本轮生成和修改的文件**，点击任一行复用现有预览链路（`/api/fs/resolve` → `FilePreviewDrawer` / Desktop 预览窗）打开文件。

- **纯前端渲染期派生**，零后端改动、零 `zn-agent-core` 改动、不需要 `build:core`；
- 轮次以 `user.text` 切分（**不用 `turnIndex`**，后端恒为 0）；
- 已结束的轮次各自拥有一块，永久保留在 transcript 中；流式进行中的当前轮不显示；
- 块的内容**只含本轮**涉及的文件，不跨轮累加；
- 只覆盖主 transcript 的写入类工具（`Write` / `Edit` / `MultiEdit` / `NotebookEdit`），看不到 subagent 与 Bash 间接写入。

## 1. 动机

zai 的对话流里，「AI 改了哪些文件」目前只有一个入口：`DisplayFiles` 工具调用渲染出的文件卡片（`fileDisplay.tsx`）。这个入口有两个问题：

1. **依赖模型主动调用** —— 模型不调 `DisplayFiles` 就没有任何产物视图，实际使用中触发率不可控；
2. **只覆盖被显式展示的文件** —— 与「本轮实际动过的文件」不构成保证关系。

用户需求（原话）：**AI 每轮对话结束，UI 上渲染本轮产物块（给出本轮对话中生成和修改的文件列表），列表有预览操作。点击复用现有的预览能力。**

每轮结束自动结算一份产物清单，用户不必翻找散落在 transcript 里的 `Edit` / `Write` 工具调用，也不必指望模型记得调 `DisplayFiles`。

## 2. 决策记录

| # | 决策 | 取值 | 依据 |
|---|---|---|---|
| D1 | 数据来源 | 纯前端扫 `messages`（`AgentMessage[]`） | 零后端/零 core 改动；历史回放与实时流形态等价，天然一致 |
| D2 | 轮次边界 | `type === 'user.text'` 开启一轮 | 每轮恰好一条（`AgentInputBox.tsx:1376` 的 `pushUserMsg(text, false)`；rendered prompt 走 isMeta 落盘不上屏）；后端 `turnIndex` 恒为 0 不可用 |
| D3 | 渲染范围 | 已结束的轮次各自一块，保留原位 | 浏览历史时每轮可见；不因新轮开始而消失 |
| D4 | 结算时机 | 轮结束后才出现，流式中不显示 | 避免文件列表边跑边跳 |
| D5 | 块内容 | 只含本轮文件，不跨轮累加 | 用户明确要求 |
| D6 | 提取范围 | 写入类工具显式白名单 | 泛化取 `path` 会把 `Read` / `Grep` 误判成产物 |
| D7 | 预览复用 | 抽 `useFilePathActions` hook 供 chip 与产物行共用 | 「复用现有预览能力」最完整落法；避免两套预览语义 |
| D8 | 块形态 | 默认展开，`> 8` 个文件时默认折叠 | 用户选定 |
| D9 | 持久化 | 不落 transcript，纯渲染期派生 | 与 D1 同源，无一致性风险 |

## 3. 架构与数据流

```
messages[]  (useAgentStore.messages,SSE 实时流与历史回放同一形态)
   │
   ├─ deriveTurnArtifacts(messages)        ← 新增纯函数,无副作用、可单测
   │     → TurnArtifacts[] { endIndex, files: ArtifactFile[] }
   │
   ├─ MessageListView 渲染:在每轮「锚点消息」之后插入 <TurnArtifactsBlock>
   │
   └─ 点行 → useFilePathActions(path).preview()
                → openFilePathPreview → /api/fs/resolve
                → FilePreviewDrawer(/agent、/m) 或 Desktop 预览窗(/desktop)
```

### 3.1 轮次切分

遍历 `messages`，遇 `type === 'user.text'` 即开新轮；区间 = 该 `user.text` 之后到下一个 `user.text` 之前（或数组末尾）。

**不使用 `turnIndex`** —— `useAgentStore.ts:309-315` 注释写明后端 `wrapWithZaiMeta` 被逐事件调用导致内部计数器每次归零，`turnIndex` 恒为 0。

`loadTranscriptMessages`（`useAgentStore.ts:484`、`513`）已过滤 `isMeta === true` 的系统注入 user 消息，因此能被切到的 `user.text` 都是真实用户轮次，无需额外判据。

### 3.2 结算时机

一个轮次渲染产物块的条件（两条满足其一）：

1. 该轮之后存在下一条 `user.text`（即已被下一轮顶掉）；或
2. 它是最后一轮，且 `status !== 'streaming'`（`idle` / `aborted` / `error` 都算结束）。

因此：流式进行中不出块；轮一结束立刻出现；此后永久留在原位。

### 3.3 产物提取

在本轮区间内扫描 `type` 为 `tool_use:start` / `tool_use:done` / `tool_use:error` 的消息，按白名单取路径：

| 工具 | 路径字段 | 徽标 |
|---|---|---|
| `Write` | `input.file_path` | 写入 |
| `Edit` | `input.file_path` | 编辑 |
| `MultiEdit` | `input.file_path` | 编辑 |
| `NotebookEdit` | `input.notebook_path` | 编辑 |

白名单集中为一个常量表 `ARTIFACT_WRITE_TOOLS: Record<string, { label: string; pathKey: string }>`，后续新增写入类工具改一行。

**显式白名单而非泛化取 `path`/`file_path`**：`Read` / `Grep` / `Glob` 也有 `path` 字段，泛化会把这些只读调用误报成产物。

工具的三个状态（`start` / `done` / `error`）都计入 —— `tool_use:start` 携带 `input`，`done` / `error` 是同一 entry 被后续 tool_result 覆盖后的形态（`useAgentStore.ts:518-527`），三者都保留 `name` + `input`。

### 3.4 去重、徽标与顺序

- 按 `input` 里的路径字符串**原样**去重，不做 `realpath` / 路径规范化 —— 解析交给点击时的 `/api/fs/resolve`（它已有多级回退 + basename 模糊搜，见 `openFilePath.ts:1-16` 注释）；
- 顺序 = 首次出现顺序（时间顺序）；
- 同一路径被反复修改合并为一行，`count` 累加，角标显示 `×N`（仅 `N > 1` 时）；
- 徽标规则：**该路径在本轮出现过 `Write` → 「写入」；否则「编辑」**。`count` 独立于徽标累加。

### 3.5 锚点与消息裁剪

`AgentConversation.tsx:46-63` 会把 `messages` 按 `maxVisibleMessages` 裁成 `visibleMessages` 再传给 `MessageListView`。产物块锚定在「该轮最后一条**可见**消息」之后渲染：

- 锚点消息在 `visibleMessages` 里 → 正常渲染；
- 锚点被裁掉 → 整块不渲染。

这样产物块随它所属的轮次一起进出可视区，不需要额外的裁剪联动逻辑。compact 模式下的保底规则（`AgentConversation.tsx:50-61` 保证最后一条 `assistant.text` 可见）意味着最新一轮永远有锚点。

## 4. 组件设计

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `packages/zai/src/web/src/components/transcript/deriveTurnArtifacts.ts` | 纯函数 + 类型 |
| `packages/zai/src/web/src/components/transcript/TurnArtifactsBlock.tsx` | 产物块组件 |
| `packages/zai/src/web/src/hooks/useFilePathActions.ts` | 从 `FilePathChip` 抽出的预览动作复用层 |

`deriveTurnArtifacts.ts` 导出：

```ts
export interface ArtifactFile {
  /** 工具输入里的路径原文,未做规范化 */
  path: string
  /** 展示徽标文案: '写入' | '编辑' */
  label: string
  /** 本轮出现次数(显示 ×N,仅 N > 1) */
  count: number
  /** 该路径本轮是否出现过 Write —— 驱动徽标配色(写入绿 / 编辑紫) */
  written: boolean
}

export interface TurnArtifacts {
  /** 该轮最后一条消息在传入数组中的下标(锚点) */
  endIndex: number
  /** 该轮首条 user.text 的 eventId,用作 React key */
  turnKey: string
  files: ArtifactFile[]
}

/** 只返回 files.length > 0 且已结束的轮次 */
export function deriveTurnArtifacts(
  messages: AgentMessage[],
  opts: { status: AgentStatus },
): TurnArtifacts[]
```

`useFilePathActions.ts` 从 `FilePathChip.tsx:29-117` 提取，返回：

```ts
{
  preview: () => Promise<void>       // resolve → 打开 / 多候选弹 picker / !ok → message.error
  pickerOpen: boolean
  pickerCandidates: FsResolveCandidate[]
  setPickerOpen: (open: boolean) => void
  pickCandidate: (c: FsResolveCandidate) => void
  menuItems: MenuProps['items']      // 预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径
}
```

`FilePathChip` 改为调用该 hook，自身只保留 chip 渲染与 `Popover` / `Dropdown` 外壳 —— 行为与抽取前逐位一致（含 `e.stopPropagation()`、`busy` 去抖、候选弹层的开合语义）。

### 4.2 改动文件

| 文件 | 改动 |
|---|---|
| `web/src/components/markdown/FilePathChip.tsx` | 动作逻辑改调 `useFilePathActions`，渲染分支不变 |
| `web/src/components/transcript/MessageListView.tsx` | expanded 分支：`visibleMessages.map` 时若 `idx` 是某轮的 `endIndex` 则在其后追加块；collapsed 分支：`nodes.map` 后按 node 的 `endIndex` 匹配同样追加 |

`MessageListView` 两分支共用一份 `useMemo(() => deriveTurnArtifacts(visibleMessages, { status }), [visibleMessages, status])`，在渲染时按 `endIndex` 查表插入。React key 用 `turnKey`（该轮首条 `user.text` 的 `eventId`），保证：新消息到达不会导致已有块的折叠态被重置。

### 4.3 视觉

全 Tailwind utility class + 主题 CSS 变量，**零新增 `style={{...}}`**。

```
✦ 本轮产物 · 3 个文件                                    ⌄
  📄 SettingsDrawer.tsx   src/web/src/components/…   [编辑 ×3]
  📄 zaiBuddy.ts          src/web/src/components/…   [写入]
```

| 部位 | 类名要点 |
|---|---|
| 容器 | `mt-2 mb-1 rounded-md border border-[var(--border-light)] bg-[var(--bg-faint-05)] px-3 py-2` |
| 块头 | `flex items-center gap-1.5 text-xs text-[var(--text-dim-70)] cursor-pointer select-none`，左 sparkle 图标右 chevron |
| 行 | 整行 `<button type="button">`，`flex w-full items-center gap-2 py-1 rounded text-left hover:bg-[var(--bg-faint-05)]` |
| 主文本 | `text-xs text-[var(--text-primary)] truncate flex-1`（basename） |
| 副文本 | `text-[11px] text-[var(--text-dim-45)] truncate max-w-[40%]`（路径原文），`title` 给全路径 |
| 徽标 | `text-[10px] px-1.5 rounded border`，写入走绿系 / 编辑走紫系（呼应 chip 的 `#a78bfa`） |

### 4.4 交互

- 块头点击 → 展开 / 收起；默认展开，`files.length > 8` 时初始折叠。折叠态是组件内部 `useState`。
- 行点击 → `preview()`，命中多候选弹 picker，失败 `message.error`。
- 行右键 → 与 chip 完全相同的菜单项：预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径。
- 移动端 `/m` 与 Desktop 的 Agent 浮窗走同一个 `MessageListView`，自动生效。移动端右键不可达，行点击（预览）已覆盖主路径。

## 5. 边界与异常

| 场景 | 行为 |
|---|---|
| 路径 resolve 失败 | `message.error(result.error)`，与 Markdown chip 一致 |
| 命中多候选 | 弹候选选择器，选中项打开预览 |
| 文件已被删除 / 移动 | 点击后由 `FilePreviewDrawer` 显示 `ENOENT`，列表内不做预检 |
| 相对路径 | 不做 `realpath`，原样交给 `/api/fs/resolve` |
| 同一路径被反复修改 | 合并一行，`count` 累加，徽标按 §3.4 规则 |
| 轮次被中断（`aborted`）/ 报错（`error`） | 已产生的产物照常渲染 |
| 锚点消息被 `maxVisibleMessages` 裁掉 | 整块不渲染 |
| 会话压缩 / `/clear` | 老消息从 `messages` 移除，对应产物块自然消失（派生方案的自然后果） |
| 切换会话 | 派生自当前 `messages`，天然隔离 |
| 历史回放 / 刷新页面 | 与实时流同一份 `messages`，结果一致 |

## 6. 非目标（v1 明确不做）

1. 不统计 subagent（`Agent` 工具）内部改动、Bash 间接写入（`sed -i` / 输出重定向）、用户在外部编辑器里的改动 —— 纯前端方案的固有代价；
2. 不做「查看本轮 diff」入口，点击只预览文件**当前**内容；
3. 不做「新增 / 删除」标记（无法从 tool 输入可靠判断 `Write` 是新建还是覆盖）；
4. 不做跨轮累计的「本次会话产物总览」；
5. 不持久化到 transcript；
6. 不做批量操作（全量复制路径 / 全部打开）。

## 7. 测试

| 层 | 用例 |
|---|---|
| `deriveTurnArtifacts` 单测 | 轮次切分（多轮 / 单轮 / 无 user.text）；白名单过滤（`Read`/`Grep` 不计入）；去重与顺序；`count` 与徽标归并（Write 优先）；空轮不产出；未结束轮不产出（`status === 'streaming'`）；`error` 轮照常产出 |
| `TurnArtifactsBlock` 组件测 | 点击行调 `openFilePathPreview`；多候选弹 picker；`> 8` 默认折叠、块头仍显示数量；右键菜单 4 项；resolve 失败 `message.error` |
| `FilePathChip` 回归测 | 抽取 hook 后 picker 开合、`multiple` 分支、右键动作与抽取前一致（该类当前无测试，本次补齐） |
| `MessageListView` 回归 | expanded / collapsed 两分支都插入产物块；既有断言不破；锚点被裁时不渲染 |

按 `AGENTS.md`「页面样式改动不跑单测」：视觉与观感不靠 vitest 盖，作为实现后的验收步骤走真实浏览器 —— `pnpm --filter @zn-ai/zai dev -- --port 8102` 起服务，ego-browser 打开 `/agent` 跑一轮真实对话，度量产物块的 rect / `getComputedStyle` 并截图对比。

## 8. 风险

| 风险 | 处置 |
|---|---|
| 抽取 `useFilePathActions` 影响 Markdown 路径 chip | 该类当前无单测，本次补齐 picker / 右键行为的回归测试；抽取时逐位保留 `stopPropagation`、`busy` 去抖、`Popover` 开合语义 |
| 每轮渲染都重扫 `messages` | `useMemo` 按 `visibleMessages` 引用缓存，只在其变化（新事件到达）时重算 |
| collapsed 视图插入点计算错误导致节点错位 | 按 node 的 `endIndex` 精确匹配，匹配不到就不插入（宁可不显示也不错位）；回归测试覆盖两分支 |
| 长会话产生大量产物块影响观感 | `> 8` 个文件默认折叠；块本身高度受控（一行块头 + 最多 8 行） |