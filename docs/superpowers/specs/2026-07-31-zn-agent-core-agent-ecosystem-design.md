# AgentTool 生态接入 zn-agent-core vendor query 路径

> 设计日期:2026-07-31
> 范围:`packages/zn-agent-core/src/compat/tools/opencc/builtin.ts` + 新增 1 个 wrapper 文件 + 测试
> 前置:`2026-07-31-zn-agent-core-task-tools-design.md`(4 个 Task 工具已接入)

## 1. 背景

zai 的 `DefaultAgentRuntime.run()` 自 `3e021ec5` 起 default 走 `runViaOpenccQuery`(vendor `query()`)。`getOpenccBuiltinTools()` 当前返回 7 个工具:6 个 vendor(Bash/FileRead/FileEdit/FileWrite/Glob/Grep)+ 1 个 zai `AskUserQuestion` wrapper。

缺少 agent 生态关键工具:
- **AgentTool**(`Agent`)— sub-agent 派单,主 agent 与 BackgroundRuntime 之间的桥梁
- **BackgroundAgentResultTool** — 阻塞等背景 agent 终态
- **TaskOutputTool** — 非阻塞拉背景 agent 输出
- **WebFetchTool** — LLM 网络抓取
- **WebSearchTool** — LLM 搜索
- **Skill**(`Skill`)— zai-native 已在 `buildDefaultTools()`,但 vendor query 路径不调 `buildDefaultTools()`,所以模型在当前 default 路径下用不到 Skill

## 2. 设计目标

- 6 个工具全部暴露给 vendor query 路径下的 LLM
- 复用 `wrapAsOpenccTool` 模式(已有 `AskUserQuestionTool.ts` / `TaskTools.ts` 参考)
- vendor 工具全部走 `dyn()` 动态 import(跟现有 Bash/Read/Edit 一致)
- 不修改 vendor 代码,不修改 `compat/tools/tasks/` 已有 4 个工具

## 3. 文件改动清单

### 3.1 新增

```
packages/zn-agent-core/src/compat/tools/opencc/
  └── SkillTool.ts          # wrapSkillToolAsOpencc() 包装 zai-native Skill

packages/zn-agent-core/test/unit/tools/opencc/
  ├── SkillTool.test.ts     # wrapper shape 测试
  └── builtin.test.ts       # getOpenccBuiltinTools() 名字列表测试
```

### 3.2 修改

- `packages/zn-agent-core/src/compat/tools/opencc/builtin.ts` — `getOpenccBuiltinTools()` 增加 6 个 tool 进 `cachedTools`:
  - `SkillTool` (zai-native wrapper, 复用 `compat/tools/index.ts:498` 的 `skillTool`)
  - `AgentTool` (vendor)
  - `BackgroundAgentResultTool` (vendor)
  - `TaskOutputTool` (vendor)
  - `WebFetchTool` (vendor)
  - `WebSearchTool` (vendor)

### 3.3 不改动

- `compat/tools/tasks/` 已有 4 个工具(T1-6 已完成)
- `compat/tools/index.ts`(zai-native path,不再 default)
- vendor 代码(`opencc-src/**`)
- `runViaOpenccQuery` / `openccQueryBridge`(工具列表来自 `getOpenccBuiltinTools`)

## 4. 数据流

**LLM 调 AgentTool**:
```
tool_use(name="Agent", input={subagent_type:"Explore", prompt:"..."})
  → vendor query() 通过 cachedTools 拿到 AgentTool
  → AgentTool.call → 内部分发 sub-agent
  → zai-server 的 BackgroundRuntime(已在 agentRuntime.ts 配置)
  → sub-agent 终态 → SubagentNotifier → 父 session 续传
```

**LLM 调 Skill**:
```
tool_use(name="Skill", input={skill:"brainstorming"})
  → vendor query() 拿到 wrapSkillToolAsOpencc 输出
  → call → transformCtx 注入 sessionId + abortSignal
  → zai-native skillTool.call(已存在)
  → 读 SKILL.md → 返回 body 注入上下文
```

**LLM 调 WebFetch/WebSearch/BackgroundAgentResult/TaskOutput**:
```
→ vendor 原生工具,无 zai wrapper
→ 内部走 vendor 的 service 层(fetch / task system)
```

## 5. 工具契约

### 5.1 wrapSkillToolAsOpencc

- **签名**: `wrapSkillToolAsOpencc(): OpenccToolLike[]`(实际上返回单元素数组,因为只包装一个工具;保持数组签名与 `wrapTaskToolsAsOpencc` 一致)
- **实现**: 复用 `wrapAsOpenccTool(skillTool as any, { transformCtx })`
- **transformCtx**: 注入 `sessionId` + `abortSignal`,与 TaskTools 模式相同
- **位置**: `compat/tools/opencc/SkillTool.ts`

### 5.2 getOpenccBuiltinTools 扩展

`cachedTools` 最终包含:
```ts
[
  BashTool, FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool,  // 6 vendor
  AskUserQuestionOpencc,  // zai wrapper
  ...taskToolsOpencc,     // 4 zai Task 工具 (T1-6 已完成)
  SkillOpencc,            // zai wrapper (新增)
  AgentTool,              // vendor
  BackgroundAgentResultTool,  // vendor
  TaskOutputTool,         // vendor
  WebFetchTool,           // vendor
  WebSearchTool,          // vendor
]
```
共 17 个工具。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| vendor 工具动态 import 失败(Bun-only 在 Node 抛) | 跟现有 Bash/Read 一样 — 走 `dyn()` + `// @ts-ignore`,已通过 bun-protocol.mjs 处理 |
| Skill wrapper 找不到 `__zaiBridgeCtx` | `sessionId` 取 `undefined`,`skillTool.call` 走默认 cwd(进程 cwd),与 TaskTools 路径一致 |
| LLM 调 `Agent` 但 BackgroundRuntime 未配置 | vendor AgentTool 内部 dispatch 失败 → 走 vendor 默认错误路径(`is_error: true`),zai-server 日志能看到 |

## 7. 测试

### 7.1 单元

- `SkillTool.test.ts`:
  - `wrapSkillToolAsOpencc()` 返回 1 个 tool,name = 'Skill'
  - 有 `call` / `description` / `inputSchema` / `isReadOnly` / `isConcurrencySafe` / `isEnabled`
- `builtin.test.ts`:
  - `getOpenccBuiltinTools()` 返回数组,长度 = 17
  - 包含全部 17 个名字(Bash, FileRead, FileEdit, FileWrite, Glob, Grep, AskUserQuestion, TaskCreate, TaskGet, TaskUpdate, TaskList, Skill, Agent, BackgroundAgentResultTool, TaskOutputTool, WebFetchTool, WebSearchTool)

> 注意:由于 `getOpenccBuiltinTools()` 内部走 `dyn()` 动态 import opencc-src/,在 Node+tsx 下测试可能因为 vendor Bun-only 依赖失败 — 测试用 `vi.mock` 或仅检查 `cachedTools` 数组(如果可能 mock dyn)。

### 7.2 类型检查

- `pnpm typecheck` 在 zn-agent-core 0 errors
- 现有 36 个工具 unit tests + 集成测试 + buildDefaultTools 测试全过

## 8. 验收标准

- ✅ `getOpenccBuiltinTools()` 返回 17 个工具(原 7 + 4 Task + 6 新)
- ✅ LLM 在 vendor query 路径下可调 Agent/Skill/WebFetch/WebSearch/BackgroundAgentResult/TaskOutput
- ✅ zai-server 启动不报新错误
- ✅ 所有现有测试通过(`pnpm test` 不引入新失败)
- ✅ typecheck 0 errors

## 9. 不在范围内

- 接入 `TodoWriteTool`(opencc vendor 自带) — 已被我们 4 个 Task 工具替代,vendor 路径下如出现冲突名字再处理
- 接入 `TeamCreateTool` / `TeamDeleteTool` / `SendMessageTool` — swarm 工具,后续 spec
- 接入 `BriefTool` / `ConfigTool` / `EnterPlanModeTool` / `ExitPlanModeTool` / `LSPTool` / `MonitorTool` / `REPLTool` 等 — 不属于 agent 生态,后续 spec
- 接入 `firecrawl` / `NotebookEditTool` / `PowerShellTool` / `ScheduleCronTool` / `SnipTool` / `StructuredOutputTool` / `SyntheticOutputTool` / `TaskCreateTool`(vendor 版)/ `TaskGetTool`(vendor 版)/ `TaskListTool`(vendor 版)/ `TaskStopTool` / `TeamDeleteTool` / `TungstenTool` / `VerifyPlanExecutionTool` / `WorkflowTool` 等 — 与 agent 派单无直接关系
- 写 spec 文档验证 vendor 工具在 Node 下能跑(只有 Bun runtime 测试)

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| vendor 工具(尤其 AgentTool)依赖深,Bun-only 多 | 走 dyn() + // @ts-ignore 模式(已有先例);agentRuntime.ts 已经配置 Bun-protocol loader |
| 17 个工具名列表膨胀,LLM prompt 选择成本 | 后续 spec 考虑按 sub-agent 类型动态过滤工具(`filterToolsForAgent`) |
| vendor SkillTool 已被 zai-native Skill 替代 — 如 vendor query 路径下也调 vendor SkillTool 会双重 | 在 `getOpenccBuiltinTools()` **不** import vendor 的 SkillTool,只加 zai wrapper |
| BackgroundAgentResultTool / TaskOutputTool 依赖 vendor task 系统,如果 zai 改用 JsonTaskStore 路径有差异 | zai-server 已配置 BackgroundRuntime 接 vendor task 系统,只需保证 vendor 工具可见即可 |

## 11. 实施计划

按以下顺序实施,每步可独立 commit:

1. **新增 `compat/tools/opencc/SkillTool.ts`** + wrapper 测试
2. **修改 `builtin.ts`**:增加 6 个工具到 cachedTools + 新增测试
3. **全量测试 + typecheck 验证**