# Spec — Task Factory 执行过程 Tab 事件渲染修复

**Status**: draft(设计已确认,实现待启动)
**Implements**: 把 `SuperTaskDetailDrawer` "执行过程" Tab 中目前用 `${e.event} · ${JSON.stringify(data).slice(0,120)}` 拼接的 raw JSON 行,改为按 RuntimeEvent 角色(system / user / assistant-text / thinking / tool-use / tool-result / task-ended)分层渲染的可读事件流。
**Code (current)**:
- `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`(执行过程 Tab 渲染位置)
- `packages/zai/src/web/src/lib/taskApi.ts`(`SseFrame` / `subscribeTaskEvents`)
- `packages/zai/src/server/routes/tasks.ts`(`evToWire`,SSE 帧格式定义)
- `packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts`(`appendTaskEvent`,RuntimeEvent → TaskEvent 入口)

**Code (proposed)**:
- `packages/zai/src/web/src/components/superTasks/processEventRenderer.ts`(新增,纯函数模块)
- `packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts`(新增,fixtures 单测)
- `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`(改 30 行,调用 renderer,渲染结构化结果)

**Companion plan**: `docs/superpowers/plans/2026-09-02-task-factory-event-rendering-fix-plan.md`(待生成)

## Problem

任务工厂任务详情抽屉的「执行过程」Tab 当前展示的是 SSE attach 帧的 raw JSON:

```
system · {"seq":1,"type":"system","ts":1788352835185,"eventId":"attach-...","data":{"text":""},"raw":{"type":"system","sub
assistant · {"seq":2,"type":"assistant","ts":...,"eventId":"...","data":{"text":""},"raw":{"type":"assistant...
user · {"seq":4,"type":"user","ts":...,"eventId":"...","data":{"text":""},"raw":{"type":"user","message...
```

根因在 `SuperTaskDetailDrawer.tsx:122-124`:

```tsx
children: `${String(e.event)} · ${String(
  data?.description ?? JSON.stringify(e.data ?? {}).slice(0, 120),
)}`,
```

- `e.event` 是 SSE event 名(`attach` / `task.ended`),不是 RuntimeEvent 的语义类型。
- 大多数 RuntimeEvent 没有 `description` 字段,所以全部退化成 `JSON.stringify(e.data).slice(0,120)` 截断的 raw 输出。
- 真实内容在 `data.raw.message.content[]`(text / tool_use / tool_result blocks),当前完全没读。
- `data.text` 设计就是空(它是 SSE wrapper 的占位 text),所以空字符串不是 bug,是字段语义本身就不承载内容。

这套渲染把消息流当成日志流 dump 给用户,**完全不可读**。用户无法从执行过程 Tab 知道 agent 在做什么、调了哪些工具、结果是什么,失去任务监控意义。

## Decision

**新增 `processEventRenderer.ts` 纯函数模块,把每帧 `SseFrame` 翻译成 `RenderedEvent` 结构化对象,Drawer 组件只负责按 `kind` 分支渲染,不感知 RuntimeEvent 字段。**

设计取舍:

1. **纯函数 + 结构化对象**:翻译策略是策略不是 UI 细节。Drawer 里塞 case 表达式会让 50 行 component 涨到 200 行、且无法单测;纯函数 → renderer 100% 覆盖,fake fixture 跑遍 6 种 RuntimeEvent + 异常帧。
2. **不重构 SSE 端**:`subscribeTaskEvents` 协议不变,仅改消费侧。零回归风险,不影响 zai 对话 UI、TaskDock、TaskDrawer 等其他消费者。
3. **不做 curated events.jsonl**:executor 自己写的 `process.md` 已经有 curated 进展,且 process.md tab 单独渲染;执行过程 tab 的价值在于**实时逐事件可见**,跟 curated 是两个不同视角,不互相替代。
4. **tool_use/tool_result 折叠展开**:JSON 一般很长,默认折叠一行 `[Tool: Read(file.ts) ▾]`,点开看完整 input + result。展开状态只在内存,不持久化、不进 URL。
5. **YAGNI**:
   - 不渲染 `progress` / `attachment` 帧(任务监控不需要,后续要再加)
   - 不做事件搜索/过滤 UI(抽屉里事件量有限,200 帧足够扫读)
   - 不做 SSE 重连提示 / 错误 banner(超 spec 范围,沿用现状静默)
   - 不持久化展开状态(切 tab 回到默认折叠,简单)

### 不在范围

- SSE 协议 / `subscribeTaskEvents` 改动
- 新增 `events.jsonl` curated log
- 替换 process.md tab 或与执行过程 tab 合并
- 事件搜索 / 过滤 / 导出
- 持久化展开状态 / URL state
- 移动端 `/m` 任务抽屉适配(沿用现状)

## 架构

```
SuperTaskDetailDrawer.tsx
  ├─ useEffect → subscribeTaskEvents(executorId, 0, ctrl.signal)
  │     └─ setEvents((p) => [...p, frame].slice(-200))
  └─ useMemo → events.map(processEventRenderer.toRendered)
        └─ <Timeline items={rendered.map(toTimelineItem)} />

processEventRenderer.ts
  └─ toRendered(frame: SseFrame): RenderedEvent | null   ← 纯函数,可单测
        ├─ 帧级守卫:event/data/raw 缺失/类型错 → null
        ├─ SSE task.ended → RenderedEvent.task-ended
        ├─ RuntimeEvent.type=system → RenderedEvent.system
        ├─ RuntimeEvent.type=user → RenderedEvent.user
        ├─ RuntimeEvent.type=assistant
        │     ├─ content[0].type=text → RenderedEvent.assistant-text
        │     ├─ content[0].type=thinking → RenderedEvent.thinking
        │     └─ content[0].type=tool_use → RenderedEvent.tool-use
        ├─ RuntimeEvent.type=user, content[0].type=tool_result → RenderedEvent.tool-result
        └─ 未知 type → null(静默 skip)
```

### 数据模型

```ts
// processEventRenderer.ts
export type RenderedEvent =
  | { kind: 'system';  ts: number; seq: number; sub: string }
  | { kind: 'user';    ts: number; seq: number; text: string; cwd?: string; agent?: string }
  | { kind: 'assistant-text'; ts: number; seq: number; text: string }
  | { kind: 'thinking'; ts: number; seq: number; text: string }
  | { kind: 'tool-use'; ts: number; seq: number; name: string;
      toolUseId: string; summary: string; fullInput: Record<string, unknown> }
  | { kind: 'tool-result'; ts: number; seq: number; toolUseId: string;
      isError: boolean; summary: string; fullContent: string }
  | { kind: 'task-ended'; status: 'completed'|'failed'|'cancelled';
      error?: string; resultText?: string }
```

### 翻译规则表

| 输入帧 | 翻译到 | 取数 |
|---|---|---|
| SSE event=`task.ended` | `task-ended` | `data.status` / `data.error.message` / `data.resultText` |
| attach, RuntimeEvent.type=`system` | `system` | `raw.subtype` (init / compact_boundary …) |
| attach, RuntimeEvent.type=`user`, content=[text] | `user` | `raw.message.content[0].text`, 可选 `metadata.cwd/agent` |
| attach, RuntimeEvent.type=`assistant`, content[0].type=`text` | `assistant-text` | `raw.message.content[0].text` |
| attach, RuntimeEvent.type=`assistant`, content[0].type=`thinking` | `thinking` | 同上 |
| attach, RuntimeEvent.type=`assistant`, content[0].type=`tool_use` | `tool-use` | `name`, `input`(给 `summary` 取关键字段) |
| attach, RuntimeEvent.type=`user`, content[0].type=`tool_result` | `tool-result` | `content`(字符串或 `[text/type]` 数组 → 拼字符串),`is_error` |
| 其他未知 type | `null`(跳过) | — |

### summary 生成规则(tool-use 一行标题)

- `Read` / `Write` / `Edit`: `input.file_path`
- `Bash`: `input.command` 前 80 字
- `Grep` / `Glob`: `input.pattern`(Glob 加 ` · ${input.path}`)
- `Agent` / `Task`: `input.description` 或 `input.prompt` 前 60 字
- 其他: `JSON.stringify(input).slice(0, 80)`

tool_result 摘要:`content` 字符串首行 + 长度(如 `[stderr] 245 lines · 1.2 KB`),`is_error=true` 时整行红底色。

### 跳过策略

- RuntimeEvent.type=`assistant` 但 content 包含 `tool_use` / `tool_result` blocks → 跳过该帧(用独立的 tool-use / tool-result 渲染)
- 连续多条 assistant-text → 不合并(后续如果发现太多空白再合,现在不做)
- `raw.message.content[].type` 未知 → 该 block 跳过,不影响同帧其他 block

### Timeline 渲染映射

| rendered.kind | dot color | children 组件 |
|---|---|---|
| `system` | gray | `<Typography.Text type="secondary">[{sub}]</Typography.Text>` |
| `user` | green | `<blockquote>{text}</blockquote>` + cwd/agent 灰色小字 |
| `assistant-text` | blue | `<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>` |
| `thinking` | gray | 折叠面板 `[思考] ▾` → text |
| `tool-use` | purple | `<ToolUseRow>` 一行 `[name: summary ▾]`,点开看 input JSON |
| `tool-result` | (无 dot) | 缩进到对应 tool-use 下方(同 toolUseId 锚),独立展开 |
| `task-ended` | status | `[✓] 任务完成` / `[✗] 失败: {error}` / `[−] 已取消` |

### 展开交互

- tool-use 一行 `[name: summary ▾]` → 点切 `▴`,下方插 `<pre>{JSON.stringify(fullInput, null, 2)}</pre>`(monospace, max-height: 240, overflow auto)
- tool-result 挂在 tool-use 展开区下方,独立开关 `[result · {N} lines]`,点开看 `fullContent`
- 展开状态存 component 内 `Map<toolUseId, { input?: boolean; result?: boolean }>`,切 tab 不丢,不持久化、不进 URL
- Timeline 高度限制:`maxHeight: 'calc(100vh - 280px)', overflowY: 'auto'`(抽屉高度有限,200 帧上限已在现有 `slice(-200)`)

### 空状态 / 边界

- `executorTaskId` 缺失 → 沿用现状 "尚未派生执行子 Agent"
- events 空 → 沿用现状 "等待执行事件..."
- `task.ended` 缺失 → 不渲染结束行(Drawer 顶部状态文本已含 status)
- `frame.data` 非对象 / 缺 `raw` → renderer 返回 `null`,Drawer 跳过

### 数据流

```
subscribeTaskEvents(executorId, 0, ctrl.signal)   ← 不变
  └─ for-await SseFrame
       └─ setEvents((p) => [...p, frame].slice(-200))   ← 不变
            └─ useMemo: events.map(toRendered)
                 └─ Timeline items={rendered.map(toTimelineItem)}
```

## 错误处理

| 异常 | 行为 |
|---|---|
| `frame.data` 不是对象(null / 字符串) | renderer 返回 `null`,Drawer 跳过 |
| `raw.message.content` 缺 / 非数组 | 跳过该帧 |
| content block type 未知 | 该 block 跳过,不影响同帧其他 block |
| tool_use `input` 缺字段 | summary 退化为 `JSON.stringify(input).slice(0, 80)` |
| tool_result `content` 是数组 | 拼接 `[text]` 块,跳过 `[image]`/`[document]` |
| SSE 订阅断开 / 异常 | 沿用现状静默(超 spec 范围,后续若需重连提示独立任务) |
| 大量事件 | 200 帧上限已在现有 `slice(-200)`,不重复限制 |

## 测试

**纯函数单测**(`processEventRenderer.test.ts`,vitest):

- fixture 覆盖 6 种 RuntimeEvent.type(system / user / assistant-text / thinking / tool-use / tool-result)
- multi-block content(同帧 text + tool_use)
- 异常帧:`data` 为 null / 字符串、缺 `raw`、`content` 空数组、未知 block type
- `task.ended` 三种终态(completed / failed / cancelled)
- summary 生成 8 个工具名 case(Read / Write / Edit / Bash / Grep / Glob / Agent / Task)
- tool_result `is_error: true` 颜色标记
- tool_result `content` 是数组时拼接 `[text]` 块、跳过非 text 类型

**单测命令**(AGENTS.md 规定只跑相关文件):

```
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts
```

**Drawer component 不补单测**:AGENTS.md 规则下"改 props 透传 + Timeline 渲染映射"过单测 ROI 低;且当前 `SuperTaskDetailDrawer.test.tsx` 不存在,新增需要 mock subscribeTaskEvents + Drawer + AntD Tabs,价值/工作量比差。

**真实浏览器验收**(强制项,AGENTS.md):

```
pnpm --filter @zn-ai/zai dev -- --port <空闲> --api-port <空闲>
/ego-browser
  → 打开 zai UI → /super-tasks → 任一 processing 任务 → 详情抽屉 → 执行过程 tab
  → 截图确认 6 种事件类型(system / user / assistant-text / tool-use / tool-result / task-ended)
     都正确显示
  → 点 tool-use 行 → 展开 input JSON
  → 同 toolUseId 的 tool-result 挂在下方,独立展开 result
  → 切到 spec.md / plan.md / process.md tab → 验证无回归
```

## 回归风险评估

| 改动点 | 风险 |
|---|---|
| `subscribeTaskEvents` 不改 | 0 风险(协议不变) |
| `processEventRenderer.ts` 新增 | 0 风险(独立模块,未被其他文件 import) |
| `SuperTaskDetailDrawer.tsx` 改 30 行 | 低风险(只换渲染逻辑,数据流 / useEffect / state 不变) |
| 单测新增 | 0 风险(纯函数) |
| 其他 Drawer 消费者 | 0 风险(`processEventRenderer.ts` 是 superTasks 子目录私有) |

## 不在范围(显式声明)

- 不改 SSE 协议 / `evToWire` / `TaskEvent` shape
- 不新增 `events.jsonl` curated log
- 不合并 process.md tab 与执行过程 tab
- 不做事件搜索 / 过滤 / 导出 UI
- 不持久化展开状态 / URL state
- 不适配移动端 `/m` 任务抽屉
- 不做 SSE 重连提示 / 错误 banner
- 不动 `zn-agent-core` 任何文件(本任务纯前端)
