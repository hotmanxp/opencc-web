# 调研报告:opencc vendor auto-memory 系统全貌 & 回补 zai 方案评估

> ⚠️ **事后更正(2026-09-23,合并阶段)** —— 本报告的**核心前提是错的**,阅读时务必先看这段。
>
> §0 摘要第 1 条与 §A0 断言:memdir / services/extractMemories / services/autoDream
> 在 esbuild bundle 期被 `compat/dangling-shims/opencc-stripped.ts` 空壳替换
> (`loadMemoryPrompt()→''`、`isAutoMemoryEnabled()→false`),故 zai 完全没有
> auto-memory 提示词。**实测不然**:`STRIPPED_DIRS` 只作用于 vitest alias 与 legacy
> tsx loader,不作用于生产 bundle —— `dist/opencc-core.mjs` 含真实提示词 2 处、
> `shared team directory` 1 处,空壳串 `/tmp/zai-memdir` 出现 **0** 次。
>
> 影响范围:§A 的**模块级源码分析仍然有效并被采纳**(行为指令文本、开关链、抽取/固化
> 机制、并发与多会话冲突清单);作废的是"zai 无记忆提示词""必须解除 strip 才能回补"
> "改动面反而更大"这类**结论性判断**。真实故障是「提示词全开、写入半边全瘫,且读取
> 半边在多会话下是错的」。
>
> 裁定与最终结论以 `.research/auto-memory-opencode.md` 及
> `docs/superpowers/specs/2026-09-23-zai-auto-memory-multisession-design.md` 为准。
>
> 另:第三个引擎(dsh)两次启动均失败、无产出,故 `.research/` 下只有两份报告。

- 日期:2026-09-23
- 范围:`packages/zn-agent-core/src/opencc-src/`(vendor)、`packages/zn-agent-core/src/compat/`、`packages/zai/src/server/`
- 路径缩写:`vendor/` = `packages/zn-agent-core/src/opencc-src/`,`compat/` = `packages/zn-agent-core/src/compat/`,`zai/` = `packages/zai/src/`
- 证据标注:【读】= 本次直接读到的源码行;【agent】= 来自 Explore 子代理报告(其 file:line 抽查一致);【推断】= 基于已读代码的推理,未在源码中直接确认。

---

## 0. 摘要(核心结论)

1. **memdir 是"逻辑剔除"而非物理删除**:文件都在磁盘上,但 `scripts/strip-list.ts` 把 `memdir`、`services/extractMemories`、`services/autoDream`、`services/teamMemorySync` 列入 STRIP_DIRS(bundle 期),运行时这些 import 被别名到 `compat/dangling-shims/opencc-stripped.ts` 的空壳(`isAutoMemoryEnabled()→false`、`loadMemoryPrompt()→''`、`getAutoMemPath()→'/tmp/zai-memdir/auto'`),所以 zai 今天完全无 auto-memory。【读】strip-list.ts:42-49,57;opencc-stripped.ts:34-46
2. **回补最大障碍不是提示词,而是"单进程单项目"假设**:vendor 的记忆目录解析、prompt section 缓存、extract 游标状态全部挂在进程级 STATE 上(`STATE.projectRoot`、`STATE.systemPromptSectionCache`、`initExtractMemories()` 闭包单例),而 zai 是单进程多会话、每会话独立 cwd(`CwdStore` + `runWithSdkContext` ALS)。逐条冲突见 §B13。【读】
3. **触发链已天然接好,缺两环**:zai 复用 vendor `defaultQuery`(`createOpenccRuntime-impl.ts:933-939`),turn 结束的 `handleStopHooks`(`query.ts:2171`)与主 system prompt 的 `systemPromptSection('memory', ...)`(`constants/prompts.ts:593`)都在 zai 路径上执行;缺的是 (a) `initExtractMemories()/initAutoDream()` 只在 CLI 入口调用(`backgroundHousekeeping.ts:31-32`,由 `main.tsx:2906`/`REPL.tsx:4258` 触发),zai headless 从未调用;(b) GrowthBook 云旗标在 zai 环境取默认 false,门禁(`tengu_passport_quail` 等)会把 extract 卡死。【读】
4. **推荐混合方案(c)**:prompt 文本与扫描/截断逻辑从 vendor 复制进 `compat/memory/`(zai-native),目录解析/注入/调度全部走 zai 的 per-session 机制(`systemPromptSlot` + ALS cwd),解除 strip 直连 vendor 不推荐——改动面反而更大且继承云旗标依赖。理由与步骤见 §C17/C18。

---

## A. vendor auto-memory 全貌

### A1. `vendor/memdir/paths.ts` —— 目录解析与开关链【读】

**`isAutoMemoryEnabled()`(paths.ts:33-72)完整开关链**(先定义者赢):
1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env:`1/true→OFF`,`0/false→ON`(34-40)
2. `CLAUDE_CODE_SIMPLE`(--bare)→ OFF(44-46)
3. `CLAUDE_CODE_REMOTE` 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → OFF(47-52)
4. 逐 settings source 扫描 `autoMemoryEnabled`(legacy)或 `memory.autoWrite`(alias):任一 source 显式 `false` → OFF(58-69)
5. 默认:ON(71)

**`isExtractModeActive()`(paths.ts:86-94)**:GrowthBook 云旗标 `tengu_passport_quail`(默认 false)必须为 true;且交互会话 OR `tengu_slate_thimble`。**zai 是 non-interactive 服务进程,即便解除 strip,这两个云旗标取不到 true → extract 不会跑**(回补时必须换成 zai 自己的 settings 门禁)。

**`getMemoryBaseDir()`(paths.ts:102-107)**:`CLAUDE_CODE_REMOTE_MEMORY_DIR` env ?? `getClaudeConfigHomeDir()`(即 `~/.claude`/`~/.zai` 配置主目录)。

**目录解析(`getAutoMemPath`,paths.ts:240-252)**——关键:
```
1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env(全路径 override,178-183)
2. settings autoMemoryDirectory,仅 policy/flag/local/user 四个可信源,
   故意排除 projectSettings —— 防恶意仓库把记忆目录指向 ~/.ssh(196-203,注释 189-194)
3. <memoryBase>/projects/<sanitizePath(gitRoot ?? projectRoot)>/memory/
```
- `getAutoMemBase()`(220-222):`findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()` —— 同一仓库所有 worktree 共享一份记忆。
- **memoize key = `() => getProjectRoot()`**(251):假设"单进程单项目"。`getProjectRoot()`(state.ts:596-598)读 `STATE.projectRoot`,由 headless 启动一次性设置(createHeadlessContext-impl.ts:286 `projectRoot: resolvedCwd`),`setProjectRoot`(state.ts:613-615)也是全局写。**它不读 ALS** —— 对比 `getCwdState()`(state.ts:622-624)和 `getOriginalCwd()` 都有 `runWithSdkContext` ALS 覆盖(state.ts:475-479)。
- 安全校验 `validateMemoryPath`(126-167):拒绝相对路径、根/近根(`length<3`)、Windows 盘根、UNC、null 字节;`~/` 展开拒绝裸 `~`/`~/..`。
- `hasAutoMemPathOverride()`(211-213):env override 存在 = SDK 调用方显式 opt-in 信号。
- 其他:`getAutoMemEntrypoint()`= dir+`MEMORY.md`(274-276);`getAutoMemDailyLogPath()`(263-268,KAIROS 助手模式按日期追加日志);`isAutoMemPath()`(291-295,normalize+startsWith)。

### A2. `vendor/memdir/memdir.ts` —— 三个 prompt builder【读】

| 函数 | 行号 | 用途 | 是否内嵌 MEMORY.md 内容 |
|---|---|---|---|
| `buildMemoryLines` | 211-288 | 纯**行为指令**(sync),供 system prompt 用;MEMORY.md 内容由 claudemd 通道注入(见 A9) | 否 |
| `buildMemoryPrompt` | 294-338 | lines + `readFileSync(MEMORY.md)` 截断后内嵌,给 **subagent memory**(A10)用,因为它没有 claudemd 通道 | 是 |
| `loadMemoryPrompt` | 441-533 | **调度器**(async):`isTeamMemoryEnabled()` → `buildCombinedMemoryPrompt`(471-497);仅 auto → `buildMemoryLines(...).join('\n')`(499-516);auto 禁用 → `null`(518-532) | 否 |

- 常量:`ENTRYPOINT_NAME='MEMORY.md'`、`MAX_ENTRYPOINT_LINES=200`、`MAX_ENTRYPOINT_BYTES=25_000`(31-35)。
- 截断 `truncateEntrypointContent`(54-115):先按行截 200 行,再按 UTF-8 字节截 25KB(在多字节字符边界回退,93-95),超限追加 WARNING 行(107-109)。此函数被 buildMemoryPrompt 和 claudemd 共用(注释 50-52)。
- 目录自动创建:`ensureMemoryDirExists`(141-159,幂等递归 mkdir,失败仅 debug log);在 `loadMemoryPrompt` 里当 **不需审批** 时才 mkdir(481-483、503-505)。
- `buildMemoryLines` 的审批分支:`isMemoryWriteApprovalRequired()` 为 true 时,"directory already exists" 指导换成 "先取得用户批准再写"(217-220),并在开头插入"显式询问批准"(259-264)。
- KAIROS 每日日志 prompt(349-392)在 vendor 中是死代码(`if (false && ...)` at 454)。
- Cowork 可通过 `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` env 注入额外准则(462-468)。

### A3. `vendor/memdir/memoryTypes.ts` —— 写进 system prompt 的行为指令文本【读】

四类封闭 taxonomy:`user / feedback / project / reference`(16-23)。可原样搬运的 section 常量:

| 常量 | 行号 | 要点 |
|---|---|---|
| `TYPES_SECTION_INDIVIDUAL` | 115-180 | 四类 type 的 `<when_to_save>/<how_to_use>/<examples>` XML 块;feedback 强调记录纠正**和**确认、写 Why;project 强调相对日期转绝对日期 |
| `TYPES_SECTION_COMBINED` | 39-108 | 同上 + `<scope>` private/team 标签(team 版仅配合 team memory 用) |
| `WHAT_NOT_TO_SAVE_SECTION` | 185-197 | 禁存:代码模式/架构/文件路径/git 历史/调试解法/AGENTS.md 已有内容/临时任务;**显式要求保存也要先过滤**(196) |
| `WHEN_TO_ACCESS_SECTION` | 218-224 | 何时查记忆;含"用户说 ignore memory 就当 MEMORY.md 为空"(222);含 `MEMORY_DRIFT_CAVEAT`(203-204:引用前先验证现状) |
| `TRUSTING_RECALL_SECTION` | 242-258 | "## Before recommending from memory":记忆里的 file:line 是写时的快照,推荐前先 grep/验证 |
| `MEMORY_FRONTMATTER_EXAMPLE` | 263-273 | topic 文件的 frontmatter 格式(name/description/type) |

`buildMemoryLines` 里还拼了几段不在 memoryTypes 的固定文本:`# <displayName>` 开头、两步保存法(Step1 写 topic 文件 / Step2 在 MEMORY.md 加一行索引,234-250)、"Memory and other forms of persistence"(与 plan/task 的边界,276-279)。

### A4. memdir 其余模块 —— 职责与必需性【读】

| 文件 | 职责 | 被谁调用 | MVP 必需? |
|---|---|---|---|
| `memoryScan.ts`(255 行) | 扫描记忆目录 `.md`(排除 MEMORY.md),depth≤3、上限 200 文件、8 并发读 frontmatter(66-125);`formatMemoryManifest` 生成清单文本(245-255) | `findRelevantMemories`(query 召回)、`extractMemories`(预注入清单,extractMemories.ts:402-404) | 提取阶段必需(避免 forked agent 浪费 `ls` turn);纯读工具,复制即用 |
| `findRelevantMemories.ts`(142 行) | query 时召回:扫清单 → Sonnet sideQuery 选 ≤5 个相关文件(39-77,100-123) | `vendor/utils/attachments.ts:242,2451`(relevant_memories attachment) | **否**,可选增强;依赖 `sideQuery`+`getDefaultSonnetModel`,建议 MVP 跳过 |
| `memoryAge.ts`(53 行) | "47 days ago" 式陈旧度文案 + `<system-reminder>` 包装 | attachments.ts:2565、FileReadTool.ts:773 | 否,小而可抄,读取侧体验用 |
| `teamMemPaths.ts`(292 行) | team dir = `getAutoMemPath()/team/`(84-86);`isTeamMemoryEnabled` = auto enabled ∧ GB `tengu_herring_clock`(默认 true!)(73-78);路径注入防护(sanitizePathKey 22-64、realpath 逃逸检测 109-284) | teamMemorySync、combined prompt | **否** —— zai 无同步后端,整条 team 线可砍 |
| `teamMemPrompts.ts`(113 行) | `buildCombinedMemoryPrompt` 双目录版指令 | memdir.ts:492 | 否,随 team 一起砍 |

### A5. `vendor/services/extractMemories/` —— turn 末自动抽取【读】

**触发点(完整链)**:
- `vendor/query.ts:2171` → `handleStopHooks`(每轮 query loop 结束、模型给出不含 tool_use 的最终回复时)。
- `vendor/query/stopHooks.ts:158-178`:
```ts
if (!isBareMode()) {
  ...
  if (!toolUseContext.agentId && isExtractModeActive()) {
    void executeExtractMemories(stopHookContext, toolUseContext.appendSystemMessage)  // 170
  }
  if (!toolUseContext.agentId) {
    void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)        // 176
  }
}
```
- **init 侧**:`extractMemories.ts:296 initExtractMemories()`(创建闭包状态)+ `autoDream.ts:125 initAutoDream()`,由 `vendor/utils/backgroundHousekeeping.ts:31-32` 的 `startBackgroundHousekeeping()` 调用;而 `startBackgroundHousekeeping` 全仓只有两个调用点:`main.tsx:2906` 与 `screens/REPL.tsx:4258`(均 CLI 路径)。**zai headless 链路(createOpenccRuntime-impl / createHeadlessContext-impl / zai agentRuntime)没有任何调用** → `extractor` 保持 null,`executeExtractMemories` 即使被 stopHooks 调到也是 no-op(extractMemories.ts:647-652 的 `extractor?.`)。
- `stopHookContext` 就是 `REPLHookContext{messages, systemPrompt, userContext, systemContext, toolUseContext, querySource}`(stopHooks.ts:104-111);主会话 query 还会 `saveCacheSafeParams`(116-118)供 fork 复用 prompt cache。

**门禁链(`executeExtractMemoriesImpl`,extractMemories.ts:569-598,按序)**:
1. `context.toolUseContext.agentId` 存在(subagent)→ return
2. GB `tengu_passport_quail` false → return
3. `!isAutoMemoryEnabled()` → return
4. `isMemoryWriteApprovalRequired()` → return(要审批就不允许后台自动写)
5. `getIsRemoteMode()` → return

**并发/重入防护(闭包状态,296-328)**:
- `inProgress` 布尔 + `pendingContext` stash:运行中新来的调用被合并(overwrite,最新上下文胜出),并 **abort 当前运行**(reason `memory-extraction-superseded`,609-611);当前运行的 finally 里跑 trailing extraction(552-563,trailing 免 turn 节流)。
- `lastMemoryMessageUuid` 游标:每次只处理游标之后的消息;仅成功后推进(457-460);游标因 compaction 丢失时 fallback 全量计数(104-108)。
- turn 节流:`tengu_bramble_lintel`(默认 1)每 N 个合格 turn 跑一次(378-387)。

**防与主 agent 重复写:`hasMemoryWritesSince`(121-148)**:游标之后任一 assistant 消息含 Write/Edit 到 `isAutoMemPath()` 路径 → 跳过本轮 fork 并**直接推进游标**(351-363)。即主 agent prompt 永远带完整保存指令,后台 fork 只兜底"主 agent 没写"的 turn(prompts.ts:5-9 注释)。

**fork 执行(332-565)**:`getAutoMemPath()` 取目录(342)→ `scanMemoryFiles` 预注入已有记忆清单(402-404)→ `buildExtract*Prompt`(406-417)→ `runForkedAgent`(419-433):完美 fork 主对话共享 prompt cache、`maxTurns: 5`、`skipTranscript: true`、`canUseTool=createAutoMemCanUseTool(memoryDir)`。
- **canUseTool 沙箱(171-222)**:Read/Grep/Glob 无限 allow;Bash 仅 `isReadOnly` 命令;REPL allow(内部原语会重新走本函数);Edit/Write **仅 `isAutoMemPath` 内** allow;其余全 deny。
- 产出:写过的 topic 路径 → `createMemorySavedMessage` 经 `appendSystemMessage` 注入主对话(extractMemories.ts:518-523)。
- 退出排空:`drainPendingExtraction(timeoutMs=60s)`(628-635,660-664)由 `cli/print.ts:1026` 在 shutdown 前调用 —— zai 长驻进程不需要,但**每会话删除/abort 时需要一个等价 drain**。

**prompt(prompts.ts)**:`opener`(34-49)——"You are now acting as the memory extraction subagent. Analyze the most recent ~N messages above...";声明可用工具白名单与"turn1 并行读、turn2 并行写"策略(42-44);"只用最近 N 条消息、不许 grep 源码验证"(46);"Existing memory files" 清单注入(35-38)。`buildExtractAutoOnlyPrompt`(55-99)= opener + TYPES_SECTION_INDIVIDUAL + WHAT_NOT_TO_SAVE + howToSave;`buildExtractCombinedPrompt`(106-151)= team 版(+敏感数据禁存条目 147)。

### A6. `vendor/services/autoDream/` —— 记忆固化【读】

- **做什么**:把最近若干 session 的信号固化进记忆目录 —— 4 阶段 prompt(`consolidationPrompt.ts:10-65`):Orient(ls+读 MEMORY.md)→ Gather(daily logs / 漂移检测 / `grep` transcript JSONL,禁止整读)→ Consolidate(合并进 topic 文件、相对日期转绝对、删除被证伪事实)→ Prune and index(MEMORY.md 保持 <200 行且 <25KB)。
- **触发时机**:与 extract 同一挂点(stopHooks.ts:175-176,仅主 agent)。门禁(`autoDream.ts:97-103` + `131-193`,从便宜到贵):
  1. `isGateOpen`:!KAIROS、!remote、auto enabled、**不需审批**(`isMemoryWriteApprovalRequired()→false`)、`isAutoDreamEnabled()`(config.ts:13-21:`settings.autoDreamEnabled` ?? GB `tengu_onyx_plover.enabled`)
  2. 时间门:`hoursSince(lastConsolidatedAt) >= minHours`(默认 24,GB `tengu_onyx_plover.minHours`)(136-144)
  3. 扫描节流:`SESSION_SCAN_INTERVAL_MS=10min`(58,147-154)
  4. 会话门:`listSessionsTouchedSince(lastAt)` 中 mtime 更新的 transcript 数 ≥ `minSessions`(默认 5),排除当前 session(156-174;consolidationLock.ts:118-124 扫 `getProjectDir(getOriginalCwd())`)
  5. 锁:`tryAcquireConsolidationLock()`(176-193)
- **锁机制(`consolidationLock.ts`)**:记忆目录内 `.consolidate-lock` 文件,**mtime 即 lastConsolidatedAt**,内容 = 持有者 PID(1-3,16)。acquire(46-84):mtime 在 `HOLDER_STALE_MS=1h` 内且 PID 存活 → 拒绝;死 PID →  reclaim(write + re-read 验证竞争);失败 → `rollbackConsolidationLock(priorMtime)` utimes 回卷(91-108);成功不释放(mtime=完成时刻)。手动 `/dream` 用 `recordConsolidation`(130-140)。
- 执行同 extract:`runForkedAgent` + `createAutoMemCanUseTool` + 只读 Bash 约束说明(216-224),并注册 DreamTask 供后台任务面板观察(203-211、tasks/DreamTask)。

### A7. `vendor/services/teamMemorySync/` —— 团队记忆同步:对 zai 不适用【读】

- `index.ts`(1354 行):与远端 server 的 pull/push 同步(etag、字节批量 delta `batchDeltaByBytes` 461、`SyncState` 135-167)。**可用判定 `isTeamMemorySyncAvailable() = isUsingOAuth()`(854-856)** —— 依赖 Anthropic 一方 OAuth 登录与服务端点。zai 走 API key / 自建 provider,没有该服务端 → 整条链路(含 `watcher.ts` 的 fs.watch + 2s debounce push、启动 pull(1-40),`secretScanner.ts` 的 push 前密钥扫描、`teamMemSecretGuard.ts` 写前守卫)都无落点。
- **评估结论:回补方案直接砍掉 teamMemorySync 与 team 相关 prompt/路径**(§C18),未来若要做"团队共享记忆"需另起 zai 版同步层。

### A8. memory prompt 的注入点与缓存语义【读】

- 注入点:`vendor/constants/prompts.ts:593` —— `systemPromptSection('memory', () => loadMemoryPrompt())`,位于 `getSystemPrompt()`(494)的 dynamicSections 数组中。SIMPLE 模式 early-return(500-504)不含 memory。
- 机制:`constants/systemPromptSections.ts` —— `systemPromptSection(name, compute)` = `{cacheBreak:false}`(20-25);`resolveSystemPromptSections`(43-57):`!cacheBreak && cache.has(name)` → 直接返回缓存值,**否则 compute 一次并写缓存**。缓存本体是 `STATE.systemPromptSectionCache`(state.ts:1753-1761)—— **进程级 Map,不是 per-session**。
- 失效:`clearSystemPromptSections`(systemPromptSections.ts:65-68)在 /clear、/compact 时调用。**没有基于内容的失效** —— 目录内容变了(新增记忆文件)也不会重算,memory section 本身是"行为指令+目录路径"(MEMORY.md 内容走 A9 的 user-context 通道,每 turn 重读),所以指令文本天然稳定;但**多会话共享一个缓存值**是 zai 回补的核心障碍(§B13)。
- 对照:`DANGEROUS_uncachedSystemPromptSection`(32-38)= 每 turn 重算、会破 prompt cache(如 mcp_instructions,611-618)。
- 先例:`vendor/QueryEngine.ts:371-378` —— 当 SDK 调用方给了 customSystemPrompt 且设置了 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`,**额外**把 `loadMemoryPrompt()` 作为独立块追加(`memoryMechanicsPrompt`)。这是"自定义 prompt 下仍注入 memory 机制说明"的官方模式,与 zai 的 slot 场景同构。

### A9. `vendor/utils/claudemd.ts` 与 auto-memory 的关系【读】

- claudemd **没有被 strip**(utils 不在 STRIP_DIRS 目录粒度内),但它 import `../memdir/paths.js`(claudemd.ts:48)→ bundle 时被别名到 stub。
- 关系:`getMemoryFiles()` 在装载 AGENTS.md/rules 之后,追加 **AutoMem 入口**:`isAutoMemoryEnabled()` 为 true 时读 `getAutoMemEntrypoint()`(即 `MEMORY.md`)作为 type `'AutoMem'` 的 memory file(988-1006);team enabled 时同样追加 `'TeamMem'`(1003-1010)。`AutoMem/TeamMem` 类型不参与外部路径排除过滤(393、551)。
- 即分工:**行为指令在 system prompt(memory section),MEMORY.md 索引内容走 claudemd → user context**(loadMemoryPrompt 不内嵌内容,A2)。截断共享 `truncateEntrypointContent`。`tengu_moth_copse`(skipIndex)开启时改由 attachments 召回注入,`filterInjectedMemoryFiles`(1141-1152)负责过滤。
- runtime 现状:`isAutoMemoryEnabled` stub=false → AutoMem 分支不进入 —— 这正是 spec《2026-07-19-zai-align-opencc-memory》§风险表说的"自然降级"(spec:358)。

### A10. `vendor/tools/AgentTool/agentMemory.ts` —— subagent 记忆【读】

- 与主 agent 的三点区别:
  1. **目录不同**:scope `'user'|'project'|'local'`(13)→ `<memoryBase>/agent-memory/<agentType>/`、`<cwd>/.zai/agent-memory/<agentType>/`、`<cwd>/.zai/agent-memory-local/...`(52-65),与 auto-mem 的 projects/<slug>/memory 完全分离。
  2. **prompt 不同**:spawn 时 `loadAgentMemoryPrompt(agentType, scope)`(138-177)用 `buildMemoryPrompt`(**内嵌 MEMORY.md 内容**,因为没有 claudemd 通道),按 agent 定义合并进其 system prompt;调用方是 `loadAgentsDir.ts`(codegraph:7 callers,含 UI 向导 MemoryStep)。
  3. **无自动后台**:extractMemories/autoDream 门禁 `!toolUseContext.agentId`(stopHooks.ts:164,175)—— subagent turn 结束不触发抽取;也无需 memoize 冲突处理(agentMemory 直接用 `getCwd()`,A10 文件内 52-64 行,getCwd 是 ALS-aware 的 utils/cwd.ts:26-32)。
- `isAgentMemoryPath`(68-104)供权限层识别。`utils/cwd.ts` 的 `runWithCwdOverride`(12-14)+ `pwd()`(19-21)已有 ALS 覆盖 —— vendor 内部本来就承认"并发 agent 各见其 cwd"的模型,但 auto-mem 的 `getProjectRoot` 没走这套。

---

## B. 回补到 zai 的落点

### B11. zai system prompt 组装与最自然插入点【读】

- zai 不直接传 system prompt:`zai/server/services/agentRuntime.ts` 全文没有 `getSystemPrompt/loadMemoryForPrompt` 调用(grep 命中为空);prompt 完全由 vendor 内部组装:`zai/server/routes/agent.ts` → `runtime.query()` → `engine.submitMessage()`(`createOpenccRuntime-impl.ts:939`)→ `QueryEngine`(opencc-src/QueryEngine.ts:351 `fetchSystemPromptParts` → 内部调 `getSystemPrompt`)。
- **zai 已有的 per-session 干预机制 = `systemPromptSlot`**:`QueryEngine.ts:137` 定义、`:385-392` 应用(`slottedPrompt = config.systemPromptSlot(basePrompt)`);zai 在 `createOpenccRuntime-impl.ts:385-474` 的 `createEngine` 里按 sessionId 从 `AgentRegistry` 解析绑定 agent 并派发 slot(432-436、474-475)。内置非编码 agent 用 `server/mainAgents-promptSections.ts` 过滤段落 —— 其文件头注释明确"保留通用段(...memory / MCP 等)",说明**现有 slot 过滤对 memory section 是天然放行的**。
- 结论插入点(二选一,推荐 ②):
  1. 解除 strip 后 `prompts.ts:593` 的 memory section 自动生效 —— 但受进程级缓存与 GB 旗标拖累(§A8/B13)。
  2. **在 zai 的 `systemPromptSlot`(default agent 槽)里把 memory prompt 作为 origin 数组的附加块注入**,每会话重算、绕开进程级 section 缓存 —— 与 QueryEngine.ts:371-378 的 Cowork 先例同构,改动全部落在 zai patch 层。
- 索引内容(MEMORY.md)注入:zai 的 `compat/memory/loader.ts` 只产 `MemoryFile[]`(AGENTS.md/local + @include,cache key=cwd,loader.ts:40-49),其消费在 zai 服务端只有 `startMemoryWatcher`(agentRuntime.ts:57,787)与 `hasExternalIncludes`(792);loader 结果本身如何进 prompt 链路本次未逐行确认【推断:由 `agents/memoryLoader.ts` re-export 给运行时装配层】。回补时把 `MEMORY.md`(AutoMem 型)加进 loader 的 walk 结果即可复用现有 watcher/clearMemoryCache 失效机制。

### B12. zai 会话生命周期 —— turn 结束可挂点【读+agent】

- **vendor 原生点(最优)**:`query.ts:2171 handleStopHooks` 在 zai 的每次 turn 结束**已经执行**(zai 走完整 defaultQuery 循环);stopHooks 里的 `executeExtractMemories/executeAutoDream` 调用位置就在(170/176),今天被 stub 短路。回补只需:解除/替代 stub + 启动时调 `initExtractMemories` 等价物。【读】
- **zai 服务层点**:zai 没有 turn_end 事件 —— `zai/server/services/eventBus.ts` 事件枚举(35-70)只有 `runtime.*`/`cwd.changed`/`session.*`/`job.*`/`prompt.ask` 等(无 turn_end/done/idle);turn 完成在 `routes/agent.ts` 的 query generator 消费循环处可见(yield `runtime.done`/result 后)(【agent】,eventBus 枚举本次亲验)。
- `sessionInbox`(followup/steer,agentRuntime.ts:195-209)可复用作"turn 结束后注入系统消息"的通道;`historyArchive` 与 per-turn 无关(只在 `/api/super-tasks` 里归档 48h 前的完成任务)【agent】。
- 需要注意:zai 是常驻服务,`drainPendingExtraction` 的 CLI 退出语义不需要,但 session 删除/abort(`disposeSession`)时需要对应的 cancel+drain。

### B13. 多会话适配 —— 具体冲突清单(最重要)【读】

前提事实:zai 单进程 N 会话并发(每会话独立 cwd:`routes/agent.ts:1093-1101 resolveInboxCwd/CwdStore`;每 query 用 `runWithSdkContext({sessionId, cwd, originalCwd})` 包住 ALS:`agent.ts:1394,1485`、`createOpenccRuntime-impl.ts:981-1005`)。vendor 的 STATE 中 `sessionId/cwd/originalCwd` 均 ALS-aware(state.ts:483-486,603-611,622-624),**唯独 `projectRoot` 与 `systemPromptSectionCache` 是进程级**。

| # | 冲突点 | 证据 | 需要的改动 |
|---|---|---|---|
| 1 | `getAutoMemPath` memoize key=`getProjectRoot()` 且 projectRoot 启动一次性 | paths.ts:240-252;state.ts:596-598,613-615;createHeadlessContext-impl.ts:286 | 目录解析改读 ALS 感知源(`getCwd()`/`getOriginalCwd()`,均 utils/cwd.ts:26-32 / state.ts ALS);**去掉 memoize 或按 cwd/gitRoot 分 key**(Map<key,dir>),否则第 2 个不同 repo 的会话拿第 1 个会话的记忆目录 |
| 2 | memory section 值进程级缓存 → 会话 A 的目录/prompt 串到会话 B | systemPromptSections.ts:43-57;state.ts:1753-1761 | 不走默认 section 缓存:用 `systemPromptSlot` per-session 注入(B11),或 memory 段改 `DANGEROUS_uncached`(代价:每 turn 重算+破缓存,不推荐) |
| 3 | prompt 组装发生在 `submitMessage` 首轮 —— 必须在会话 ALS 内求值路径 | QueryEngine.ts:343-360;createOpenccRuntime-impl.ts:1002-1005(`stream.next()` 逐次包进 `runWithSdkContext`) | 只要 #1 改为读 ALS,装配点天然正确【推断:需实测首包时序】;否则显式把 sessionId→cwd 传进 builder |
| 4 | `initExtractMemories()` 闭包状态单例:游标 `lastMemoryMessageUuid`、`inProgress`、`pendingContext` 全局一份 | extractMemories.ts:296-328;CLI 假设单主对话 | 改为**按 sessionId 实例化工厂**:`Map<sessionId, ExtractorInstance>`;stopHooks 触发时按当前会话取实例。若沿用全局单例,两个会话的 turn 会互相推进/覆盖游标 |
| 5 | `inProgress` stash/abort 语义只防"同会话重入",不防跨会话并发 | extractMemories.ts:603-613 | 跨会话并发要按**记忆目录粒度加互斥**(见 B14) |
| 6 | GB 云旗标在 zai 环境不可用 | paths.ts:87-93;autoDream.ts:77;memdir.ts:444;getFeatureValue 真实实现在 services/analytics(kept)但无 ant 网络环境默认 false | 所有 feature gate(`tengu_passport_quail/slate_thimble/bramble_lintel/moth_copse/coral_fern/onyx_plover`)换成 zai settings;MVP 直接删 skipIndex/搜索段分支 |
| 7 | init 调用链缺失(headless 不调 startBackgroundHousekeeping) | backgroundHousekeeping.ts:31-32;main.tsx:2906;REPL.tsx:4258;headless 侧 grep 无命中 | 在 `zai/server/index.ts` 启动或 `enableOpenccConfigs` 后显式 init(或在 compat 层自管) |
| 8 | 会话 cwd 中途可变(bash `cd` 会发 `cwd.changed`,stateBridge.ts:31;Web 端 SessionInfo.cwd 随 SSE 更新,useSessionCwd.ts) | —— | 决定语义:记忆目录"随会话当前 cwd"(跟 ALS)还是"会话创建时冻结"。建议跟当前 cwd,与 transcript 存储(agent.ts:1273/1501 用 resolveInboxCwd)一致 |
| 9 | 多实例(多进程)同仓不同进程:`~/.zai/projects/<gitRoot>/memory/` 完全共享,STATE 独立无缓存串扰但写并发存在(B14);weixin 实例默认 cwd=用户主目录,会得到 home 目录的独立记忆 | zai/server/services/paths.ts:23(ZAI_DIR 共享);instanceSupervisor spawn | 可接受(记忆按 git root 共享正是设计意图),但要处理 #B14 的写互斥 |

### B14. 并发写风险与处置【读+推断】

- 场景:N 个会话同 turn 结束 → N 个 extract fork 同时写 `MEMORY.md`/topic 文件。vendor 只防了**单会话内重入**(inProgress+stash,extractMemories.ts:603-613);跨会话/跨进程无任何防护。`MEMORY.md` 是整文件 Write(prompts 指示 Step2 追加索引行,memdir.ts:243)→ last-write-wins,**互相覆盖丢索引**是必然结果。topic 文件按文件名隔离,冲突概率低但同名 frontmatter 更新仍会覆盖。
- 现成可借鉴的机制:autoDream 的 `.consolidate-lock`(mtime+PID,consolidationLock.ts:1-23)解决了跨进程 dream 互斥;extract 侧无对应物。
- 建议处置(按强度递增):
  1. **目录级内存互斥**(zai 进程内 `Map<memDir, Promise链>` 串行化 extraction)—— 覆盖单机多会话,成本低;
  2. 复用 consolidationLock 模式做 `.extract-lock`(跨实例);
  3. 索引写改"每会话 fragment + 聚合"或 read-modify-write + 冲突重试 —— 改动 prompt 语义,最后考虑;
  4. MVP 折中:同时只允许一个进程内 active extraction 队列(全局串行),N 会话排队 —— 简单可靠,吞吐损失可接受(抽取本身是后台任务)。
- 另注意 fork 依赖 `saveCacheSafeParams(stopHookContext)`(stopHooks.ts:116-118):该函数是模块级存储,多会话并发 query 下 A 会话的 fork 可能拿到 B 会话刚存的 cache params【推断,未读 saveCacheSafeParams 实现确认】→ compat 版应改为按会话持有 snapshot。

### B15. 权限对齐【读】

- vendor 写路径白名单(`vendor/utils/permissions/filesystem.ts`,未被 strip,但 import 的 memdir stub 短路):
  - `checkEditableInternalPath`(filesystem.ts:1603【agent】)内 auto-mem 两段:① `isAutoMemPath(p) && isMemoryWriteApprovalRequired() && !isUnderGlobalClaudeProjects(p)` → `ask`("wants to save persistent memory",1700-1715);② `!hasAutoMemPathOverride() && isAutoMemPath(p)` → `allow`(bypass DANGEROUS_DIRECTORIES,1717-1725)。今天 stub `isAutoMemPath→false`(opencc-stripped.ts:37),两段都不触发。
  - **`isMemoryWriteApprovalRequired()` 默认 true**(governancePolicy.ts:25-38:`return !explicitlyDisabled`,fail-safe):任何 source 显式 `false` 才免审批。含义:**保持 vendor 默认 → 主 agent 每次写记忆都弹 ask、且 extract fork 直接不跑**(extractMemories.ts:591-593)。zai 想要"自动记忆",settings 必须落 `memory.requireApprovalBeforeWrite:false`(用户/实例级)。
- zai 侧:`permissionRegistry.ts`(register 34 / answer 75【agent】)把 vendor 的 `behavior:'ask'` 桥成 SSE `prompt.ask` → Web 卡片审批 → permission-response 回填;modes 见 `compat/permissions.ts:28-44`(acceptEdits/bypassPermissions/default/dontAsk/plan/auto),default mode 由 `~/.zai/settings.json` 解析(compat/permissions.ts:81-100【agent】)。engine 的 `canUseTool: ctx.permission`(createOpenccRuntime-impl.ts:484)。
- 对齐结论:
  1. 解除 stub 后,`filesystem.ts` 两段 carve-out 自动生效 —— zai 不需要新代码,但**需要兼容一个现实**:zai 的 cwd 可指向任意用户目录,而 vendor 白名单以 `getAutoMemPath()`(进程级!)为准 → 若不做 B13#1 的 per-session 目录解析,白名单与真实目录会错位(权限按 A 目录放行、agent 写 B 目录,或反之)。compat 方案中要把这个判定改为按 ALS cwd 解析。
  2. extract fork 的权限不走 zai UI:vendor 设计是 `createAutoMemCanUseTool` 自带 canUseTool(硬 allow/deny,不 ask)(extractMemories.ts:171-222),`runForkedAgent` 用它替代 engine 的 `ctx.permission`【推断:未读 forkedAgent.ts 内 canUseTool 优先级,文件存在且未被 strip,utils/forkedAgent.ts】。zai 回补必须保留这一"沙箱而非弹窗"模式,否则每次后台抽取会卡审批。
  3. `bypassPermissions/dontAsk` 模式下 vendor ask 自动放行 —— zai 现有模式语义即对齐,无需额外工作。

### B16. 已有 spec/plan【agent + 抽查】

- `docs/superpowers/specs/2026-07-19-zai-align-opencc-memory-design.md`:行 39-45 把 "auto-memory 集成" 列为 **Plan B 暂不实现**(opencc 有但 zai 当前场景不强需要);行 105-109 预留 `options?: { includeAutoMemory?: boolean }` 接口位;行 355-361 风险表写明"通过 `isAutoMemoryEnabled()=false` 自然降级,不引入新依赖"。
- `docs/superpowers/plans/2026-07-19-zai-align-opencc-memory.md`:行 27 "❌ auto-memory integration" 明确出 scope;行 204 列为后续 PR。
- `docs/superpowers/plans/2026-07-28-zn-agent-core-from-opencc.md`:行 103-118 把 memdir/extractMemories/autoDream/teamMemorySync 列入 strip 清单。
- 决策依据原文:`scripts/strip-list.ts` 顶部"Anything not matching is copied verbatim"(1-6);`compat/dangling-shims/opencc-stripped.ts:8` "memdir: opencc's memory directory system (**zai has its own**)"。
- 结论:**没有已批准的 auto-memory 回补 spec**,只有"暂不做"的历史决策 + 接口预留。本报告即该决策的重开输入。

---

## C. 结论

### C17. 回补策略对比与推荐

**(a) 解除 strip、直连 vendor memdir + extractMemories(+autoDream)**
- 做法:STRIP_DIRS 删 4 条 + 补 opencc-stripped 里被删的 stub 导出 + init 链补进 zai boot + GB gate 改 settings + 修 §B13#1/#2/#4。
- 优点:eval 验证过的 prompt/截断/扫描/抽取逻辑原样继承,上游 sync 零成本;stopHooks 触发链天然复用。
- 致命缺点:改动面并不小 —— paths 的 memoize/STATE 语义、extractor 单例改 per-session、`filesystem.ts` 与 stub 的三处联动、bundle 别名粒度(esbuild 整目录替换,部分解除需改成文件粒度 alias)全部要动;还继承 team memory(GB `tengu_herring_clock` 默认 true!teamMemPaths.ts:77 会拉进 team dir 和 combined prompt)、KAIROS 死代码等无关复杂度。**省不了 compat 层要写的代码,反而把 vendor 的耦合带进来。**
- 风险:上游每次同步都可能重排 memdir 内部结构,补丁漂移。

**(b) compat/ 写 zai-native 精简版(仿 loader.ts)**
- 做法:新增 `compat/memory/auto/*.ts`:目录解析(ALS cwd → `ZAI_DIR/projects/<slug>/memory/`)、prompt builder(文本从 memoryTypes.ts / buildMemoryLines **原样复制**,注明来源行号)、scan/truncate(复制 memoryScan.ts 255 行与 truncateEntrypointContent)、turn-end 抽取调度(zai 自管 Map<sessionId, cursor> + 目录级串行队列)。注入走 systemPromptSlot;fork 执行复用未被 strip 的 `utils/forkedAgent.ts`(runForkedAgent/createCacheSafeParams)+ `createAutoMemCanUseTool` 逻辑复制。
- 优点:多会话语义从第一天就正确;无 GB/无 team/无 KAIROS 包袱;权限判定与目录解析在同一个 zai-native 模块里闭环;符合仓库"compat 承载 zai 专属实现"的既有分工(AGENTS.md「opencc-src vs compat」)。
- 缺点:prompt 文本与 vendor 复制分叉 —— 缓解:文本类常量集中一个文件 + 头部注释记 `copied from memdir/memoryTypes.ts@<git-sha>`;zai 需要自己维护 fork 调用的 cacheSafeParams(但 forkedAgent 工具本体在 bundle 里可 import)。

**(c) 混合 —— 推荐**:逻辑层(扫描/截断/fork 执行/沙箱 canUseTool)**复制**进 compat(代码稳定、无 STATE 依赖的部分直接搬),机制层(目录解析、注入点、调度、并发控制、权限)zai-native 重写。即 (b) 的精确化:不是全部手写,而是"vendor 纯函数抄、有状态部分 zai 化"。
- 理由:(1) vendor 唯一不可替代的是 **eval 验证过的 prompt 文本**,它恰好是纯数据;(2) 所有有状态部分(memoize/closure/STATE/ALS)正是与 zai 多会话模型冲突的部分,照搬必改;(3) 解除 strip 需要动 bundle alias 基础设施,收益不成比例。
- 风险:(i) prompt 漂移(缓解见上);(ii) 复制的 scan/truncate 上游 bugfix 不回传(接受,体量小);(iii) forkedAgent 内部若依赖 growthbook 旗标需逐一确认(实施步骤 4 里带验证)。

**不选 (a) 的决定性证据**:§B13 表格中 #1/#2/#4/#6/#7 五项在方案 (a) 下同样要改 vendor 源文件 —— "解除 strip" 实际是"解除 strip + 改 vendor 五个模块",而改了这五个模块后,vendor 版与 compat 版功能等价,compat 版反而不需要处理 bundle alias 和团队记忆残留。

### C18. 最小可行回补(MVP)实施步骤草案

MVP 范围 = A1-A4 + B11-B13 的"读 + 主动保存"闭环(system prompt 指令、MEMORY.md 注入、写目录识别/权限、用户说"记住"→ 落盘);自动抽取(extract fork)为 Phase 2,dream/team 永久砍掉。

**新增文件(均在 `compat/memory/`)**
1. `autoTypes.ts` —— 从 `memdir/memoryTypes.ts` 原样复制 INDI-VIDUAL 版 section 文本 + frontmatter 示例(源注释标行号)。⊕ 砍 COMBINED/team。
2. `autoPaths.ts` —— `resolveAutoMemDir(cwd)`:git root 探测 + `join(ZAI_DIR, 'projects', sanitize(path), 'memory')` + `MEMORY.md` 入口;无 memoize(或 Map<dir-key>);安全校验复制 `validateMemoryPath`(paths.ts:126-167)。override 只保留 zai settings(`~/.zai/settings.json` + `<cwd>/.zai/settings.json` 的 `memory.directory`)。
3. `autoPrompt.ts` —— `buildAutoMemoryPrompt(dir, approval)`:移植 `buildMemoryLines`(memdir.ts:211-288)与 `truncateEntrypointContent`(54-115)。
4. `autoScan.ts` —— 复制 `scanMemoryFiles`+`formatMemoryManifest`(memoryScan.ts 全文件,只留 fs/promises 依赖),供 Phase 2 与 UI 用。
5. `autoMemStore.ts` —— 会话→抽取状态 + 目录级串行队列(Phase 2);MVP 只存 approval 模式读缓存。

**修改文件**
6. `compat/memory/loader.ts` —— walk 结果追加 AutoMem 入口:`loadMemoryForPrompt(cwd)` 末尾读 `autoPaths.resolveAutoMemEntrypoint(cwd)`(仿 claudemd.ts:988-1006 语义),沿用 per-cwd cache 与 `clearMemoryCache`(watcher 已覆盖失效)。
7. `packages/zn-agent-core/src/compat/dangling-shims/opencc-stripped.ts` —— `isAutoMemPath` 改委托 `autoMemStore` 的注册表(MVP 可先返回 false,Phase 2 前必须真实);若权限走 vendor filesystem 白名单则此处必须联动(见 8)。
8. 权限:走 **approval-first** 策略 —— MVP 设 `isMemoryWriteApprovalRequired` 语义为 true(默认要求用户明确同意),主 agent 写记忆走 zai 现有 ask→prompt.ask→permissionRegistry 流程,不需要 filesystem.ts 白名单改动;Phase 2 若开自动写,再把 `isAutoMemPath` 白名单接进 `autoPaths`(zai-native 检查,不依赖 stub)。
9. 注入:`opencc-src/server/createOpenccRuntime-impl.ts` 的 `createEngine` 回退链中,给 `default` agent 的 `systemPromptSlot` 包一层(或 `server/mainAgents.ts` default 定义):`origin + [await buildAutoMemoryPrompt(resolveAutoMemDir(cwdOf(sid)))]` —— 每会话首 query 组装,天然 per-session。开关:zai settings `memory.autoWrite`(沿用 vendor 键名,`~/.zai/settings.json`)。
10. Phase 2(抽取):`zai/server/routes/agent.ts` generator 完成处(或 compat 层订阅 stopHook)触发 → `runForkedAgent`(import 自 `@zn-ai/zn-agent-core` bundle 内 utils/forkedAgent)+ `services/extractMemories/prompts.ts` 文本移植版 + `createAutoMemCanUseTool` 移植版(改 isAutoMemPath 为 8 的注册表)+ per-session 游标 Map + 目录互斥队列;`turnN 节流`固定 1。

**验证**
- 单测:`autoPaths`(slug/override/安全校验用例移植 vendor 测试语义)、`loader`+AutoMem、slot 注入产物断言(含 approval 文案分支)。
- 手工:dev 实例新会话输入"请记住 X" → 出现 memory ask 审批 → `~/.zai/projects/<slug>/memory/{MEMORY.md,X*.md}` 生成;开第二个会话(同仓不同目录 + 不同 git 仓库各一)确认索引注入、无目录串扰;`pnpm run build:core` 后起服务,按 AGENTS.md 规则用 ego-browser 走 UI 验收(询问用户后执行)。
- 回归:关闭 `memory.autoWrite` 时 prompt 无 memory 段、写记忆回普通文件权限流。

---

## 附:本次未读但被引用的文件(标注)
- `compat/repl/stateMachines.ts:98/288`、`zai/server/services/historyArchive.ts:33`、`sessionAgentRegistry.ts:25/68`、`permissionRegistry.ts:34/75`、`compat/permissions.ts:28-44/81-100`:来自 tui/Explore agent 报告【agent】,与本次亲读证据交叉一致处已并入。
- `utils/forkedAgent.ts` 的 `runForkedAgent/createCacheSafeParams` 内部实现细节(仅确认存在、未被 strip、签名可从 extractMemories 调用点反推)。
- docs spec/plan 的行号来自 agent 2,已抽查 spec:39-45/105-109/355-361 一致。
