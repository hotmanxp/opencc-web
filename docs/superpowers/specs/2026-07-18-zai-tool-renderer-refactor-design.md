# zai-web: tool renderer refactor (per-tool 渲染器抽象) — 设计规格

> 文档版本: 1.0 · 2026-07-18 · 状态: 设计已敲定, 待用户 review

## 0. 背景

`packages/zai/src/web/src/pages/Agent.tsx` 内的 `ToolCallBlock`（约 line 514–756）当前用一份 if/else 链为 `Bash` / `Agent` 工具做特化，其它工具全走通用 JSON 渲染路径：

```ts
let preview = "";
if (name === "Bash") {
  const desc = input.description;
  const cmd = input.command;
  if (typeof desc === "string" && desc.trim()) preview = truncate(desc);
  else if (typeof cmd === "string" && cmd.trim()) preview = truncate(cmd);
} else if (name === "Agent") {
  // 同样 description ?? prompt 模式
} else {
  // 通用: 第一个 input 字段的值
}
```

这样有几个问题：

1. **耦合严重**: 加新工具的特化逻辑要改 Agent.tsx 这个 800 行核心文件
2. **不可测**: Bash `<stdout>/<stderr>` 解析、Read 行号保留这种视图逻辑没有独立单测
3. **无法满足后续需求**: 用户已经提到 Edit 工具期望看到 diff、Read 期望保留行号 —— 这些都需要 per-tool 渲染逻辑

背景约束：

- 不动 server（`packages/zai/src/server/` 任何文件），本 PR 纯客户端
- 不动 `useAgentStore`（store shape 不变）
- 不动 `AskUserQuestion` 工具（已经有独立 `QuestionCard` 组件）
- 不动 `TodoWrite` 工具（已经有独立 `TodoZone` + `todosBySession` extractor）
- 现有 318 个测试全过为硬性验收门槛

## 1. 高层架构

```
src/web/src/
├── pages/
│   └── Agent.tsx                       (改动: ToolCallBlock 改为查表)
├── components/
│   ├── toolRenderers/                  (本 spec 新建)
│   │   ├── types.ts                    ToolRenderer 接口
│   │   ├── registry.ts                 map<name, ToolRenderer> + fallback
│   │   ├── bash.tsx
│   │   ├── read.tsx
│   │   ├── edit.tsx
│   │   ├── write.tsx
│   │   ├── glob.tsx
│   │   ├── grep.tsx
│   │   ├── agent.tsx
│   │   └── generic.tsx                 通用 fallback
│   └── ... (其它组件不变)
```

### 1.1 核心抽象

每个工具一份 `ToolRenderer` 对象（不可变，模块级常量）：

```ts
// types.ts
export type ToolRenderer = {
  /** 折叠态 preview 字符串 (pill 后单行展示). 空字符串 = 不渲染 preview. */
  preview(input: Record<string, unknown>): string

  /** 自定义 displayName (override schema 工具名). 例: Agent → "Explore (agent)" */
  displayName?(input: Record<string, unknown>): string

  /** 展开态参数区; 缺省 = JSON.stringify(input, null, 2) 包 pre 块 */
  renderInput?(input: Record<string, unknown>): ReactNode

  /** 展开态输出区; 缺省 = (output 字符串 ? pre 绿底 : 不渲染) */
  renderOutput?(output: unknown, isError: boolean): ReactNode
}
```

### 1.2 调度

```ts
// registry.ts
const registry: Record<string, ToolRenderer> = {
  Bash: bashRenderer,
  Read: readRenderer,
  Edit: editRenderer,
  Write: writeRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Agent: agentRenderer,
}

export function getRenderer(name: string): ToolRenderer {
  return registry[name] ?? genericRenderer
}
```

`ToolCallBlock` 改为：

```ts
const renderer = getRenderer(name)
const previewText = renderer.preview(input)
const displayName = renderer.displayName?.(input) ?? name
// 展开区: renderInput 优先, 缺省走 generic 的 JSON pre
// renderOutput 同理
```

## 2. 各工具的 renderer 行为

### 2.1 Bash (`bash.tsx`)

```ts
preview(input) {
  const desc = input.description
  if (typeof desc === "string" && desc.trim()) return truncate(desc, 80)
  const cmd = input.command
  if (typeof cmd === "string" && cmd.trim()) return truncate(cmd, 80)
  return ""
}

renderInput(input) {
  // 突出 command, 次要字段折叠在 <details> 内
  const command = typeof input.command === "string" ? input.command : ""
  const secondary = pick(input, ["description", "timeout", "run_in_background"])
  return (
    <div>
      <FieldLabel>命令</FieldLabel>
      <PreBlock>{linkifyText(command)}</PreBlock>
      {Object.keys(secondary).length > 0 && (
        <details><summary>更多参数</summary><PreBlock>{JSON.stringify(secondary, null, 2)}</PreBlock></details>
      )}
    </div>
  )
}

renderOutput(output, isError) {
  // output 是 `<stdout>...</stdout><stderr>...</stderr>` 拼接 (BashTool.ts:49-54)
  const text = stringFromOutput(output)
  const { stdout, stderr, plain } = parseBashOutput(text)
  return (
    <>
      {stdout && <PreBlock style={successStyle} title="stdout">{stdout}</PreBlock>}
      {stderr && <PreBlock style={errorStyle} title="stderr">{stderr}</PreBlock>}
      {plain && <PreBlock style={mutedStyle}>{plain}</PreBlock>}
    </>
  )
}
```

`parseBashOutput` 是关键解析逻辑：

```ts
function parseBashOutput(s: string): { stdout: string; stderr: string; plain: string } {
  // 正则 /<stdout>([\s\S]*?)<\/stdout>/g 提取所有 stdout 段
  // /<stderr>([\s\S]*?)<\/stderr>/g 提取所有 stderr 段
  // 剩余 (plain) 段是 background-task 标识如 <task_id>..</task_id> 或 status 行
  // 全部去除后剩余 raw text 作为 plain
}
```

行为对照:
- **现状**: Bash 折叠态 description 已正常；展开后参数区是全 JSON，输出是绿色 pre 一坨
- **改动后**: 折叠态保持 description；展开后命令独占一行 `<pre>` 突出显示；输出按 `<stdout>/<stderr>` 拆开染色
- **等价保证**: 已 commit `f0c5492` 修复的"description/command 预览丢失"行为不回归

### 2.2 Read (`read.tsx`)

```ts
preview(input) {
  const p = input.file_path
  if (typeof p !== "string") return ""
  const offset = typeof input.offset === "number" ? input.offset : null
  const limit = typeof input.limit === "number" ? input.limit : null
  const lineRange = offset != null && limit != null ? ` L${offset}-${offset + limit - 1}` : ""
  return truncate(`${p}${lineRange}`, 80)
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>文件</FieldLabel>
      <PreBlock>{linkifyText(input.file_path)}</PreBlock>
      {(input.offset != null || input.limit != null) && (
        <PreBlock muted>
          offset={input.offset ?? 0}{input.limit != null ? `, limit=${input.limit}` : ""}
        </PreBlock>
      )}
    </div>
  )
}

renderOutput(output) {
  // FileRead 输出格式: "Read N lines (start-end of total).\n<line>:<text>\n..."
  const text = stringFromOutput(output)
  return <PreBlock style={successStyle}>{linkifyText(text)}</PreBlock>
}
```

行为对照:
- **现状**: 通用兜底，全 JSON
- **改动后**: 折叠态显示文件路径 + 行号范围（如果有 offset/limit）；展开后 file_path 突出，`offset/limit` 用 muted pre 第二行展示

### 2.3 Edit (`edit.tsx`)

**本版 (短期)**:

```ts
preview(input) {
  const p = input.file_path
  if (typeof p !== "string") return ""
  const replaceAll = input.replace_all === true ? " (all)" : ""
  return truncate(`${p}${replaceAll}`, 80)
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>文件</FieldLabel>
      <PreBlock>{linkifyText(input.file_path)}</PreBlock>
      {typeof input.old_string === "string" && (
        <DiffPreview before={input.old_string} after={input.new_string ?? ""} />
      )}
    </div>
  )
}

renderOutput(output) {
  // server 当前只回 "Replaced N occurrence(s) in <absPath>"
  const text = stringFromOutput(output)
  return <PreBlock style={successStyle}>{linkifyText(text)}</PreBlock>
}
```

**关于 `DiffPreview`**: spec 决定为 input 段提供静态 diff 预览（用 `diff` 包或自己写 LCS），**但**：

> **🟡 TODO - 显式排除在本版范围之外**: 利用 client 的 `old_string/new_string` 静态 diff 预览可能与实际文件不挂钩（用户可能 LLM 之前已经改过），所以本版 `renderInput` 中只渲染 `old_string` / `new_string` 两个 `<pre>` 字段（不画 diff 线），让用户看到完整文本改动，**不上 diff 高亮**。等 server 升级把 before/after 推上来，再启用 `DiffBlock` 组件接入。

行为对照:
- **现状**: 通用 JSON
- **改动后**: 折叠态显示文件路径；展开后 file_path 突出 + old_string / new_string 两个 pre 字段

### 2.4 Write (`write.tsx`)

```ts
preview(input) {
  const p = input.file_path
  if (typeof p !== "string") return ""
  const c = input.content
  const lines = typeof c === "string" ? c.split("\n").length : 0
  return truncate(`${p} (${lines} lines)`, 80)
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>文件</FieldLabel>
      <PreBlock>{linkifyText(input.file_path)}</PreBlock>
      {typeof input.content === "string" && (
        <>
          <FieldLabel>完整内容</FieldLabel>
          <PreBlock>{linkifyText(input.content)}</PreBlock>
        </>
      )}
    </div>
  )
}

renderOutput(output) {
  // server 回 "Wrote N bytes to <absPath>"
  return <PreBlock style={successStyle}>{linkifyText(stringFromOutput(output))}</PreBlock>
}
```

### 2.5 Glob (`glob.tsx`)

```ts
preview(input) {
  if (typeof input.pattern !== "string") return ""
  const path = typeof input.path === "string" ? ` in ${input.path}` : ""
  return truncate(`${input.pattern}${path}`, 80)
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>pattern</FieldLabel>
      <PreBlock>{linkifyText(input.pattern)}</PreBlock>
      {typeof input.path === "string" && (
        <FieldLabel>path</FieldLabel>
        <PreBlock>{linkifyText(input.path)}</PreBlock>
      )}
    </div>
  )
}

renderOutput(output) {
  // server 回 "Found N matches:\n<file>\n..." 或 "No files matched ..." 或 "Glob failed: ..."
  return <PreBlock style={successStyle}>{linkifyText(stringFromOutput(output))}</PreBlock>
}
```

### 2.6 Grep (`grep.tsx`)

```ts
preview(input) {
  if (typeof input.pattern !== "string") return ""
  const path = typeof input.path === "string" ? ` in ${input.path}` : ""
  return truncate(`${input.pattern}${path}`, 80)
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>pattern</FieldLabel>
      <PreBlock>{linkifyText(input.pattern)}</PreBlock>
      <details>
        <summary>更多参数</summary>
        <PreBlock>{JSON.stringify(pick(input, ["path", "glob", "output_mode", "context", "ignore_case"]), null, 2)}</PreBlock>
      </details>
    </div>
  )
}

renderOutput(output) {
  // content 模式: "<file>:<line>:<text>\n..." 
  // files_with_matches 模式: "<file>\n..."
  // count 模式: "<file>:N\n..."
  return <PreBlock style={successStyle}>{linkifyText(stringFromOutput(output))}</PreBlock>
}
```

### 2.7 Agent (`agent.tsx`)

```ts
preview(input) {
  const desc = input.description
  if (typeof desc === "string" && desc.trim()) return truncate(desc, 80)
  const p = input.prompt
  if (typeof p === "string" && p.trim()) return truncate(firstLine(p), 80)
  return ""
}

displayName(input) {
  const t = input.subagent_type
  return `${typeof t === "string" && t.trim() ? t : "general-purpose"} (agent)`
}

renderInput(input) {
  return (
    <div>
      <FieldLabel>subagent_type</FieldLabel>
      <PreBlock>{linkifyText(input.subagent_type ?? "general-purpose")}</PreBlock>
      <FieldLabel>prompt</FieldLabel>
      <PreBlock>{linkifyText(input.prompt ?? "")}</PreBlock>
    </div>
  )
}

renderOutput(output) {
  // AgentTool 输出有多种形态: <task_id>..</task_id>, or sub-agent 文本回复
  return <PreBlock style={successStyle}>{linkifyText(stringFromOutput(output))}</PreBlock>
}
```

行为对照:
- **现状**: 已有的 `name === "Agent"` 特化逻辑（displayName + preview description ?? prompt）迁移
- **改动后**: 同样行为，但通过 renderer 接口分散到 agent.tsx

### 2.8 generic.tsx（fallback）

```ts
const genericRenderer: ToolRenderer = {
  preview(input) {
    const firstKey = Object.keys(input)[0]
    const firstVal = firstKey ? input[firstKey] : undefined
    if (firstVal == null) return ""
    const text = typeof firstVal === "string" ? firstVal : JSON.stringify(firstVal)
    return truncate(text, 80)
  }
  // displayName / renderInput / renderOutput 全部 undefined:
  // ToolCallBlock 走"未实现 = 走现状"的等价路径
}
```

未列名工具（TodoWrite/AskUserQuestion/Skill/Task*/...）在 `ToolCallBlock` 入口仍是**早 return** 走的专用分支（TodoZone / QuestionCard），不进入 renderer 调度。

## 3. ToolCallBlock 调用点改造

只动 Agent.tsx 内的 ToolCallBlock（约 240 行）：

```diff
- let preview = ""
- if (name === "Bash") { ... }
- else if (name === "Agent") { ... }
- else { ... }
+ const renderer = getRenderer(rawName)
+ const preview = renderer.preview(input)
+ const displayName = renderer.displayName?.(input) ?? rawName
+ const inputView = renderer.renderInput
+   ? renderer.renderInput(input)
+   : renderGenericInput(input)
+ const outputView = renderer.renderOutput
+   ? renderer.renderOutput(output, errorField != null)
+   : renderGenericOutput(output)
```

`renderGenericInput` / `renderGenericOutput` 是从原代码里抽出来的两个内部函数——分别渲染 JSON pre 和绿色 pre。generic renderer 不提供这俩钩子时就回到这俩默认实现。

`linkifyText` / `CODE_FONT_FAMILY` / 现有颜色 token (`rgba(82,196,26,0.06)` etc.) 全部从 Agent.tsx 共享出来，工具 renderer 通过 import 拿。

## 4. 测试

### 4.1 单元测试 (`test/web/toolRenderers/`)

新增文件：

- `parseBashOutput.test.ts` — 验证 `<stdout>..</stdout><stderr>..</stderr>` 拆分；background task `<task_id>..</task_id>` 走 plain；混合输入按出现顺序切分
- `bashRenderer.test.ts` — Bash preview 优先 description；renderInput 把 command 提到顶部；renderOutput 三段染色
- `readRenderer.test.ts` — preview 在有 offset/limit 时附加 `L{start}-{end}`；renderOutput 保留行号
- `editRenderer.test.ts` — preview 加 `(all)` 当 replace_all；renderInput 渲染 old_string/new_string 两段
- `writeRenderer.test.ts` — preview 显示行数；renderInput 完整 content
- `globRenderer.test.ts` — preview 是 pattern + path
- `grepRenderer.test.ts` — preview 是 pattern + path
- `agentRenderer.test.ts` — preview description ?? firstLine(prompt)；displayName 拼 `(agent)`
- `genericRenderer.test.ts` — preview 拿第一个 input 字段值

### 4.2 集成测试

Agent.test.tsx 现有 snapshot / 行为测试如果有覆盖 ToolCallBlock，需要：

- 跑一遍确保 generic path 不回归
- 加 1 条 Bash snapshot 验证新拆分的 stdout/stderr 区块
- 加 1 条 Read snapshot 验证 file_path 突出显示

### 4.3 硬性验收

- `pnpm -r build` 通过
- `pnpm -r test` 通过（含新加的所有单测）
- typecheck pass
- 浏览器手测一次对话触发 Bash/Read/Edit/Write/Glob/Grep/Agent 各一次，肉眼对照 schema 渲染

## 5. 关键风险 & 缓解

| 风险 | 缓解 |
|---|---|
| Bash `<stdout>` 解析遇到转义 `<` 字符（如 echo `<<EOF`）误切 | 用 `[\s\S]*?` 非贪婪 + 配对标签；剩下无闭合标签的 `<` 走 plain fallback，不丢内容 |
| Edit 显示 old_string/new_string 全文太长导致 pre 块爆框 | 已有 `maxHeight: 360 + overflow: auto`，保留 |
| Agent subagent_type 没填时回退"general-purpose"，与现有行为一致 | 现状已这样（line 527 注释里的 fallback），不引入新行为 |
| snapshot test 因结构调整大面积失败 | 优先用 unit test 覆盖渲染函数，snapshot 只覆盖关键 case；阶段性 update snapshot 而不是 abort |

## 6. 非目标 (明确排除)

- 不改 server 任何文件
- 不改 zai-agent-core 任何文件
- 不改 `useAgentStore` shape
- 不改 `AskUserQuestion` / `TodoWrite` 这两个早 return 工具的渲染
- 不实现 Edit 工具的真 diff 高亮（等 server 推 before/after）
- 不引入 syntax-highlight 库（保持等宽字体 + 颜色）
- 不动 TaskCreate / TaskUpdate 等 Task 系列工具（等收集实际使用模式再做，本版全部走 generic）

## 7. 文件清单 (新增/改动)

新增 (10 files):
- `packages/zai/src/web/src/components/toolRenderers/types.ts`
- `packages/zai/src/web/src/components/toolRenderers/registry.ts`
- `packages/zai/src/web/src/components/toolRenderers/bash.tsx`
- `packages/zai/src/web/src/components/toolRenderers/read.tsx`
- `packages/zai/src/web/src/components/toolRenderers/edit.tsx`
- `packages/zai/src/web/src/components/toolRenderers/write.tsx`
- `packages/zai/src/web/src/components/toolRenderers/glob.tsx`
- `packages/zai/src/web/src/components/toolRenderers/grep.tsx`
- `packages/zai/src/web/src/components/toolRenderers/agent.tsx`
- `packages/zai/src/web/src/components/toolRenderers/generic.tsx`

新增 (测试):
- `packages/zai/test/web/toolRenderers/*.test.ts` (一组 8–9 文件)

改动 (2 files):
- `packages/zai/src/web/src/pages/Agent.tsx` (ToolCallBlock 改为查表; 抽出 `renderGenericInput/Output` helper)
- `packages/zai/test/web/Agent.test.tsx` (如必要: 更新 snapshot + 加 Bash/Read renderer 集成 case)

总改动行数预估: +600 / -120 (净 +480 左右)
