# 移动端「常用指令」Drawer 设计

> 状态: ✅ Approved (brainstorming 通过)
> 日期: 2026-07-26
> 范围: `packages/zai/src/web/src/` (前端)

## 1. 背景

移动端 (`<768px`) 用户无法访问桌面端 BashTab 分屏、slash 命令补全 (输入 `/` 弹出的菜单) 在软键盘上体验差、AgentInputBox 现有工具栏 (`share` / `settings` / `repair` / 分屏 toggle`) 在移动端全部隐藏后,只剩 [图片上传] 和 [会话信息] 两个按钮,缺少"快速发起任务"的入口。

目标:在移动端 AgentInputBox 工具栏加一个 [⚡] 按钮,点击后右侧弹出 Drawer,内含两类快捷入口:
- **快捷 Bash**:调用现有 `/api/bash/repl/:sid/exec` 接口直接执行 `useBashRepl.topCommands` (全局 top10) 中的命令。
- **常用指令**:用户保存的纯文本片段,点击即以"用户消息"形式提交到当前对话,触发 AI Agent 继续工作。

## 2. 目标 & 非目标

**目标**

1. 移动端一键触达高频 bash 命令和自定义 prompt 片段。
2. 不新增 server endpoint,不破坏 BashTab、slash 命令补全、`/agent/prompt` 既有契约。
3. 自定义 prompt 片段用 `localStorage` 持久化,跨会话、跨刷新、跨 tab 同步 (走既有 `zai-localstorage-sync` 自定义事件)。
4. UI 风格与现有 `MobileSessionDrawer` 一致 (AntD Drawer + 自定义 header)。

**非目标 (YAGNI)**

- 不实现 prompt 模板占位符 (`{{input}}`)。
- 不实现指令分组 / 标签 / 搜索。
- 不实现云端同步 (用户级账号体系)。
- 桌面端不显示该按钮和 Drawer (避免与 BashTab、slash 补全重复)。
- 不支持 bash 输出查看 (执行即关闭,需查看输出走 BashTab)。

## 3. 架构

### 3.1 新增文件

| 路径 | 职责 |
|---|---|
| `packages/zai/src/web/src/hooks/useQuickPrompts.ts` | localStorage 读写、add / remove / clear、dedup、容量上限、预填示例种子 |
| `packages/zai/src/web/src/hooks/useSubmitPrompt.ts` | 把 `AgentInputBox.tsx` 内联 `postPromptToLLM` + `pushUserMsg` 抽出,供 Drawer 与 InputBox 复用 |
| `packages/zai/src/web/src/components/MobileQuickDrawer.tsx` | 受控 Drawer 组件,内部 Tab 切换、Bash 列表、Prompt 列表、增删 UI |

### 3.2 修改文件

| 路径 | 修改 |
|---|---|
| `packages/zai/src/web/src/components/AgentInputBox.tsx` | 1) 状态栏最左端新增 [⚡] 按钮 (`AppstoreAddOutlined`),仅 `isMobile` 渲染;2) 把 `postPromptToLLM` / `pushUserMsg` 替换为 `useSubmitPrompt()` hook 调用;3) 新增局部 state `quickDrawerOpen` + 回调传给父级 |
| `packages/zai/src/web/src/pages/MobileAgent.tsx` | 挂载 `<MobileQuickDrawer open={quickDrawerOpen} onClose={...} />`,与 MobileSessionDrawer / TaskDrawer 同级;新增受控 state `quickDrawerOpen` (也可以让 AgentInputBox 通过 props 透传 — 见 §5.3) |
| `packages/zai/src/web/src/components/splitPane/shared.ts` | `STORAGE_KEYS` 新增 `quickPrompts: 'zai.quickPrompts.v1'` |

## 4. 数据模型

```ts
// packages/zai/src/web/src/hooks/useQuickPrompts.ts
export interface QuickPrompt {
  id: string        // crypto.randomUUID(),dedup / 删除键
  text: string      // 1..200 字符,前后 trim
  createdAt: number // Date.now(),排序 / 容量截断用
}

const MAX_PROMPTS = 50  // 防 localStorage 配额滥用
const MIN_TEXT = 1
const MAX_TEXT = 200

const DEFAULT_QUICK_PROMPTS_SEED: ReadonlyArray<{ text: string }> = [
  { text: '优化这段代码的可读性与性能' },
  { text: '为这段函数补上单元测试' },
  { text: '解释这个错误的根因,并给出修复建议' },
]
```

**localStorage key**: `zai.quickPrompts.v1` (新命名空间,避开既有 `zai.splitPane.*` / `zai.app.*` 前缀)。

**序列化**: `JSON.stringify(QuickPrompt[])`,反序列化失败 → `[]` + 静默吞错。

**预填示例**: 仅当 `localStorage` 完全无该 key 时(初次访问)写入种子并附 `console.info('[quick-prompts] seeded 3 default prompts')`。后续用户操作(增/删/清空)完全覆盖默认值。

## 5. 组件设计

### 5.1 `useQuickPrompts`

返回 `{ prompts, add, remove, clear }`。

- `add(text)`: `text.trim()` 后空字符串或超长拒绝,dedup(`some(p => p.text === text)`)拒绝,`push` 到尾部 + 写 localStorage + 触发 `zai-localstorage-sync`,超过 `MAX_PROMPTS` 时按 `createdAt` 升序截断。
- `remove(id)`: filter + 写盘 + 同步事件。
- `clear()`: 清空数组 + 写盘 + 同步事件。

`prompts` 数组按 `createdAt` 升序(用户视角:后添加的在下,旧的在上)。

### 5.2 `useSubmitPrompt`

把 `AgentInputBox.tsx:466-534` 的 `postPromptToLLM` + `pushUserMsg` 提到独立 hook,签名:

```ts
interface UseSubmitPromptResult {
  submitPrompt: (text: string, opts?: { skipPushUserMsg?: boolean }) => Promise<void>
  pushUserMsg: (text: string, isRenderedPrompt?: boolean) => void
}
```

行为与当前完全一致:
1. `pushUserMsg(text)` → 写 `user.text` 到 store + `sendSeq++` + 状态切 streaming。
2. `api.post('/agent/prompt', { prompt, contentBlocks, sessionId })` → 同步 server 返回的 `sessionId` 回 store。
3. 复用现有 `X-Session-Id` header + `localTitle` 派生逻辑 (`AgentInputBox.tsx:484-499` 不变)。

提取后 `AgentInputBox` 内 `handleSend` 与 `selectSlashItem` (`AgentInputBox.tsx:548-597`、`576-588`) 改为调用 hook。

### 5.3 `MobileQuickDrawer` Props

```ts
interface Props {
  open: boolean
  onClose: () => void
}
```

内部结构:

```
Drawer (placement="right", width="85%", maskClosable)
├── header: "常用指令" + 右上角 X
├── Segmented: [快捷 Bash | 常用指令]    ← 受控 tabKey 状态
├── tab=bash:
│   ├── 顶部 [⟳ 刷新] 按钮 → fetchTopCommands()
│   └── List items: TopCommandEntry[] → row.onClick → execRepl + message + onClose
└── tab=prompt:
    ├── 顶部 [+ 新增] 按钮 → 展开 inline Form (Input + 保存/取消)
    ├── List items: QuickPrompt[] → row.onClick → submitPrompt + onClose
    └── 底部 [✕ 清空全部] 红色 ghost button
```

**关键交互**:
- Bash row click: `void execRepl(sessionId, { command })` → 成功 `message.success('已执行: <cmd>')` + 失败(409 busy / 网络) `message.warning(...)` + `onClose()`。不论结果都关闭。
- Prompt row click: `void submitPrompt(text)` + `onClose()`。text 通过 `useSubmitPrompt` 走完整 streaming pipeline。
- 抽屉打开时 sessionId 缺失:Bash tab 展示提示「请先开启会话」+ 列表禁用;Prompt tab 同样禁用并提示「无会话」。

### 5.4 AgentInputBox 工具栏按钮

放在 status row **最左端**,在 `●` ready dot 之前:

```tsx
{isMobile && (
  <Button
    icon={<AppstoreAddOutlined />}
    onClick={() => setQuickDrawerOpen(true)}
    data-testid="mobile-quick-drawer-toggle"
    style={toolbarIconButtonStyle}
  />
)}
```

`quickDrawerOpen` 是局部 `useState`,关闭回调通过 props `onQuickDrawerOpenChange?: (open: boolean) => void` 由父级 (`MobileAgent`) 注入,父级再把状态喂给 `<MobileQuickDrawer>`。这条 props 链是单向的,新增 1 个 prop 不破坏既有契约。

> 替代方案: 用 `zustand` 加一个 `quickDrawerOpen` 字段。否决理由:这是纯 UI 装饰状态,与其他业务流无关,塞进 `useAgentStore` 会污染 store 的语义边界。

## 6. 数据流

```
         (mobile) AgentInputBox [⚡]
                 │
                 │ onClick
                 ▼
        quickDrawerOpen = true
                 │
                 │ (props onQuickDrawerOpenChange)
                 ▼
     MobileAgent 持有受控 state
                 │
                 ▼
     <MobileQuickDrawer open onClose />
                 │
   ┌─────────────┴──────────────┐
   ▼                            ▼
Tab 1: Bash                  Tab 2: 提交指令
fetchTopCommands()           useQuickPrompts()
   │                              │
   ▼                              ▼
TopCommandEntry[]              QuickPrompt[]
   │                              │
   └ click row ─────┐    └ click row ─────┐
                    ▼                     ▼
           execRepl(sid, cmd)    useSubmitPrompt()
                    │                     │
                    ▼                     ▼
                 onClose          pushUserMsg + /api/agent/prompt
                                    + onClose
```

## 7. 错误 / 边界

| 情形 | 行为 |
|---|---|
| sessionId 为空 | Bash tab 提示「请先开启会话」,禁用列表;Prompt tab 提示「无会话」,禁用 |
| `execRepl` 返回 409 (busy) | `message.warning('已有命令在执行')` 后仍关闭 |
| `execRepl` 抛异常 | `message.error('执行失败: ...')`,仍关闭 |
| `submitPrompt` 调用时 status==='streaming' | `message.warning('请等待当前回复结束')`,不关闭 |
| localStorage 写入失败 (配额) | `message.error('存储已满,请清理后重试')` |
| JSON.parse 失败 | fallback 到 `[]` + 静默 |
| 抽屉打开时 session 切换 | 不自动关闭;但下一次点击 row 会用最新 sessionId (从 `useAgentStore` 取) |
| 抽屉打开时 streaming | 不阻止 drawer 操作;仅 Prompt row click 走 §7 第 3 行 |
| 预填示例后用户没操作 | 持久化为 3 条,刷新页面依旧存在 (因为写入了 localStorage) |

## 8. 测试

### 8.1 `useQuickPrompts.test.ts` (新)

- `add` 后读 localStorage 与 hook 状态都更新
- `add` 重复文本拒绝
- `add` 空文本 / 超长文本拒绝
- `remove` 后数组与 localStorage 都清掉对应项
- `clear` 后数组为空
- 容量上限 50: 第 51 次 add 截断最旧
- 初次 mount 无 key → 预填 3 条示例
- 二次 mount 有 key → 不覆盖
- 损坏 JSON → fallback `[]`
- 跨 tab / 同 tab 多组件同步 (custom event)

### 8.2 `useSubmitPrompt.test.ts` (新)

- 提取后的 hook 与原内联 `postPromptToLLM` / `pushUserMsg` 行为一致
- sessionId 缺失时回退 `activeSessionId`
- `localTitle` 派生逻辑保留

### 8.3 `MobileQuickDrawer.test.tsx` (新)

- 打开 → 渲染两个 Tab + 默认在 bash
- 切到 prompt → 渲染 prompt 列表 + [+ 新增] + [✕ 清空]
- 点击 bash row → 调 `execRepl` + 关闭
- 点击 prompt row → 调 `submitPrompt` + 关闭
- sessionId 缺失时禁用列表
- [+ 新增] 展开表单 → 输入文本 → 保存 → 列表新增一项
- [✕ 清空] → 列表为空

### 8.4 `AgentInputBox.test.tsx` (改)

- `isMobile=true` 时状态栏最左端多渲染一个 [⚡] 按钮 (`data-testid="mobile-quick-drawer-toggle"`)
- 点击触发 `onQuickDrawerOpenChange(true)`
- `isMobile=false` 时不渲染该按钮

## 9. 风险 & 缓解

| 风险 | 缓解 |
|---|---|
| `useSubmitPrompt` 提取后改动 `handleSend` 可能引入回归 | 单元测试覆盖原 `pushUserMsg` / `postPromptToLLM` 行为,加 AgentInputBox 集成测试断言 sendSeq++ |
| 移动端 drawer 打开期间软键盘弹出会挤压 | drawer 内不渲染 Input (新增 prompt 走 inline 表单,初始收起的点击态);键盘不冲突 |
| localStorage 跨域 quota | 容量上限 50 + 单条 ≤ 200 字符,实测 < 50KB |
| `useBashRepl` 在 drawer 卸载后 SSE 泄漏 | drawer 是短生命周期的 Drawer,只在 `open` 时挂载 `useBashRepl`,关闭 → unmount → 内部 `useEffect` 自动 `es.close()`。已在 `useBashRepl.ts:65-68` 处理 |
| 预填示例用户看着像"系统强加的" | console.info 一行提示 + Drawer 顶部加 tooltip「点击 ✕ 清空全部移除默认」 |

## 10. 后续迭代 (不在本期)

- Prompt tab 加 fuzzy search 输入框
- Prompt 片段加 usage count + 自动 LRU 排序
- 用户级 cloud sync (账号体系)
- Prompt 片段支持占位符 `{{input}}`
- 与 slash 命令联动:自动把高频 prompt 注册为 user command

## 11. 实现 plan 入口

实现前需先由 writing-plans skill 拆分 tasks;每个 task 完成需有单元测试 + 类型检查 + lint 通过。