# 调研报告：opencc vendor auto-memory 全貌与回补 zai 方案

> ✅ **事后核实(2026-09-23,合并阶段)**:本报告 §A0 的前置核验 ——「memdir 并未被
> strip,生产 bundle 跑的是真实实现」—— 经地面真相复核**成立**,是两份报告中判断
> 正确的那一份。据此得出的诊断(提示词早已注入、写入半边从未 init、多会话路径为
> 进程级单一)构成了最终方案的基础。
>
> 最终方案与实施记录见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 下的
> `2026-09-23-zai-auto-memory-multisession-*`。另:第三个引擎(dsh)两次启动均失败、
> 无产出。

- 仓库：`/Users/liangxuechao572/code/zn-ai-zbuddy`
- 日期：2026-09-23
- 范围：只读调研，未修改任何仓库文件（本报告除外）。
- 约定：
  - `OC` = `packages/zn-agent-core/src/opencc-src`
  - `ZAI` = `packages/zai/src`
  - `[读到的]` = 直接读到源码/构建产物；`[推断]` = 由读到的证据推导。
  - 所有 `file:line` 均相对仓库根。

> ⚠️ 重要先决结论（与任务背景描述不一致，详见 §A0）：
> **当前 zai 的运行时 bundle（`dist/opencc-core.mjs`）并没有把 `memdir/` 替换成空壳。** `scripts/strip-list.ts` 与 `compat/runtime/stripped-dirs.mjs` 的剔除只作用于 **vitest 单测 alias** 与 **legacy tsx loader**，不作用于 esbuild 生产 bundle。vendor 的**真实** `memdir` 已被打进 bundle，并且 zai 的默认 system prompt **已经注入了 auto-memory（甚至 combined auto+team）提示词**——只是写入/固化/同步机制是死的。

---

## A0. 前置事实核验：memdir 到底有没有被 strip？

### A0.1 三套解析路径

| 路径 | 机制 | memdir 是否被空壳替换 | 证据 |
|------|------|----------------------|------|
| 生产/默认运行时 | esbuild bundle `dist/opencc-core.mjs` | **否（真实 memdir）** | `packages/zn-agent-core/tsconfig.json` 的 `paths: {"src/*": ["./src/opencc-src/*"]}` 让 `src/memdir/paths.js` 解析到真实 `src/opencc-src/memdir/paths.ts`；`scripts/bundle-opencc.ts` 的 plugins 列表中**没有** stripped-dir alias plugin |
| vitest 单测 | `vitest.config.ts` alias | 是（→ `dangling-shims/opencc-stripped.ts`） | `compat/runtime/stripped-dirs.mjs:8-27` 含 `'memdir'`、`'services/extractMemories'`、`'services/autoDream'`、`'services/teamMemorySync'`；`opencc-stripped.ts:33-46` 返回 `isAutoMemoryEnabled()=false` / `loadMemoryPrompt()=''` |
| legacy tsx loader | `bun-protocol.mjs` | 已移除该分支 | `compat/runtime/bun-protocol.mjs:20` 注释“STRIPPED_DIRS matching … were removed — the bundle handles those now” |

证据（构建产物）：
- `dist/opencc-core.mjs` 中存在真实提示词串 `You have a persistent, file-based memory system` 与 `This directory already exists`（`[读到的]`，grep dist）。
- 真实 `getAutoMemPath` 被 minify 进 bundle：`Rl=ze(()=>{let e=o1t()??YQr();if(e)return e;let t=Vce(TK(),"projects");return(Vce(t,om(KQr()),zQr)+n1t).normalize("NFC")},()=>Ii())`，其中 `zQr="memory"`、`KQr`=getAutoMemBase、`Ii`=getProjectRoot、`ze`=lodash `memoize`（`[读到的]`）。空壳串 `/tmp/zai-memdir` 在 bundle 中出现次数为 **0**。
- bundle 中还包含 combined 串 `persistent, file-based memory system with two directories` 与 `shared team directory`（`[读到的]`）。
- `compat/dangling-shims/opencc-stripped.ts` 仅被 `compat/runtime/stripped-dirs.mjs`、`compat/dangling-shims/everything.cjs` 与 `vitest.config.ts` 引用，**没有任何生产 `src/**`（非 test）import 它**（`[读到的]`，grep）。

### A0.2 由此得到一个关键结论

`[推断]` zai 每个 session 的默认 system prompt 里**已经**带有 auto-memory 行为指令（当 `customSystemPrompt` 未设置时）：
- 注入点：`OC/constants/prompts.ts:593` `systemPromptSection('memory', () => loadMemoryPrompt())`，位于 `dynamicSections`，并在 `prompts.ts:664-680` 被无条件返回。
- zai **没有**传 `customSystemPrompt`：`OC/QueryEngine.ts:261,345-346` 从 `this.config.customSystemPrompt` 取；zai 构造 engine 的 config（`OC/server/createOpenccRuntime-impl.ts:454-505`）与 `submitMessage` 调用（同文件 `:939-966`）都未设置。仅在 `compat/repl/createReplSession.ts:501` 显式设为 `undefined`。
- `getSystemPrompt` 未被跳过：`OC/utils/queryContext.ts:57-68`，`customSystemPrompt === undefined` 时调用 `getSystemPrompt(...)`。
- zai 未设 `CLAUDE_CODE_SIMPLE`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`（`[读到的]` grep 无命中），故 `isAutoMemoryEnabled()` 走默认 `true`（`OC/memdir/paths.ts:33-72`）。
- `isTeamMemoryEnabled()` 默认也为 `true`（`OC/memdir/teamMemPaths.ts:73-78`，`getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', true)`），因此实际注入的是 **combined（auto+team）** 提示词（`OC/memdir/memdir.ts:470-497` → `teamMemPrompts.buildCombinedMemoryPrompt`）。
- 记忆目录：`getAutoMemPath()` = `getMemoryBaseDir()/projects/<sanitizePath(getAutoMemBase())>/memory/`，其中 `getMemoryBaseDir()` 因 zai 补丁返回 `~/.zai`（`OC/utils/envUtils.ts:15-24`），`getAutoMemBase()` = `findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()`（`OC/memdir/paths.ts:220-222`）。

`[推断]` 即：**提示词在、行为指令在、目录路径在，但自动抽取（extractMemories）/固化（autoDream）/团队同步（teamMemorySync）在 zai 里全部不运行**（见 §A5/A6/A7）。此外该目录在 zai 是**进程级单一**（见 §B13），并非 per-session。

---

## A. vendor auto-memory 全貌

### A1. `memdir/paths.ts` — 路径解析与开关链

文件：`OC/memdir/paths.ts`（共 295 行）

**常量**
- `AUTO_MEM_DIRNAME = 'memory'`、`AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'`：`paths.ts:109-110`。

**开关链 `isAutoMemoryEnabled()`**：`paths.ts:33-72`
1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` truthy → `false`；defined-falsy → `true`（`:34-40`）。
2. `CLAUDE_CODE_SIMPLE` truthy → `false`（`:44-46`）。
3. `CLAUDE_CODE_REMOTE` truthy 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → `false`（`:47-52`）。
4. 遍历 `getEnabledSettingSources()`，任一 source 的 `autoMemoryEnabled===false` 或 `memory.autoWrite===false` → `false`（`:53-69`，`false` 永远胜出，防止窄作用域覆盖父作用域 opt-out）。
5. 默认 `true`（`:70-71`，`return sawExplicit || true`——恒 true）。
> `[推断]` 第 5 步写法等价于“只要没有显式 false 就 true”，`sawExplicit` 实际无意义。

**后台抽取门 `isExtractModeActive()`**：`paths.ts:86-94`
- 需 GrowthBook `tengu_passport_quail` 为 true，且（非交互会话 或 `tengu_slate_thimble`）。zai `interactive:true`（`ZAI/server/services/agentRuntime.ts:748`），故条件退化为“flag 为 true”。`[读到的]`

**base dir**
- `getMemoryBaseDir()`：`CLAUDE_CODE_REMOTE_MEMORY_DIR` 优先，否则 `getClaudeConfigHomeDir()`（zai 补丁 = `~/.zai`）：`paths.ts:102-107`。

**override 与安全校验**
- `validateMemoryPath(raw, expandTilde)`：`paths.ts:126-167`。拒绝：相对路径、长度<3 的近根路径、Windows 盘根、UNC（`\\`/`//`）、含 NUL；`~/` 展开仅在 `expandTilde=true`（settings 支持、env 不支持）；裸 `~`/`~/` 等会展开成 `$HOME` 或祖先的 remainder 被拒（`:139-152`）；返回带**恰好一个**尾分隔符、NFC 归一化（`:166`）。
- `getAutoMemPathOverride()`：`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`，不展开 `~`：`:178-183`。
- `getAutoMemPathSetting()`：settings 的 `autoMemoryDirectory`，**只用 policy/flag/local/user，显式排除 projectSettings**（安全理由见 `:189-195`）：`:196-203`。
- `hasAutoMemPathOverride()`：`:211-213`。

**核心路径 `getAutoMemPath`（memoize）**：`paths.ts:240-252`
```ts
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) return override
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep).normalize('NFC')
  },
  () => getProjectRoot(),        // ← memoize key
)
```
- **memoize key = `getProjectRoot()`**（`paths.ts:251`）。`[读到的]` 注释（`:236-239`）说明 key 选 projectRoot 是为了测试改 mock 时重算；env/settings 视为 session 稳定。
- `[推断]` 该设计**假设单进程单项目**：key 只有 projectRoot，不含 cwd/sessionId；env/settings 变更不会使它失效。在 zai 单进程多 session 下，同一进程内**所有 session 共享同一个 `getAutoMemPath()` 结果**（除非中途改了 `STATE.projectRoot`，而 zai 从不改，见 §B13）。
- `getAutoMemBase()` = `findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()`：`paths.ts:220-222`（worktree 共享同一目录，引 anthropics/claude-code#24382）。
- `getAutoMemEntrypoint()` = `join(getAutoMemPath(), 'MEMORY.md')`：`:274-276`。
- `getAutoMemDailyLogPath(date)` = `<autoMem>/logs/YYYY/MM/YYYY-MM-DD.md`（KAIROS 助手模式）：`:263-268`。
- `isAutoMemPath(absolutePath)`：`normalize(abspath).startsWith(getAutoMemPath())`：`:291-295`。

### A2. `memdir/memdir.ts` — 三个 prompt builder、目录创建、截断

文件：`OC/memdir/memdir.ts`（共 533 行）

**常量/截断**
- `ENTRYPOINT_NAME='MEMORY.md'`（`:31`）；`MAX_ENTRYPOINT_LINES=200`（`:32`）；`MAX_ENTRYPOINT_BYTES=25_000`（`:35`）。
- `truncateEntrypointContent(raw)`：`:54-115`。先 `trim` → 行数/字节数（`Buffer.byteLength`，正确处理 CJK/emoji 多字节）→ 超限时先按 200 行截、再按 25000 字节在最后一个换行处截、并回退避免切断多字节字符；末尾追加 `> WARNING: MEMORY.md is ... Only part of it was loaded...`（`:99-114`）。
- `DIR_EXISTS_GUIDANCE` / `DIRS_EXIST_GUIDANCE`：告诉模型目录已存在、直接用 Write，不要 `mkdir`：`:128-131`。
- `ensureMemoryDirExists(memoryDir)`：`fs.mkdir`（recursive，吞 EEXIST）+ 错误只 debug 日志，不抛：`:141-159`。由 `loadMemoryPrompt` 每 session 一次调用。

**三个 builder 的区别与用途**

| builder | 行 | 内容 | 何时用 |
|---------|----|------|--------|
| `buildMemoryLines(displayName, memoryDir, extraGuidelines?, skipIndex?)` | `:211-288` | 只含**行为指令**（types / what-not-to-save / how-to-save / when-to-access / trusting-recall / persistence / searching-past-context），**不含 MEMORY.md 内容** | `loadMemoryPrompt`（system prompt；内容改由 user context 注入）与 `buildMemoryPrompt` 共用 |
| `buildMemoryPrompt({displayName,memoryDir,...})` | `:294-338` | `buildMemoryLines` + **读入并截断 MEMORY.md**（`readFileSync`，`skipIndex` 默认 false → 两步保存法），或“currently empty”占位 | agent memory（无 `getClaudeMds()` 等价物）——`agentMemory.loadAgentMemoryPrompt` |
| `loadMemoryPrompt()` | `:441-533` | **system prompt 入口**：按 `isTeamMemoryEnabled()` 分派 combined / auto；KAIROS 分支；禁用时返回 `null` + telemetry | `prompts.ts:593` 的 `systemPromptSection('memory', ...)` |

- `buildMemoryLines` 的 `howToSave` 分两态：`skipIndex=true`（`tengu_moth_copse`，只写 topic 文件不维护索引）与默认的两步法（写 topic 文件 + 在 `MEMORY.md` 加一行指针）：`:221-250`。
- `loadMemoryPrompt` 分支：combined（team enabled）`:470-497`（调用 `ensureMemoryDirExists(teamDir)`——因 teamDir 是 autoDir 子目录，递归创建顺带建 autoDir）；auto-only `:499-516`；禁用 `:518-532`。
- `buildAssistantDailyLogPrompt`：KAIROS 日志模式，`:349-392`；但当前被硬关：`:454` `if (false && autoEnabled && getKairosActive())`（`[读到的]`）。
- `buildSearchingPastContextSection(autoMemDir)`：`:397-429`，受 `tengu_coral_fern` 门控（默认 false → 当前不注入）。

### A3. `memdir/memoryTypes.ts` — 要写进 system prompt 的行为指令（可整段搬运）

文件：`OC/memdir/memoryTypes.ts`（共 273 行）。这批文本是回补时**最应原样搬运**的资产（英文系统提示词，符合 zai AGENTS.md 规则）。

- 四类记忆taxonomy `MEMORY_TYPES = ['user','feedback','project','reference']`：`:16-21`；`parseMemoryType`：`:30-33`。
- `TYPES_SECTION_INDIVIDUAL`（单目录版，无 `<scope>`）：`:115-180`。
- `TYPES_SECTION_COMBINED`（含 private/team `<scope>`，含 example 对白）：`:39-108`。
- `WHAT_NOT_TO_SAVE_SECTION`：`:185-197`。要点：代码模式/架构/文件路径/项目结构（可从现状推导）、git 历史、debug 修复配方、AGENTS.md 已记录内容、临时任务细节**都不保存**；并含“即使用户明确要求保存也要先问‘哪里 surprising’”（`:196`）。
- `WHEN_TO_ACCESS_SECTION`：`:218-224`（何时访问 + `ignore memory` 的反模式）；`MEMORY_DRIFT_CAVEAT`：`:203-204`（记忆会过期，回答前核对现状）。
- `TRUSTING_RECALL_SECTION`：`:242-258`（标题为 `## Before recommending from memory`；命名“记忆里的 file/function 是写入时快照，推荐前必须核对”——eval 验证过位置敏感）。
- `MEMORY_FRONTMATTER_EXAMPLE`：`:263-273`（`name/description/type` frontmatter 模板）。

### A4. `memoryScan` / `findRelevantMemories` / `memoryAge` / `teamMemPaths` / `teamMemPrompts`

- `memoryScan.ts`（`:1-255`）：`scanMemoryFiles(memoryDir, signal)` `:66-71`，深度受限（`MAX_DEPTH=3` `:26`）遍历 `.md`（排除 `MEMORY.md` `:154-155`）、并发读 frontmatter（`HEADER_READ_CONCURRENCY=8` `:27`，`FRONTMATTER_MAX_LINES=30`、`MAX_BYTES=64KB` `:24-25`），保留最新 `MAX_MEMORY_FILES=200` `:23`；`formatMemoryManifest` `:245-255` 输出 `[type] filename (ts): description`。被 `findRelevantMemories` 与 `extractMemories` 复用。
- `findRelevantMemories.ts`（`:1-142`）：query-time recall。`findRelevantMemories(query, memoryDir, signal, recentTools, alreadySurfaced)` `:39-77` → `selectRelevantMemories` `:79-142` 用 `sideQuery` 调 Sonnet 选 ≤5 个文件（JSON schema，`:100-123`）。消费者：`OC/utils/attachments.ts:2447-2451`（相关记忆预取附件）与 `:2600` 门控。
- `memoryAge.ts`（`:1-53`）：`memoryAgeDays` / `memoryAge` / `memoryFreshnessText` / `memoryFreshnessNote`（>1 天记忆加 `<system-reminder>` 过期提示）。
- `teamMemPaths.ts`（`:1-292`）：`isTeamMemoryEnabled()` `:73-78`（依赖 auto memory，默认 true）；`getTeamMemPath()` = `<autoMem>/team/` `:84-86`；`getTeamMemEntrypoint()` `:92-94`；写入/键校验 `validateTeamMemWritePath` `:228-256`、`validateTeamMemKey` `:265-284`（含 realpath 深祖先、符号链接逃逸、`PathTraversalError`）；`isTeamMemPath`/`isTeamMemFile` `:214-220,290-292`。
- `teamMemPrompts.ts`（`:1-113`）：`buildCombinedMemoryPrompt` `:25-113`（auto+team 双目录合并 prompt，含 `## Memory scope`、敏感数据禁止写入 team 的说明 `:91`）。

`[推断]` 必需度：`memoryScan` + `memoryAge` + `memoryTypes` 是刚需；`findRelevantMemories` 是 query-time recall（可选，二期）；`teamMemPaths`/`teamMemPrompts` 仅当启用 team（zai 无团队后端，建议关掉，见 §C）。

### A5. `services/extractMemories/` — turn 结束后的自动抽取后台 agent

- 触发点：`OC/query/stopHooks.ts:158-178`。`handleStopHooks`（定义 `:74`）在 `!isBareMode()` 且 `!toolUseContext.agentId` 且 `isExtractModeActive()` 时 `void executeExtractMemories(stopHookContext, toolUseContext.appendSystemMessage)`（`:163-174`）。`handleStopHooks` 由 `OC/query.ts:2171-2181` 每个 query loop 末调用。
- 初始化：`initExtractMemories()` 只在 `useEffect`/TUI 路径被调——`OC/utils/backgroundHousekeeping.ts:28-36`（`startBackgroundHousekeeping`），而它只被 `OC/main.tsx:2906` 与 `OC/screens/REPL.tsx:4258` 调用。**zai headless 从不调用** → `extractor`/`drainer` 为 null/空 no-op（`extractMemories.ts:279-288`）。`[读到的]`
- 门禁（`executeExtractMemoriesImpl`）：`:569-598`——仅主 agent（`!context.toolUseContext.agentId` `:574`）；`tengu_passport_quail` `:578`；`isAutoMemoryEnabled()` `:587`；**非** `isMemoryWriteApprovalRequired()` `:591`；**非** `getIsRemoteMode()` `:596`。
- 机制：`runForkedAgent`（完美 fork，共享父 prompt cache）：`extractMemories.ts:419-433`；`maxTurns:5`，`skipTranscript:true`（避免与主线程 transcript 竞争 `:426-428`）；只允许 Read/Grep/Glob + 只读 Bash + 仅 memory 目录内 Edit/Write（`createAutoMemCanUseTool` `:171-222`，被 autoDream 复用）。
- prompt：`services/extractMemories/prompts.ts`。`buildExtractAutoOnlyPrompt` `:55-99`、`buildExtractCombinedPrompt` `:106-151`、共享 `opener(newMessageCount, existingMemories)` `:34-49`（要求 turn1 并行读、turn2 并行写；只许用最近 N 条消息，不得核实源码）。预注入现存文件清单（`formatMemoryManifest(scanMemoryFiles(...))` `:402-404`）。
- 与主 agent 去重：`hasMemoryWritesSince(messages, sinceUuid)` `:121-148`——若 cursor 之后有 assistant 的 Write/Edit 命中 `isAutoMemPath`，则跳过 fork 并把 cursor 推进（`:351-363`）。
- 并发/重入：闭包内 `inProgress` + `pendingContext` 尾跑（`:603-615`、`:542-564`）；新调用到来时 abort 当前（`MEMORY_EXTRACTION_SUPERSEDED_ABORT_REASON` `:67`）并 stash 最新 context；`drainer` 供进程退出前 flush（`:628-635`、`:660-664`）。cursor `lastMemoryMessageUuid` 按闭包单例（`:307`）。
- `[推断]` 关键多会话坑：`initExtractMemories` 的 `extractor`/cursor/`inProgress` 是**模块级单例**（`:279-288`），一旦 zai 单进程初始化一次，N 个 session 会共享同一 cursor 与重入锁——见 §B14。

### A6. `services/autoDream/` — 固化（consolidation）

- 触发：`OC/query/stopHooks.ts:175-177` `void executeAutoDream(...)`（同样需 `!agentId`；无需 `isExtractModeActive`，自身门控在 `autoDream.isGateOpen()`）。
- 门（`autoDream.ts:97-103` → 时间门 `:133-144` → 扫描节流 `SESSION_SCAN_INTERVAL_MS=10min` `:58,146-154` → 会话门 `:156-174`（`minSessions` 默认 5）→ 锁 `:176-193`）：`isGateOpen` 要求非 KAIROS、非 remote、`isAutoMemoryEnabled()`、非 approval-required、`isAutoDreamEnabled()`（`config.ts:13-21`：settings `autoDreamEnabled` 或 GB `tengu_onyx_plover.enabled`）。默认阈值 `minHours=24, minSessions=5`（`autoDream.ts:65-68`）。
- 做什么：`buildConsolidationPrompt(memoryRoot, transcriptDir, extra)`（`consolidationPrompt.ts:10-65`）四阶段：Orient（ls/读 MEMORY.md/浏览 topic）→ Gather（日志/漂移/转录 grep）→ Consolidate（写/更新 topic 文件）→ Prune & index（MEMORY.md <200 行 & <25KB）。以 `runForkedAgent` 跑（`autoDream.ts:227-236`），工具约束同 `createAutoMemCanUseTool`。
- 锁：`consolidationLock.ts`。锁文件 `<autoMem>/.consolidate-lock`（`LOCK_FILE` `:16`），**mtime = lastConsolidatedAt**（`:29-36`），body = PID（`:72`），`HOLDER_STALE_MS=1h` PID 复用保护（`:19,60-68`）；`tryAcquireConsolidationLock` `:46-84`；`rollbackConsolidationLock` `:91-108`；`listSessionsTouchedSince` `:118-124`（按 per-cwd transcript mtime）。
- 任务态：`registerDreamTask/addDreamTurn/completeDreamTask/failDreamTask`（`OC/tasks/DreamTask/DreamTask.ts`，目录存在）。

### A7. `services/teamMemorySync/` — 团队同步（对 zai 适用性低）

- 导出：`index.ts` `pullTeamMemory` `:862`、`pushTeamMemory` `:981`、`syncTeamMemory` `:1245`、`isTeamMemorySyncAvailable` `:854`、`createSyncState` `:156`、`hashContent` `:169`、`batchDeltaByBytes` `:461`。
- `watcher.ts`：`startTeamMemoryWatcher` `:287-340`（需 `isTeamMemoryEnabled()` + `isTeamMemorySyncAvailable()` + github.com remote `getGithubRepo()` `:294-301`）；`fs.watch({recursive:true})` 2s 防抖 push `:202-243,34`；`stopTeamMemoryWatcher` 退出 flush `:362-387`；`notifyTeamMemoryWrite` `:349-354`。
- `secretScanner.ts`：`scanForSecrets` `:277`、`redactSecrets` `:312`；`teamMemSecretGuard.checkTeamMemSecrets` `:16`，被 `FileWriteTool.ts:10` 与 `FileEditTool.ts:9` 调用（写 team 记忆前扫密钥）。
- 触发启动：`OC/setup.ts:354` 动态 import watcher；`utils/sessionFileAccessHooks.ts:34`。
- `[推断]` 适用性：teamMemorySync 依赖 OAuth + github.com remote + 远端 team server，zai 是纯本地、无鉴权、无远端记忆服务；不建议回补，应显式关闭 team 记忆（令 `isTeamMemoryEnabled()` 返回 false），否则目前注入的 combined prompt 会长期误导模型（见 §C）。可复用的是 `secretScanner`/`checkTeamMemSecrets` 思路（若未来允许写共享记忆）。

### A8. memory prompt 的注入点与缓存语义

- 注册：`OC/constants/prompts.ts:593` `systemPromptSection('memory', () => loadMemoryPrompt())`，在 `dynamicSections`；`:661-680` 解析并拼进最终 system prompt。
- 机制：`OC/constants/systemPromptSections.ts:20-25`（`systemPromptSection` = 非 cacheBreak）；`resolveSystemPromptSections` `:43-58`：**若 cache 命中直接用缓存值，否则 `compute()` 后写入**。
- 缓存粒度：`OC/bootstrap/state.ts:210`（`systemPromptSectionCache: Map<string,string|null>`，在进程单例 `STATE`）、`:407`（`new Map()`）、`:1753-1765`（getter/setter/clear）。
  - `[推断]` **缓存是进程级（process-wide）的**，不是 per-session。首个 session 算出 memory 段后，后续所有 session 复用同一段文本（含同一 `getAutoMemPath()` 路径），直到 `/clear` 或 `/compact` 调 `clearSystemPromptSections()`（`systemPromptSections.ts:65-68`；`clearSystemPromptSectionState` `state.ts:1764-1766`）。
- 失效条件：仅 `/clear`、`/compact`。**env / settings / cwd / session 变化不会失效**。`[读到的]`（注释 `paths.ts:236-239` 也确认“env vars/settings.json/CLAUDE_CONFIG_DIR 视为 session 稳定”）。

### A9. `utils/claudemd.ts` 与 auto-memory 的关系

- `getAutoMemEntrypoint()` 的使用：`OC/utils/claudemd.ts:989-1001`——`isAutoMemoryEnabled()` 为真时把 `MEMORY.md`（type `'AutoMem'`）作为 memory file 读入并去重；team 版本 `teamMemPaths.getTeamMemEntrypoint()` `:1004-1016`（type `'TeamMem'`）。这些随后进入 `getUserContext().claudeMd`（`OC/context.ts:171` `getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))`）。
- 另一处：`OC/utils/config.ts:2077-2097` `getMemoryPath('AutoMem')` → `getAutoMemEntrypoint()`（`:2089-2090`）。
- `[推断]` 关系：`memdir` 负责**行为指令 + 写路径**；`claudemd` 负责把 `MEMORY.md` **内容**作为 user context 注入。二者通过 `getAutoMemEntrypoint()` 耦合。zai 的 `compat/memory/loader.ts` **完全不涉及**这条链（见 B2）。

### A10. `tools/AgentTool/agentMemory.ts` — subagent memory

- 三种 scope：`user` = `<memoryBase>/agent-memory/<agentType>/`（`agentMemory.ts:63`）；`project` = `<cwd>/.zai/agent-memory/<agentType>/`（`:59`）；`local` = `<cwd>/.zai/agent-memory-local/<agentType>/`（`:29-44`）。
- `isAgentMemoryPath` `:68-104`；`getAgentMemoryEntrypoint` `:109-114`；`loadAgentMemoryPrompt(agentType, scope)` `:138-177`（用 `buildMemoryPrompt` + scope note，`ensureMemoryDirExists` fire-and-forget）。
- 门控：`loadAgentsDir.ts:448,474,665,729` 与 `utils/plugins/loadPluginAgents.ts:195,215` 均要求 `isAutoMemoryEnabled() && memory && tools!==undefined`。
- 写权限：`filesystem.ts:1680-1689`——`isAgentMemoryPath` 命中直接 `allow`（无审批）。
- 与主 agent 区别：主 agent 用 `getAutoMemPath()`（每项目一个共享目录，全库索引 `MEMORY.md`）；subagent 用 per-agentType 目录、prompt 是 `buildMemoryPrompt`（含内容）、scope 提示不同（`:143-156`）。

---

## B. 回补到 zai 的落点

### B1. zai 的 system prompt 在哪里组装 / 插入点

- `[读到的]` zai **不自建** systemPrompt/userContext/systemContext；它只把 `prompt/cwd/sessionId/model/permissionMode/provider*` 传进 vendor：
  - `ZAI/server/routes/agent.ts:1393-1459`（`getRuntime().query({...})`，无 systemPrompt 字段）。
  - `ZAI/server/services/agentRuntime.repl.ts:156-185`（`ReplRuntime.query` → `this.openccRuntime.query`）。
  - `OC/server/createOpenccRuntime-impl.ts:795-1024`：per-session `engines` Map（`:507`）、`engine.submitMessage(...)`（`:939`）、`runWithSdkContext(sdkCtx,...)`（`:981-1005`）。
  - `OC/QueryEngine.ts:225-393`：`fetchSystemPromptParts`（`:347-359`）→ `userContext`（`:361-367`）→ `memoryMechanicsPrompt`（`:375-378`，仅当 `customSystemPrompt!==undefined && hasAutoMemPathOverride()`）→ 主 agent slot（`:380-387`）→ 最终 `asSystemPrompt([...])`（`:389-393`）。
- 插入点候选：
  1. **vendor `prompts.ts:593` 的 `systemPromptSection('memory', ...)`**（已存在；回补后只需让 `initExtractMemories` 生效并决定是否注入）。
  2. **zai 主 agent 插槽**：`createOpenccRuntime-impl.ts:472-476` `systemPromptSlot: (origin) => resolveBoundSlot('systemPrompt', origin)`（zai 可在此注入/改写 memory 段，按 session 定制）。
  3. `QueryEngine.ts:375-378` 的 `memoryMechanicsPrompt` 路径（需 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`，zai 当前不用）。

### B2. zai 当前 memory = `compat/memory/loader.ts`（zai-native 模式）

- `[读到的]` `packages/zn-agent-core/src/compat/memory/loader.ts`（196 行）：
  - 向上逐级收集 `AGENTS.md` 直到 `.git` 或根（`walkParentDirsForAgents` `:132-152`，root→leaf）。
  - 读 cwd 的 `AGENTS.local.md`（仅 cwd，不向上）`:78-88`。
  - 递归展开 `@include`（`MAX_INCLUDE_DEPTH=5` `:34`，`processIncludes` `:168-195`，cycle guard）。
  - per-cwd `Map` 缓存 `:40`；`clearMemoryCache()` `:104`；`hasExternalIncludes()` `:112`；best-effort 永不抛。
  - 头部明确 `auto-memory` 属于 **“Out of scope (future PRs)”**（`:13-21`）。
- 消费方：`ZAI/server/services/agentRuntime.ts:57-60`（watcher + `hasExternalIncludes`）、`:787` `startMemoryWatcher({cwd})`、`:777-778` stop、`:790-799` 外部 include 告警；`ZAI/server/services/commands/builtin/clear.ts:36` `clearMemoryCache()`。
- `[推断]` **该 loader 并未把 AGENTS.md 注入模型**（没有 opencc-src 文件 import 它）；真正进模型的是 vendor `getMemoryFiles`/`claudemd`。`compat/memory` 目前只用于 watcher 告警与 `/clear`。

### B3. zai 会话生命周期 & turn-end hook

- `[读到的]`
  - `runQueryLoop` 的 `finally`：`ZAI/server/routes/agent.ts:1837-1888`——`releaseSessionController`（`:1862`，此后 `hasActiveQuery=false`）、`flushPendingBashNotifications`（`:1870`）、`flushSessionInboxNextStep`（`:1885`）、`flushVendorCommandQueue`（`:1886`）。**这是最自然的 zai 侧 turn-end 挂点**。
  - `runNextInQueue` 的 `finally`：`ZAI/server/routes/agent.ts:1012-1025`——`sessionRunning.delete`（`:1015`）、`getSessionInbox(sid).clearRunning(sid)`（`:1016`）、`void runNextInQueue(sid)`（`:1024`）。
  - vendor 侧：`OC/query.ts:2171-2181` → `handleStopHooks`（`OC/query/stopHooks.ts:74`），已经内含 extract/dream 叉路。
- 可复用组件：
  - `sessionInbox.ts`：`followup` `:108`、`steer` `:125`、`inject` `:131`、`consumeNextTurn` `:135`、`consumeNextStep` `:141`、`clearRunning` `:227`（turn 结束兜底，注释明确）、`getSessionInbox` `:341`、`setSessionInboxWakeHandler` `:332`。
  - `eventBus.ts`：`emit` `:133`、`subscribe` `:283`、`subscribeTopics` `:263`、per-sid history。
  - `backgroundRuntime.ts`：`initBackgroundRuntime` `:76`、`cancelBackgroundTasksByParentSession` `:309`。
  - `historyArchive.ts`：task-factory 终态归档，**与 turn 无关**，不可复用。
  - `sessionAgentRegistry.ts`：`sessionId→agents` 索引，`registerSessionAgent` `:32`（子代理终态时由 `subagentNotifier.ts:79` 调）。
- `[推断]` 推荐在 `routes/agent.ts:1837-1888` 的 finally 里 fire-and-forget 触发 per-session 抽取，完成后用 `sessionInbox.followup(sid, {…})` 唤醒（与现有 flush 语义一致）。

### B4（原清单 B13）多会话适配：vendor `getAutoMemPath` 在 zai 的具体冲突

`[读到的]` 基础事实：
- zai 单进程多 session：per-session `engines` Map（`OC/server/createOpenccRuntime-impl.ts:507`）、per-session abort（`:511`）、per-session cwd `CwdStore`（`compat/cwdStore.ts:20`，内存 Map，`set/get/getOrInit/delete` `:23-44`）。
- `CwdStore` 会**中途变化**：Bash `pwd -P` 回写（`compat/tools/opencc/bashCwdWrap.ts:93,113`）、session 创建/切换（`routes/agent.ts:2078-2080`）、删除时 `delete`（`:2128`）。
- vendor 状态是**进程级单例** `STATE`：`OC/bootstrap/state.ts:437`（`const STATE = getInitialState()`），初始化自 `process.cwd()`（`:285-286,302`，`originalCwd/projectRoot/cwd` 全等于 `resolvedCwd`）。
- zai 只设置 `originalCwd/cwd`（`OC/server/createHeadlessContext-impl.ts:163-164`），**从不调用 `setProjectRoot`**（全仓库 grep 无命中）。
- `getProjectRoot()` 只返回 `STATE.projectRoot`（`state.ts:596-598`），不受 sdk context 影响；`getOriginalCwd()` 才读 sdk ctx（`:584-587`）。
- 每次 query 的 sdk ctx 用**实例级常量 cwd**（`createOpenccRuntime-impl.ts:981-984`，`cwd = options.defaultCwd ?? process.cwd()` `:98`；`ZAI/server/services/agentRuntime.ts:230` `const cwd = serverCwd ?? process.cwd()`，`:858` `getServerCwd`）。

`[推断]` 逐条冲突 / 需改点：

| # | 冲突 | 证据 | 需要改的点 |
|---|------|------|-----------|
| 1 | `getAutoMemPath` memoize key 仅 `getProjectRoot()`，而 projectRoot 是进程级常量 | `memdir/paths.ts:240-252,251`；`state.ts:596-598` | 改成 key 含 `sessionId`/逻辑 cwd，或改成非 memoize 的 per-session 解析；或在每 query 用 `CwdStore.get(sid)` 计算后经 override 注入 |
| 2 | `getProjectRoot()` 从不更新，等于 zai 进程启动 cwd，**不等于 session 逻辑 cwd** | 无 `setProjectRoot`；`CwdStore` 仅存内存 | 引入 per-session projectRoot：每 query 前 `setProjectRoot(resolve(cwd))`（注意 sdk ctx 未覆盖 projectRoot，需另用 ALS 或改为读 ctx） |
| 3 | `getMemoryBaseDir()` = `~/.zai`，`getAutoMemPath` = `~/.zai/projects/<gitroot>/memory/`（进程单一路径） | `paths.ts:102-107,246-249`；`envUtils.ts:15-24` | 若要 per-session 隔离：改用 `sessionId` 维度目录（如 `~/.zai/projects/<cwd-slug>/sessions/<sid>/memory/`）或按 session cwd 分段 |
| 4 | `systemPromptSectionCache` 进程级，首个 session 的 memory 段被所有 session 复用 | `state.ts:1753-1765`；`systemPromptSections.ts:43-58` | 若要 per-session 路径/内容：把 memory 段改为 `DANGEROUS_uncachedSystemPromptSection`，或按 session 清缓存，或在 zai `systemPromptSlot` 里动态拼 |
| 5 | team 记忆默认开启且路径为 `<autoMem>/team` | `teamMemPaths.ts:73-78,84-86`；bundle 含 combined 串 | 显式关闭 team（settings `memory.autoWrite`/GB），或让 `isTeamMemoryEnabled()` 在 zai 返回 false |
| 6 | `ensureMemoryDirExists` 在 approval-required 时**不**建目录，但 prompt 文案说“目录已存在” | `memdir.ts:481-483,503-505`；`governancePolicy.ts:25-38` 默认 true | 决定 approval 策略后统一：要么关 approval 让 mkdir 生效，要么改文案 |
| 7 | `getAutoMemEntrypoint()`（claudemd 注入 `MEMORY.md` 内容）同样是进程单一路径 | `claudemd.ts:989-1001`；`paths.ts:274-276` | 同 #1/#2，需 per-session |
| 8 | 实例隔离 vs session 隔离：受管子实例是不同的 OS 进程、不同 `process.cwd()`，天然隔离；session 隔离则无 | `instanceSupervisor.ts:288-319`（spawn `cwd`）；`state.ts:437` | 若要“每 session 独立记忆”，必须补 session 层；若接受“每实例/每进程一份”，可暂时不动 |
| 9 | `getAutoMemBase()` 用 `findCanonicalGitRoot(getProjectRoot())`，session 若在不同 repo 会落到错误的 git root | `paths.ts:220-222` | 需在每次 query 用 session cwd 重算 git root |

> 注意：`[推断]` 这与 zai 现有 `CwdStore` 的设计意图（per-session 逻辑 cwd）是冲突的——vendor memory 路径链完全没有接入 `CwdStore`。

### B5（原清单 B14）并发写风险

- `[读到的]` vendor 自身的重入保护是**闭包级单例**：`extractMemories.ts:280-328`（`extractor`、`lastMemoryMessageUuid`、`inProgress`、`pendingContext`、`inFlightExtractions` 全在一个闭包里）。`initExtractMemories` 全进程调用一次。
- `[推断]` 在 zai 单进程 N session 并发时：
  - cursor 会被跨 session 相互推进 → session A 的抽取可能用 session B 的 `lastMemoryMessageUuid`，导致漏抽/错抽。
  - `inProgress` 会让 session B 的抽取被当作“重复”而 stash/abort，session A/B 互相取消。
  - 若同一 memory 目录被 N 个 session 同时写：`MEMORY.md` 读-改-写无原子性/无文件锁（round-trip 在 fork agent 里由模型 Write 完成），存在丢更新。
  - `autoDream` 有跨进程锁（`consolidationLock.ts`），但 extractMemories **没有**任何文件锁。
- 处理建议（`[推断]`）：per-session 化 cursor/锁（Map<sessionId, State>）；对同一 memory 目录加写锁或串行队列（沿用 `OC/consolidationLock.ts` 模式或 zai `BackgroundRuntime`）；`MEMORY.md` 索引用原子写（tmp+rename）或 append-only topic 文件 + 由固化阶段统一重建索引。

### B6（原清单 B15）权限对齐

- `[读到的]` vendor 写权限：`OC/utils/permissions/filesystem.ts:1691-1725`：
  - `isAutoMemPath && isMemoryWriteApprovalRequired && !isUnderGlobalClaudeProjects` → `behavior:'ask'`（safetyCheck，`:1700-1714`）。
  - `!hasAutoMemPathOverride && isAutoMemPath` → `behavior:'allow'`（`:1716-1725`）。
  - `isUnderGlobalClaudeProjects` = 路径以 `~/.zai/projects/` 开头（`:314-323`）。
  - agent memory：`isAgentMemoryPath` → 直接 allow（`:1680-1689`）；读路径 autoMem allow（`:1877-1887`，agent2 证据）。
- `isMemoryWriteApprovalRequired()` 默认 **true**（`governancePolicy.ts:25-38`）；只有 `memory.requireApprovalBeforeWrite:false` 才关。
- `[读到的]` zai 默认 `bypassPermissions`：`OC/server/createHeadlessContext-impl.ts:121-138`（`permissionMode = options.permissionMode ?? 'bypassPermissions'`）；`compat/permissions.ts:60-101`。
- zai 权限桥：`ZAI/server/services/permissionRegistry.ts:34-99`（仅承载 `ask` 的 out-of-band 应答）；`createHeadlessContext-impl.ts:360-369` 把 vendor `canUseTool` 包 `wrapHeadlessPermissionFn`（`OC/server/headlessPermissionBridge.ts:43-133`）。
- `[推断]` 结论：
  - 默认路径（`~/.zai/projects/...`）下 memory 写入**静默 allow**（被 `isUnderGlobalClaudeProjects` 短路），且 zai 又跑 `bypassPermissions`——即记忆写入**不会弹审批**。这与 zai 本地无审批 UI 的定位一致，但意味着“模型自动写记忆”若开启，是无感写盘。
  - 若要走审批，需要 session 用 `default` 模式，且 `routes/agent.ts` 已有 per-session `permissionMode` 透传；但 `PermissionRegistry` 只服务工具 `ask`，vendor 的 memory `ask` 会经 `wrapHeadlessPermissionFn` 转成 SSE `prompt.permission`（`agentRuntime.ts:315-348`）——理论上可复用。
  - 建议：zai 侧追加一个显式开关（setting/env），默认**关闭自动写**，开启后接受静默写（或接 permissionRegistry）。

### B7（原清单 B16）已有 spec/plan

- `[读到的]`
  - `docs/superpowers/specs/2026-07-19-zai-align-opencc-memory-design.md`：设计 zai-native slim `memoryLoader`/`memoryWatcher`；**`auto-memory 集成` 被明确列为未实现/future PR**（`:42`），并提到用 `includeAutoMemory=false` 让 vendor claudemd 降级（`:358`）。
  - `docs/superpowers/plans/2026-07-19-zai-align-opencc-memory.md`：同主题实施计划；“❌ auto-memory integration” 在“deferred to future PRs”（`:22-27`），头部“No vendored module dependencies”。
  - `docs/superpowers/plans/2026-07-28-zn-agent-core-from-opencc.md`：vendor 迁移计划，strip list 含 `services/extractMemories`（`:103`）、`services/autoDream`（`:105`）、`services/SessionMemory`（`:107`）、`services/teamMemorySync`（`:108`）、`memdir`（`:118`）。
  - `docs/superpowers/specs/2026-07-25-opencc-web-architecture-overview.md:75,468`：描述 `memoryLoader/memoryWatcher`（AGENTS.md 注入 + watcher），无 auto-memory。
  - `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-03-session-memory.md:44-46`：桥接 `compat/memory/`（AGENTS.md/rules watcher），无 auto-memory。
  - `docs/DEVELOPMENT_REFERENCE.md:113`：`compat/memory/{loader,watcher}.ts`。
  - `docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md:210-211`：指出 claude.md 热更新部分、`getMemoryFiles` 走 vendor 部分。
- `[推断]` 无任何专门的 auto-memory 回补 spec/plan；现有文档一致地把 auto-memory 视为“未来 PR”。

---

## C. 结论

### C1（原清单 C17）策略选项对比

#### 选项 (a) 解除 strip、直接把 vendor memdir 接进 zai

- 做法：在 zai 启动时 `initExtractMemories()`/`initAutoDream()`（把 `startBackgroundHousekeeping` 里两个 init 抽出来导出），并放开 `isExtractModeActive()` 的 GrowthBook 门（或加 zai 配置门）；解决 B4 的多会话路径/缓存问题、B5 的并发问题。
- 优点：复用全部现成资产（memoryTypes 指令、memoryScan、forked 抽取、锁），落地最快。**且事实上提示词已在注入**（§A0.2），只差“写”与“per-session 化”。
- 缺点/风险：
  - vendor 的单例设计（cursor、memoize、systemPromptSection cache）与 zai 多会话根本冲突，需要改 vendor（`memdir/paths.ts`、`extractMemories.ts`）——违反“最小侵入”。
  - `runForkedAgent` / `initExtractMemories` / `loadMemoryPrompt` 等**未导出到 zai**（grep 确认），需扩 `bundle-entry.ts`。
  - 仍会带入 team 记忆（默认 on）与 `lock`/transcript 扫描等不符合 zai 的语义。
  - 默认仍受 GrowthBook 控制（zai 无 GB），行为不可预期。

#### 选项 (b) 在 `compat/` 写 zai-native 精简版

- 做法：新增 `compat/memory/autoMemory.ts`（对标 `compat/memory/loader.ts`），自己实现：per-session 记忆目录、`MEMORY.md` 索引 + topic 文件、turn-end 抽取（可用 zai `BackgroundRuntime`/内联 fork 或在 finally 里 spawn 一个轻量 query）、并发控制。
- 优点：与 zai 多会话模型天然契合；不碰 vendor 单例；可精确控制目录/权限/开关；符合既有 `compat/` 模式与“小步可逆”。
- 缺点：要重写 prompt 组装/抽取逻辑（但行为指令文本可从 `OC/memdir/memoryTypes.ts` 原样搬运）；没有现成 fork 复用（`runForkedAgent` 不导出），抽取质量/成本需自测。

#### 选项 (c) 混合（推荐）

- 做法：**vendor memdir 仅作为“只读提示词/文本与扫描工具”的来源**（把它当库用，不启用其后台单例）；**路径解析、注入、抽取调度、并发控制全部走 zai `compat/` 层**。
- 具体切分：
  - 复用（vendor，只读）：`memoryTypes.ts` 的指令文本、`memoryScan.ts` 的 `scanMemoryFiles/formatMemoryManifest`、`memoryAge.ts`、`truncateEntrypointContent`。
  - 新增（compat）：`compat/memory/autoMemory.ts`（per-session 路径 + prompt 拼装 + 读 MEMORY.md 内容）、`compat/memory/extract.ts`（turn-end 抽取调度 + 并发锁 + 原子写）、`compat/memory/settings.ts`（开关/目录/是否 team）。
  - 注入：优先用 zai 主 agent `systemPromptSlot`（`createOpenccRuntime-impl.ts:472-476`）注入 memory 段（per-session），或把 vendor 的 memory 段改为受 zai 开关控制。
  - **关闭 vendor 的 auto+team 注入**：设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 或等价开关，消除当前进程级 combined 提示词（否则会与 compat 版重复/冲突）。
- 推荐理由（`[推断]`）：既保留 vendor 已验证的提示词资产（A3 文本、扫描/截断逻辑），又避免 vendor 单例与 zai 多会话的硬冲突；改动集中在 `compat/`，可单测、可回退。
- 主要风险：需要重新实现“fork 抽取”（vendor `runForkedAgent` 不导出）；若直接关掉 vendor 注入，短期内 zai 会“失去”现有（虽然无写机制的）memory 提示词，需 compat 版及时补上。

### C2（原清单 C18）最小可行回补实施步骤草案（文件级）

> 目标 MVF：**per-session 记忆目录 + system prompt 注入 + turn-end 自动抽取写入 + 基础并发保护**；team 记忆显式关闭；不引入 vendor 后台单例。

1. **开关与配置（compat）**
   - 新增 `packages/zn-agent-core/src/compat/memory/autoMemorySettings.ts`：读取 zai settings/env（如 `memory.autoEnabled`（默认 off，先灰开）、`memory.autoDreamEnabled`、`memory.dir?`），导出 `isZaiAutoMemoryEnabled()` / `getZaiMemoryDir(sessionId, cwd)`。
   - 目录：`join(ZAI_DIR, 'projects', sanitizePath(canonicalGitRoot(cwd)), 'sessions', sessionId, 'memory')`（或按项目共享：`.../memory`，二选一，建议先 project 共享 + 会话只读防冲突，见第 5 步）。
   - 验证：单测断言不同 sessionId/cwd → 不同目录；`sanitizePath` 复用 vendor。

2. **关闭 vendor 默认注入（防重复）**
   - 在 zai 启动（`ZAI/server/services/agentRuntime.ts:initAgentRuntime`）设置 `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'`（或让 `isAutoMemoryEnabled()` 走 settings `autoMemoryEnabled:false`）。
   - 验证：bundle 运行时 `loadMemoryPrompt()` 返回 null；`grep dist` 行为不变（文本仍在但不注入）；用一次真实 session 抓 system prompt 确认无 auto memory 段。

3. **复用 vendor 文本 + 组装 prompt（compat）**
   - 新增 `packages/zn-agent-core/src/compat/memory/memdirPrompt.ts`：从 `OC/memdir/memoryTypes.ts` import `TYPES_SECTION_INDIVIDUAL/WHAT_NOT_TO_SAVE_SECTION/WHEN_TO_ACCESS_SECTION/TRUSTING_RECALL_SECTION/MEMORY_FRONTMATTER_EXAMPLE`，拼出 auto-only prompt（对标 `OC/memdir/memdir.ts:buildMemoryLines`）。
   - 读入 `<memoryDir>/MEMORY.md`（可选复用 `truncateEntrypointContent`）拼到 prompt。
   - 验证：快照测试 prompt 文本稳定；目录不存在时不 mkdir（交由写入侧）。

4. **注入（zai 主 agent slot）**
   - 修改 `OC/server/createOpenccRuntime-impl.ts:472-476` 的 `systemPromptSlot`（或在 zai 侧包一层 `resolveBoundSlot('systemPrompt', origin)` 后再 push memory 段），使 memory 段按**当前 sessionId** 动态生成。
   - 或：在 `ZAI/server/routes/agent.ts` 组装 query 时透传 `systemPromptSlot`/自定义片段。
   - 验证：`/api/agent/*` 两次不同 session 的 system prompt 含各自目录路径；`/clear` 后重算。

5. **turn-end 抽取调度（zai）**
   - 在 `ZAI/server/routes/agent.ts:1837-1888` 的 `finally` 内 fire-and-forget `maybeExtractMemories({sessionId, cwd, messages, appendSystemMessage})`。
   - 新增 `packages/zai/src/server/services/autoMemory/extract.ts`：门禁（开关、非子代理、非只读模式）→ 读取最近 N 条消息 → 用 vendor `scanMemoryFiles/formatMemoryManifest` 取现存文件清单 → 运行抽取（见第 6 步）→ 通过 `sessionInbox.followup` 或 `appendSystemMessage` 回显“Saved N memories”。
   - 验证：单测 mock 抽取函数，断言 turn 结束只触发一次/每 N turn 节流；不阻塞主流程（`void`）。

6. **抽取执行器（难点：fork 不导出）**
   - 方案 A（推荐）：在 `bundle-entry.ts` 导出 `runForkedAgent`/`createCacheSafeParams`（vendor `OC/utils/forkedAgent.ts:500,137`），compat 里构造 canUseTool（允许 Read/Grep/Glob + 只读 Bash + 仅 memoryDir 内 Edit/Write，对标 `OC/services/extractMemories/extractMemories.ts:171-222`）。
   - 方案 B：用 zai `backgroundRuntime` 起一个独立轻量 query（不复用父 cache，成本高）。
   - 验证：一次真实会话后 `<memoryDir>/MEMORY.md` 出现指针、topic 文件出现内容；日志显示 cache 命中与写文件路径。

7. **并发保护（vendor 不提供）**
   - 新增 `packages/zn-agent-core/src/compat/memory/memoryLock.ts`：按 memoryDir 的进程内串行队列 + 文件锁（复用 `OC/services/autoDream/consolidationLock.ts` 的 PID/mtime 思路）；`MEMORY.md` 写入用 tmp+rename 原子替换。
   - per-session cursor：`Map<sessionId, lastUuid>`，不要用 vendor 单例。
   - 验证：并发跑两个 session 的抽取单测，断言无丢更新/无交叉 cursor。

8. **权限/可见性**
   - 写路径落在 `~/.zai/projects/...` 会被 vendor `filesystem.ts:1716-1725` 静默 allow（且 zai `bypassPermissions`）；显式接受或接 `permissionRegistry`（`ZAI/server/services/permissionRegistry.ts`）弹审批。
   - 验证：`permissionMode=default` 与 `bypassPermissions` 两种模式下写记忆的行为符合预期。

9. **团队记忆显式关闭**
   - 不实现 teamMemorySync；确保 compat 版 prompt 是 auto-only；若沿用 vendor，则让 `isTeamMemoryEnabled()` 在 zai 返回 false（settings/GB）。
   - 验证：prompt 不含 `shared team directory`。

10. **构建与回归**
    - 每次改 `packages/zn-agent-core` 后 `pnpm run build:core`（AGENTS.md 强制）；按需跑 `pnpm --filter @zn-ai/zai test <相关文件>`；跨包改动跑 `pnpm -r test`。
    - 验证：type check `pnpm -r exec tsc --noEmit`；真实会话端到端（turn 结束生成 memory、下个 session 读到）。

---

## 附：关键证据速查

| 主题 | file:line |
|------|-----------|
| `getAutoMemPath` + memoize key | `OC/memdir/paths.ts:240-252`（key `:251`） |
| `isAutoMemoryEnabled` 开关链 | `OC/memdir/paths.ts:33-72` |
| `getMemoryBaseDir`（=~/.zai） | `OC/memdir/paths.ts:102-107`；`OC/utils/envUtils.ts:15-24` |
| memory prompt 注入 + 缓存 | `OC/constants/prompts.ts:593,661-680`；`OC/constants/systemPromptSections.ts:20-58`；`OC/bootstrap/state.ts:1753-1765` |
| 行为指令文本 | `OC/memdir/memoryTypes.ts:39-273` |
| extract 触发点 | `OC/query/stopHooks.ts:158-178` |
| extract 门禁/prompt/去重/并发 | `OC/services/extractMemories/extractMemories.ts:121-148,171-222,296-636`；`prompts.ts:34-151` |
| autoDream 门/锁/prompt | `OC/services/autoDream/autoDream.ts:97-103,125-282`；`consolidationLock.ts:16-124`；`consolidationPrompt.ts:10-65` |
| teamMemorySync | `OC/services/teamMemorySync/index.ts:862,981,1245`；`watcher.ts:287-340`；`teamMemSecretGuard.ts:16` |
| zai 不在 headless 初始化 | `OC/utils/backgroundHousekeeping.ts:28-36`（仅 `main.tsx:2906`/`REPL.tsx:4258`） |
| zai 传 query（无 systemPrompt） | `ZAI/server/routes/agent.ts:1393-1459`；`agentRuntime.repl.ts:156-185`；`OC/server/createOpenccRuntime-impl.ts:795-1024` |
| zai turn-end hook | `ZAI/server/routes/agent.ts:1837-1888` 与 `:1012-1025` |
| per-session cwd | `packages/zn-agent-core/src/compat/cwdStore.ts:20-44`；`compat/tools/opencc/bashCwdWrap.ts:93,113` |
| vendor 进程级状态 | `OC/bootstrap/state.ts:437,584-629`；`OC/server/createHeadlessContext-impl.ts:163-164` |
| 写权限 carve-out | `OC/utils/permissions/filesystem.ts:1691-1725,314-323`；`OC/utils/governancePolicy.ts:25-38` |
| zai 默认 bypassPermissions | `OC/server/createHeadlessContext-impl.ts:121-138`；`compat/permissions.ts:60-101` |
| zai 现有 compat memory | `packages/zn-agent-core/src/compat/memory/loader.ts:1-196`；`watcher.ts` |
| 文档中 auto-memory 被延后 | `docs/superpowers/specs/2026-07-19-zai-align-opencc-memory-design.md:42,358`；`docs/superpowers/plans/2026-07-19-zai-align-opencc-memory.md:22-27`；`docs/superpowers/plans/2026-07-28-zn-agent-core-from-opencc.md:103-118` |