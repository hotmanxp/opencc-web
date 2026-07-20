# zai MCP `disabledMcpServers` / `enabled/disabledMcpjsonServers` 支持 Plan

> **Status:** 缺口已复现(reproducing tests in `packages/zai/test/server/mcpConfig.test.ts` 3/3 失败),实现尚未开始。本 plan 用于指导后续 task-by-task 实施。

**Goal:** 让 `loadMcpServers` 尊重 Claude Code 的 MCP 禁用/启用字段,与 opencc 行为对齐,避免用户在 `~/.claude.json` 里禁用的 server 仍然在 zai 中生效。

**Architecture:** 在 `packages/zai/src/server/services/mcpConfig.ts` 内新增一个轻量过滤层,在 4-scope merge 之后、应用 `roots` 默认值之前做差集。`parseFile` 返回结构扩为 `{ servers, disabled, enabled }`,在 `loadMcpServers` 内按 scope 优先级合并禁用/启用集合,最终对 `byName` 做过滤。

**Tech Stack:** TypeScript / Vitest。零新增第三方依赖。

**Spec 来源:** Claude Code `~/.claude.json` schema(`mcpServers` / `disabledMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers`)。zai 当前 `mcpConfig.ts:203-233` 的 `parseFile` 是实现参考。

---

## 缺口复现(reproducing tests)

文件:`packages/zai/test/server/mcpConfig.test.ts`,新增 3 个 `GAP:` 前缀的 test。已在 2026-07-20 跑过,3/3 失败:

| Test | 预期 | 实际 | 原因 |
|---|---|---|---|
| `disabledMcpServers in user scope filters the server out` | `['keep-me']` | `['drop-me', 'keep-me']` | `loadMcpServers` 没读 `disabledMcpServers` |
| `disabledMcpjsonServers in project .mcp.json suppresses that file` | `[]` | `[should-be-gone]` | 同上 |
| `enabledMcpjsonServers is an allowlist (other servers disabled)` | `['allowed']` | `['allowed', 'not-listed']` | 同上 |

跑测试命令:

```bash
cd /Users/ethan/code/opencc-web/packages/zai && npx vitest run test/server/mcpConfig.test.ts
```

---

## 字段语义(来自 Claude Code 行为)

> ⚠️ **本 plan 假设**:zai 与 opencc 行为完全对齐。**实施前必须先核对 opencc 上游代码**(找 `getClaudeCodeMcpConfigs` 或类似函数),如果 opencc 用不同规则,以下定义作废,以 opencc 为准。

| 字段 | 作用域 | 语义 |
|---|---|---|
| `mcpServers` | 同级 | 声明 server |
| `disabledMcpServers` | user scope(`~/.claude.json` / `~/.zai.json`) | 黑名单,匹配名字 → 移除 |
| `enabledMcpjsonServers` | project scope(`./.mcp.json`) | 白名单,只有列表里的名字生效 |
| `disabledMcpjsonServers` | project scope(`./.mcp.json`) | 黑名单,与 enabled 不同时出现 |

**作用域优先级(沿用现有 `loadMcpServers`):** enterprise > user > local > project。

**冲突规则(待与 opencc 核对):**
- 同一文件内 `enabledMcpjsonServers` 与 `disabledMcpjsonServers` 互斥(出现 `enabled` 时 `disabled` 被忽略)
- 跨文件 `disabledMcpServers`(user)压过 `enabledMcpjsonServers`(project)
- 没声明 `enabled` 时,`disabled` 生效;声明了 `enabled` 时,只允许 `enabled` 列表,`disabled` 在 project scope 内被忽略

---

## 任务拆解(待实施时细化)

> 本节是骨架,真正实施时按 TDD 红绿循环,每个 task 一个 commit。

### Task 1: 扩展 `parseFile` 返回结构
- 改 `packages/zai/src/server/services/mcpConfig.ts:203`:`parseFile` 返回 `{ servers, disabled, enabled } | null`
- `McpJsonFile` type 加 `enabledMcpjsonServers?` / `disabledMcpjsonServers?` / `disabledMcpServers?`
- 不动 `servers` 解析逻辑

### Task 2: 改造 `loadMcpServers` merge 流程
- 新增辅助 `disabledByScope: Map<Scope, Set<string>>` 与 `enabledByScope: Map<Scope, Set<string>>`
- 4 个 scope 的 `apply` 同时填 servers + disabled + enabled(enterprise 路径单独处理:仍然 exclusive)
- merge 完毕后,在 `Array.from(byName.values())` 之前做过滤:
  1. 若 `enabledByScope` 非空 → 只保留出现在**所有 scope** enable 集合交集里的 server
  2. 否则 → 应用 `disabledByScope` 的并集差集
- 维持现有 `roots` 默认注入逻辑

### Task 3: 修复 reproducing tests 期望
- 移除 `// currently FAILS —` 注释
- 跑 `vitest run test/server/mcpConfig.test.ts` 应 5/5 全绿
- 跑 `npx tsc -b --noEmit` 确认无类型错误

### Task 4: 补回归测试
- `disabledMcpServers` 与 project scope `enabledMcpjsonServers` 同时存在 → user 黑名单胜
- `disabledMcpServers` 命中 enterprise scope 加载的 server → enterprise 路径仍 exclusive(不应用 user 黑名单)
- `loadMcpServers` 对未列在 `mcpServers` 里的 `disabledMcpServers` 项不报错
- `parseFile` 解析损坏 JSON 时仍返回 `null`,不抛

### Task 5: 文档 + 已知限制
- 更新 `AGENTS.md` 中 `zai` 启动所需环境小节,把 3 个字段加入"MCP 配置来源"清单
- 在 `docs/CHROME_DEVTOOLS_MCP.md`(如有)补一句"zai 已支持 `disabledMcpServers`"
- plan 文档完结时把本 `Status:` 改为 `Delivered`

---

## 全局约束

- **不动 `McpServerSpec` wire 形状**:继续向下游 `MCPClientPool.connectAll` 喂 `McpServerSpec[]`,过滤在 spec 数组层面完成
- **不动 enterprise exclusive 语义**:如果 enterprise scope 命中,直接返回(已存在,`mcpConfig.ts:131-133`)
- **错误容忍**:`disabledMcpServers` 字段类型不对(不是 string[])→ 忽略该字段,不抛
- **日志**:`/mcp` debug UI 已经用 `describeMcpSources`,必要时把 disabled/enabled 集合也展示出来(后续 PR,不阻塞本 plan)
- **测试运行命令**:`cd packages/zai && npx vitest run test/server/mcpConfig.test.ts`
- **commit 风格**:Conventional Commits,每 task 一个 commit

---

## 开放问题(实施前必须答)

1. opencc 上游的 `getClaudeCodeMcpConfigs` 是怎么处理这 3 个字段的?字段优先级是否与本 plan 一致?
2. enterprise scope 是否应该应用 `disabledMcpServers`?(我倾向"不",因为 enterprise 是 exclusive)
3. `enabledMcpjsonServers` 在 user scope (`~/.claude.json`) 是否也存在?(opencc 文档为准)

这些问题答完前不要开工 Task 2,先做 Task 1(纯重构)是没风险的。