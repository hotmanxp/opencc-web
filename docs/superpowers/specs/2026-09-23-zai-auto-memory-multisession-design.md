# auto-memory 多会话回补设计

- 日期：2026-09-23
- 状态：已确认范围，待实施
- 前置调研：`.research/auto-memory-{opencc,opencode}.md`（三引擎并行调研，含冲突裁定）

## 1. 背景与动机

vendor（`packages/zn-agent-core/src/opencc-src/`）自带一套文件制 auto-memory：把记忆写在
`<configHome>/projects/<sanitized-git-root>/memory/`，以 `MEMORY.md` 为索引、topic 文件为正文，
分 user / feedback / project / reference 四类，并在 turn 结束时由后台 fork 自动抽取。

zai 现状（**实测**，与历史文档不一致）：

| 项 | 实测结论 | 证据 |
|---|---|---|
| 提示词是否注入 | **是**，且是 combined(auto+team) | `dist/opencc-core.mjs` 含真实提示词 2 处、`shared team directory` 1 处；空壳串 `/tmp/zai-memdir` 0 处 |
| STRIPPED_DIRS 作用域 | 仅 vitest alias + legacy tsx loader，**不作用于 esbuild bundle** | `src/compat/runtime/stripped-dirs.mjs:1-4` 自述；仅被 `vitest.config.ts` import；`scripts/bundle-opencc.ts` 无 strip alias plugin |
| 记忆目录 | 已存在真实内容 | `~/.zai/projects/-Users-liangxuechao572-code-zn-ai-zbuddy/memory/{MEMORY.md,agent-prompt-codegraph-default.md}` |
| 自动抽取 | **从不运行** | `initExtractMemories()` 仅 `utils/backgroundHousekeeping.ts:31` 调用，而后者仅 `main.tsx:2906` / `REPL.tsx` 触发（CLI 链路）；且 `isExtractModeActive()` 的 GB 旗标在 zai 恒 false |
| 固化 autoDream | **从不运行** | `initAutoDream()` 同上；且门禁 `!isMemoryWriteApprovalRequired()` 被默认 true 挡住（尽管 `~/.zai/settings.json` 已设 `autoDreamEnabled: true`） |

即：**写入半边是死的，而读取半边是多会话错误的。**

### 1.1 多会话缺陷（本设计的核心）

zai 单进程服务 N 个会话（`engines: Map<sessionId, QueryEngine>`），但：

1. `getAutoMemPath()` 用 `memoize(fn, () => getProjectRoot())`（`memdir/paths.ts:240-252`）。`getProjectRoot()` 返回 `STATE.projectRoot`，其值是模块初始化时的 `realpathSync(process.cwd())`（`bootstrap/state.ts:275-286`），而 zai **全仓从不调用 `setProjectRoot`**。
   → 一个 zai 进程内**所有会话共用一份记忆目录**；cwd 属于别的仓库的会话会读写到**错误项目**的记忆。
2. `resolveSystemPromptSections` 的缓存在进程级单例 `STATE.systemPromptSectionCache`（`bootstrap/state.ts:210,407,1753-1765`）。
   → **首个会话**算出的记忆路径文本被后续所有会话复用。
3. `initExtractMemories()` 的 `lastMemoryMessageUuid` / `inProgress` / `pendingContext` 是模块级闭包单例（`services/extractMemories/extractMemories.ts:279-328`）。
   → 若直接初始化，N 个会话会互相推进/覆盖游标，并互相 abort。
4. `MEMORY.md` 由模型整文件 Write 维护，无任何文件锁（跨会话/跨进程）；`last-write-wins` 必丢索引。
5. `isTeamMemoryEnabled()` 默认 true（GB 默认值 `tengu_herring_clock`，`memdir/teamMemPaths.ts:73-78`）→ 注入 combined 提示词，指示模型维护一个 zai 里不存在、也无同步后端的 team 目录。

### 1.2 会话 cwd 的真相

`createOpenccRuntimeImpl` 全实例只有一个 cwd（`agentRuntime.ts:230,739 defaultCwd: cwd`）。会话级 cwd 仅存在于 `compat/cwdStore.ts` 的 per-session Map，被 `routes/agent.ts` 用于 inbox/transcript 路由（`:1040,1094-1101,2079,2093,2128`）与 Bash `cd` 追踪（`compat/tools/opencc/bashCwdWrap.ts:93,113`），**未喂进 runtime / ALS**。

`SdkContext` 字段为 `{sessionId, sessionProjectDir, cwd, originalCwd, parentSessionId}`（`bootstrap/state.ts:454-460`），**无 projectRoot**。

## 2. 已确认的范围（用户决策 2026-09-23）

| 决策点 | 选择 |
|---|---|
| 记忆目录键控 | **项目共享（git root）** —— 所有会话共享一份记忆，按各会话 cwd 解析 git root 归一 |
| 回补范围 | **正确性 + turn 末自动抽取 + autoDream 固化**（最大范围） |
| team 记忆 | **显式关闭** |
| 写记忆审批 | **`memory.requireApprovalBeforeWrite: false`**（沿用 vendor 键名，写记忆无感） |

## 3. 设计

### 3.1 策略：就地修 vendor + zai 窄通道，而非另写 compat 版

因为真实 memdir 已在 bundle 里运行，"解除 strip"是 no-op。回补 = 把已上线的半成品**改对** + **点活**写入半边。
不采用"compat 重写"，理由：vendor 的纯函数（prompt 文本、`memoryScan`、`truncateEntrypointContent`、`createAutoMemCanUseTool`、`runForkedAgent`）无可替代且已在 bundle；重写会分叉。

### 3.2 会话 cwd → 记忆路径：新增窄 ALS 字段

不修改 `sdkCtx.cwd`（会连带改变 Bash/文件操作语义，blast radius 过大）。新增**专用字段**：

```
SdkContext += { memoryCwd?: string }
```

- `createOpenccRuntime-impl.ts` 构造 `sdkCtx` 时填入 `CwdStore.get(sessionId) ?? cwd`。
- `memdir/paths.ts` 的目录解析改读 `getSdkContext()?.memoryCwd ?? getCwdState()`，并用该值做 git root 归一。
- `memoize` 的 key 从 `getProjectRoot()` 改为该 cwd（或去掉 memoize 改 `Map<cwd, dir>`），消除跨会话串扰。

### 3.3 team 关闭

`isTeamMemoryEnabled()` 直接返回 `false`（zai patch 注释），单点切断：prompt 分支、`getTeamMemPath` 消费者、`claudemd` 的 TeamMem 注入、team watcher 一并失效。保留函数签名以免上游 sync 大面积冲突。

### 3.4 GB 旗标 → zai settings

| vendor 门 | 现值 | 改为 |
|---|---|---|
| `isExtractModeActive()`（`paths.ts:86-94`） | GB `tengu_passport_quail` + `tengu_slate_thimble` | zai settings（`memory.autoWrite`，默认由用户显式开启） |
| `isAutoDreamEnabled()`（`autoDream/config.ts:13-21`） | settings `autoDreamEnabled` ?? GB `tengu_onyx_plover.enabled` | 保留 settings 分支（用户已设 true），去掉 GB 兜底为 false |
| `skipIndex`（`tengu_moth_copse`）、`buildSearchingPastContextSection`（`tengu_coral_fern`） | GB 默认 false | 保持 false（不实现，删分支） |

### 3.5 per-session 抽取状态 + 目录级写互斥

- `extractMemories.ts` 的闭包单例改为 `Map<sessionId, {cursor, inProgress, pendingContext}>`；`executeExtractMemories` 从 `getSessionId()`（ALS）取 key。
- 新增按记忆目录的**进程内串行队列**（`Map<memDir, Promise>`），确保同一项目的 N 个会话的抽取不并发写同一 `MEMORY.md`。
- `autoDream` 已有跨进程锁（`.consolidate-lock`），保留。

### 3.6 启动接线

`initAgentRuntime()`（`agentRuntime.ts:568+`）在 `enableOpenccConfigs` 之后调用 `initExtractMemories()` / `initAutoDream()`；两者经 `bundle-entry.ts` 导出。

## 4. 影响面

| 文件 | 改动 |
|---|---|
| `opencc-src/bootstrap/state.ts` | `SdkContext` 加 `memoryCwd?` |
| `opencc-src/memdir/paths.ts` | 目录解析读 ALS `memoryCwd`；memoize key 换 cwd |
| `opencc-src/memdir/teamMemPaths.ts` | `isTeamMemoryEnabled()` → false |
| `opencc-src/memdir/memdir.ts` | 去 GB 分支（skipIndex / searching-past-context） |
| `opencc-src/services/extractMemories/extractMemories.ts` | per-session 状态 Map + 目录级互斥 + 门禁换 zai settings |
| `opencc-src/services/autoDream/config.ts` | 门禁去 GB 兜底 |
| `opencc-src/server/createOpenccRuntime-impl.ts` | `sdkCtx.memoryCwd` 来自 `CwdStore` |
| `compat/memory/` | 新增目录级串行队列（或放 `opencc-src` 侧） |
| `bundle-entry.ts` | 导出 `initExtractMemories` / `initAutoDream` |
| `packages/zai/src/server/services/agentRuntime.ts` | boot 调两个 init |
| `~/.zai/settings.json` | `memory.requireApprovalBeforeWrite: false` |
| `scripts/strip-list.ts` + `stripped-dirs.mjs` | 移除 memdir / extractMemories / autoDream / teamMemorySync 条目（它们本就未生效，删掉以免误导） |

## 5. 验证

- 单测：路径解析（不同会话 cwd → 不同目录、同 git root → 同目录）、team 关闭、per-session 游标隔离、目录级互斥。
- `pnpm run build:core` 后 `pnpm -r exec tsc --noEmit`。
- 端到端：两个会话（同仓不同子目录 + 不同仓）验证目录归一与无串扰；turn 结束后 `MEMORY.md` 出现指针；`/clear` 后重算。
- 样式/UI 无改动，故不涉 Tailwind 规则。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 改 `paths.ts` memoize 影响所有 memdir 消费者（`claudemd`、`filesystem` 白名单、`agentMemory`） | 保持函数签名不变；`filesystem.ts` 的 `isAutoMemPath` 判定同步读 ALS |
| 自动写无审批 → 模型可静默写盘 | 用户显式选择；写入限于 `~/.zai/projects/**`；保留 zai 开关可关闭 |
| vendor 上游 sync 冲突 | 所有改动加 `zai patch (2026-09-23)` 注释块，集中、可 grep |
| per-session 改动遗漏某消费点 | 全仓 grep `getAutoMemPath|getAutoMemEntrypoint|isAutoMemPath` 逐一核对 |