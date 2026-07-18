# Align zai AGENTS.md + system prompt with OpenCC

**Status:** Draft
**Date:** 2026-07-19
**Scope:** `packages/zai-agent-core/src/agents/`, `packages/zai-agent-core/src/runtime/{queryLoop,types,index}.ts`, `packages/zai/src/server/services/agentRuntime.ts`, `packages/zai/src/server/routes/clear.ts`, related test files

## Problem

zai (`opencc-web`) 的 AGENTS.md 加载与 system prompt 组装与上游 opencc 存在以下关键差距：

1. **AGENTS.md 加载范围受限**：`agentsMdLoader.ts` 硬编码 3 个候选路径（`{cwd}/AGENTS.md`、`{cwd}/.claude/AGENTS.md`、`~/.claude/AGENTS.md`），缺少：
   - 父目录递归向上到 git root（opencc 会沿 `.git` 边界向上找 `AGENTS.md` / `AGENTS.local.md`）
   - `.claude/rules/**/*.md` rules 目录（opencc 原生支持）
   - `@include` 递归引用（一个 AGENTS.md 可 `@./other.md` 引入其他文件）
   - frontmatter 解析（`paths: [src/**/*.ts]` glob 条件匹配）
   - `AGENTS.local.md`（用户本地不提交版本）
   - HTML 注释剥离、frontmatter 剥离、`MAX_MEMORY_CHARACTER_COUNT` 截断
2. **System prompt 非分段**：`buildSystemPrompt` 返回单字符串拼接，无 cache-break 边界，导致 Anthropic prompt cache 在 MCP / skills 变化时全量失效。
3. **无模块级缓存**：每 turn 重新 `readFile`，破坏 prompt cache 命中率。
4. **无文件监视器**：AGENTS.md 编辑后必须 `/clear` 才生效（opencc 用 `GitFileWatcher` 联动 `clearMemoryFileCaches()`）。
5. **无 external include 警告**：当一个项目通过 `@include` 引用了 cwd 外部文件时，opencc 提示用户审查；zai 静默接受。

注：`zai` 已有 `server.connected` / `server.error` / `toast` 事件（`packages/zai/src/shared/events.ts: SystemEvent.options`），本 spec 复用现有 `toast` 事件类型（`type: 'toast'`）而非新建 `system.toast`，保持 zai 现有事件命名约定。

## Goal

完整对齐 opencc 的 memory 系统 + system prompt section 架构，让 zai 在以下方面与上游一致：

- AGENTS.md / AGENTS.local.md / `.claude/rules/` 全部支持
- `@include` 递归 + frontmatter glob + HTML 注释剥离 + 超长截断
- 父目录向上递归到 git 边界
- 模块级 memoize 缓存 + 文件监视器自动失效 + `/clear` 显式失效
- `buildSystemPrompt` 返回 `string[]`（分段）+ `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 边界标记
- External include 检测 + `system.toast` 提示

## Behavior contract

| Surface | Before | After |
|---------|--------|-------|
| AGENTS.md 搜索范围 | 3 硬编码路径 | 父目录向上到 git root + cwd rules 目录递归 |
| `.claude/rules/**/*.md` | ❌ | ✅（含 frontmatter glob） |
| `AGENTS.local.md` | ❌ | ✅（仅 cwd，不向上） |
| `@include` 嵌套 | ❌ | ✅（MAX_INCLUDE_DEPTH 保护） |
| HTML 注释剥离 | ❌ | ✅（content 变但保留 rawContent，标记 `contentDiffersFromDisk`） |
| 缓存粒度 | 无（每 turn 读盘） | 模块级 memoize + watcher 失效 + `/clear` 失效 |
| `buildSystemPrompt` 返回 | `string` | `string[]`（分段数组） |
| Anthropic cache boundary | 无 | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记 |
| External include 警告 | 无 | 启动时 `console.warn` + `toast` 事件 |
| 现有 queryLoop 集成测试 | 通过 | 仍通过（类型变更向后兼容） |

## Architecture

### 模块拓扑

```
packages/zai-agent-core/src/agents/
  ├─ memoryLoader.ts          [NEW] zai-side 薄包装
  ├─ memoryWatcher.ts         [NEW] mtime 轮询 → 触发 clearMemoryCache
  └─ agentsMdLoader.ts        [DELETE] 被 memoryLoader 取代

packages/zai-agent-core/src/runtime/
  ├─ queryLoop.ts             [MODIFY] buildSystemPrompt → string[]
  ├─ types.ts                 [MODIFY] QueryOptions.systemPrompt: string | string[]
  └─ index.ts                 [MODIFY] re-export 新模块

packages/zai-agent-core/src/opencc-internals/
  └─ utils/claudemd.ts        [UNCHANGED] vendored upstream 复用
  └─ services/api/claude.ts   [UNCHANGED] 复用 SYSTEM_PROMPT_DYNAMIC_BOUNDARY

packages/zai/src/server/
  ├─ services/agentRuntime.ts [MODIFY] initMemoryWatcher + external include warning
  └─ routes/clear.ts          [MODIFY] /clear 调 clearMemoryCache
```

### 核心组件

#### 1. `memoryLoader.ts` —— zai-side 薄包装

```ts
// 直接消费 vendored getClaudeMds（已 memoize）
export async function loadMemoryForPrompt(
  cwd: string,
  options?: { includeAutoMemory?: boolean }
): Promise<MemoryFileInfo[]>

// /clear / watcher 调
export function clearMemoryCache(): void {
  clearMemoryFileCaches()  // vendored
}

// 类型 re-export
export type { MemoryFileInfo } from '../opencc-internals/utils/claudemd.js'
```

**职责边界**：
- 不在包装层加缓存（vendored 内部 `lodash-es/memoize` 已处理）
- 不重写 memory 加载逻辑（信任 vendored 与上游同步）
- 仅暴露 zai 需要的 API + re-export 类型

#### 2. `memoryWatcher.ts` —— mtime 轮询器

```ts
export interface MemoryWatcher {
  start(): void
  stop(): void
  snapshot(): Array<{ path: string; mtimeMs: number }>
}

// 全局单例
let singleton: MemoryWatcher | null = null
export function startMemoryWatcher(opts: { cwd: string }): MemoryWatcher
export function stopMemoryWatcher(): void
```

**实现细节**：
- `fs.watchFile(path, { interval: 1000 }, callback)`（Bun 兼容，参考 opencc `GitFileWatcher`）
- 首次 `start` 时枚举 cwd 下所有 memory 文件（AGENTS.md、AGENTS.local.md、`.claude/rules/**/*.md`）加入 watch 列表
- 回调里 `clearMemoryCache()` + `console.log('[memory] cache invalidated:', path)`
- `stop()` 遍历 watch 列表 `fs.unwatchFile`

#### 3. `queryLoop.ts:buildSystemPrompt` —— 切到 sectioned string[]

```ts
// 旧签名
async function buildSystemPrompt(...): Promise<string>

// 新签名
async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
  pluginAgents: AgentDefinition[] = []
): Promise<string[]>
```

**组装顺序**：
```ts
const dynamicSections = await resolveSystemPromptSections([
  systemPromptSection('memory', () => loadMemoryForPrompt(options.cwd)),
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => getMcpInstructionsSection(config?.mcpClients),
    'MCP servers connect/disconnect between turns'
  ),
  systemPromptSection('agents', () => renderAvailableAgentsSection(pluginAgents)),
  systemPromptSection('skills', () => buildSkillsSystemPrompt(skills)),
])

return [
  // 静态部分（cacheable）— Phase 2 初期为占位字符串，Phase 2 后期可迁移
  // vendored getSimpleIntroSection 以匹配 opencc 命名。
  // 实际值与 opencc `getSystemPrompt` 的 prefix 部分对齐。
  '(zai static intro — 当前 queryLoop:450 内置字符串)',
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY, // 缓存边界
  ...dynamicSections,
].filter(Boolean)
```

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 从 vendored `buildSystemPromptBlocks` 重 export。Phase 2 实施时如果发现 vendored 的 `getSimpleIntroSection` 与 zai 当前 queryLoop 内的内置字符串内容不一致，先以「zai 当前内置字符串 + boundary」作为迁移基线，后续可单独 PR 切换。

#### 4. `agentRuntime.ts` 启动接线

`initAgentRuntime(cwd)` 末尾追加：

```ts
import {
  loadMemoryForPrompt,
  startMemoryWatcher,
} from '@zn-ai/zai-agent-core'
import { hasExternalClaudeMdIncludes } from '@zn-ai/zai-agent-core/opencc-internals/utils/claudemd.js'

// 启动时检测
const files = await loadMemoryForPrompt(cwd)
if (hasExternalClaudeMdIncludes(files)) {
  console.warn('[memory] external CLAUDE.md includes detected')
  eventBus.emit({
    type: 'toast',          // 现有 SystemEvent 类型, 非 system.toast
    level: 'warning',
    title: '外部 CLAUDE.md 引用',
    message: `检测到 ${count} 个外部 include，请审查是否信任`,
  })
}

// 启动 watcher
startMemoryWatcher({ cwd })
```

shutdown 路径（SIGTERM / SIGINT）追加 `stopMemoryWatcher()`。

#### 5. `/clear` 路由

```ts
router.post('/clear', (req, res) => {
  // ... 现有清 transcript / 清 session 逻辑
  clearMemoryCache()
})
```

### 类型契约变更

```ts
// runtime/types.ts
export type QueryOptions = {
  // ...
  systemPrompt?: string | string[]  // ◀━━ 兼容旧 callers
}
```

下游 caller（`routes/agent.ts` POST /prompt、`subagentNotifier.ts` 续传）传 string 仍合法。

## 数据流（per-turn）

```
queryLoop(options, config)
  ├─ resolve cwd
  ├─ loadSkillsFromDirs(config.skillsDirs, { cwd })
  ├─ mcpClientPool.connectAll()
  ├─ loadAgentDefinitions(dataDir, userAgentsDir)
  ├─ buildSystemPrompt(options, skills, config, agents)   ◀━━ 关键路径
  │    ├─ loadMemoryForPrompt(cwd)            → MemoryFileInfo[]
  │    │    └─ vendored getClaudeMds(cwd, opts)
  │    │         ├─ 沿 .git 边界向上找 AGENTS.md / AGENTS.local.md
  │    │         ├─ 收集 .claude/rules/**/*.md
  │    │         ├─ 递归处理 @include
  │    │         ├─ 解析 frontmatter (paths glob)
  │    │         ├─ stripHtmlComments + 去 frontmatter
  │    │         └─ memoize 命中直接返回
  │    ├─ skills → buildSkillsSystemPrompt
  │    ├─ mcpClients → getMcpInstructionsSection
  │    ├─ agents → renderAvailableAgentsSection
  │    └─ return string[]
  ├─ wrapWithZaiMeta(model, { systemPrompt: string[] })
  ├─ for-await modelCaller  → events
  └─ tools execute → loop
```

## 错误处理

| 错误 | 处理 | 兜底 |
|------|------|------|
| 文件不存在 ENOENT | 静默跳过 | 不进入 prompt |
| 权限拒绝 EACCES | console.warn + 跳过 | 不阻塞 turn |
| parse 失败 | console.warn + 用 raw 文本 | 降级 |
| @include 循环 | MAX_INCLUDE_DEPTH 跳过 | 不影响主文件 |
| memoryWatcher 启动失败 | console.warn + 跳过 | 退化到无 watcher 模式 |
| buildSystemPrompt 任一 section 抛异常 | 该 section 返回 null | 其他 section 正常 |

**核心原则**：memory 加载是 best-effort 上下文增强，任何错误都不能让 turn 失败。

## Implementation outline

### Phase 1 — 替换 loader（最小可用）

1. 新增 `packages/zai-agent-core/src/agents/memoryLoader.ts`（~60 行）
2. 新增 `packages/zai-agent-core/test/agents/memoryLoader.test.ts`（~250 行）
3. 修改 `packages/zai-agent-core/src/runtime/queryLoop.ts:buildSystemPrompt` —— AGENTS.md 注入改用 `loadMemoryForPrompt`，返回类型暂保持 `string`
4. 删除 `packages/zai-agent-core/src/agents/agentsMdLoader.ts` + 旧测试
5. 修改 `packages/zai-agent-core/src/runtime/index.ts` re-export

### Phase 2 — section 化（cache 收益）

6. 修改 `queryLoop.ts:buildSystemPrompt` 返回 `string[]`
7. 修改 `runtime/types.ts:QueryOptions.systemPrompt: string | string[]`
8. 修改所有调用点适配 string[]
9. 新增 `test/runtime/queryLoop-system-prompt.test.ts`（~180 行）

### Phase 3 — 文件监视器

10. 新增 `packages/zai-agent-core/src/agents/memoryWatcher.ts`（~120 行）
11. 新增 `test/agents/memoryWatcher.test.ts`（~150 行）
12. `packages/zai/src/server/services/agentRuntime.ts:initAgentRuntime` 调用 `startMemoryWatcher({ cwd })`
13. shutdown 路径加 `stopMemoryWatcher()`

### Phase 4 — 警告与路由接线

14. `agentRuntime.ts` 启动时 `hasExternalClaudeMdIncludes` → console.warn + eventBus.emit(`type: 'toast'`)
15. `/clear` 路由调 `clearMemoryCache()`
16. 前端 `toast` 事件通道验证（现有 `useAgentStore.applySystemEvent` 已处理，0 新增组件）

## Testing

### 新增测试

| 文件 | 覆盖 |
|------|------|
| `test/agents/memoryLoader.test.ts` | 父目录递归、rules 目录、@include 循环、HTML 剥离、超长截断、ENOENT/EACCES |
| `test/agents/memoryWatcher.test.ts` | start/stop、AGENTS.md + rules 监听、mtime 变化触发 clear、不监听非 memory 文件、transient fs 错误恢复 |
| `test/runtime/queryLoop-system-prompt.test.ts` | buildSystemPrompt 返回 string[]、boundary marker、enableAgentsMd=false、sectioned 顺序 |

### 回归保护

- 现有 `test/runtime/queryLoop-mcp.test.ts` / `queryLoop-resume-2013.test.ts` / `queryLoop.test.ts` **不改 test 代码就通过**
- 手动 smoke：创建测试 AGENTS.md、`.claude/rules/*.md`、启动 zai、验证 prompt 包含预期内容

### e2e 手动测试

```bash
mkdir /tmp/test-zai-memory
cd /tmp/test-zai-memory
echo '# Project rules' > AGENTS.md
mkdir -p .claude/rules
echo '# Build rule' > .claude/rules/build.md
echo '@./build.md' > .claude/rules/main.md
# 启动 zai，确认 system prompt 包含 Project rules + Build rule
# 修改 AGENTS.md，1s 内不重启应反映新内容
```

## 成功指标

| 指标 | 测量 | 目标 |
|------|------|------|
| AGENTS.md 修改生效延迟 | 手动 | < 2s（1s watcher + 1 turn） |
| Anthropic prompt cache hit 率 | 日志 / metrics | Phase 2 后稳态提升 |
| 外部 include 检测 | 启动日志 | 100% 触发 |
| buildSystemPrompt 失败率 | smoke | 0 |
| 测试覆盖率 | `bun test --coverage` | 新模块 > 80% |

## Rollout

```
dev branch:
  PR #1 (Phase 1) → 合并 → CI → 部署 dev
  PR #2 (Phase 2) → 合并 → CI → 部署 dev
  PR #3 (Phase 3+4) → 合并 → CI → 部署 dev
  观察一周
  main merge
```

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| vendored claudemd.ts 依赖 opencc 内部 path（`src/services/analytics/...`） | 调用时通过 `includeAutoMemory=false` / `isAutoMemoryEnabled()=false` 自然降级；不引入新依赖 |
| `buildSystemPrompt` 返回 `string[]` 类型变更连锁 | Phase 2 回归覆盖到所有 caller；兼容 `string` 旧调用 |
| watcher 1s interval 增加 IO | 与 opencc 一致；测试覆盖 transient error 恢复 |
| 父目录递归在大项目下慢 | vendored 已 memoize；首次读盘后稳态零成本 |
| `MAX_MEMORY_CHARACTER_COUNT = 40000` 截断 | contentDiffersFromDisk 标记 + Edit/Write 仍要求 Read；与 opencc 一致 |
