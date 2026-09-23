# auto-memory 多会话回补 实施计划

- 日期：2026-09-23
- 对应 spec：`docs/superpowers/specs/2026-09-23-zai-auto-memory-multisession-design.md`
- 约定：所有 vendor 改动集中加 `zai patch (2026-09-23)` 注释；每步可独立验证、可回退。

## 步骤总览

| # | 步骤 | 产出 | 验证 |
|---|---|---|---|
| 1 | 关闭 team | `memdir/teamMemPaths.ts` `isTeamMemoryEnabled()` → false | 单测 + prompt 不含 `shared team directory` |
| 2 | 会话 cwd 窄通道 | `state.ts` `SdkContext.memoryCwd`；`createOpenccRuntime-impl.ts` 从 `CwdStore` 填 | 单测：两个 sessionId → 不同 memoryCwd |
| 3 | 记忆目录按会话解析 | `memdir/paths.ts` 读 `memoryCwd`，memoize key 换 cwd | 单测：同 git root 归一、跨仓不串 |
| 4 | 去 GB 门 | `memdir.ts` 删 skipIndex/搜索段分支；`paths.ts` `isExtractModeActive` 换 zai settings；`autoDream/config.ts` 去 GB 兜底 | 单测：settings 开 → true |
| 5 | per-session 抽取状态 + 写互斥 | `extractMemories.ts` 状态 Map + 目录级串行队列 | 单测：并发两会话无交叉游标 / 无丢更新 |
| 6 | 启动接线 + 导出 | `bundle-entry.ts` 导出 init；`agentRuntime.ts` boot 调用 | build:core + 启动日志 |
| 7 | strip 清单清账 | `scripts/strip-list.ts` / `stripped-dirs.mjs` 移除已失效条目 | vitest 全绿（alias 不再需要这些） |
| 8 | 设置落地 | `~/.zai/settings.json` 加 `memory.requireApprovalBeforeWrite:false` | `isMemoryWriteApprovalRequired()` → false |
| 9 | 端到端验收 | — | build:core + tsc + 定向测试 + ego-browser |

## 步骤详情

### 1. 关闭 team 记忆
`opencc-src/memdir/teamMemPaths.ts` `isTeamMemoryEnabled()` 直接 `return false`（保留签名，加 patch 注释说明 zai 无同步后端）。
注意：`memdir/memdir.ts:471` 的 combined 分支因此自然不进入；`claudemd.ts` 的 TeamMem 注入同时失效。

### 2. `SdkContext.memoryCwd`
- `opencc-src/bootstrap/state.ts`：`SdkContext` 加 `memoryCwd?: string`。
- `opencc-src/server/createOpenccRuntime-impl.ts:981` 构造 `sdkCtx` 处，填 `memoryCwd: CwdStore.get(input.sessionId) ?? cwd`。
- 不改 `cwd`/`originalCwd`（避免 Bash/文件操作语义漂移）。

### 3. 记忆目录按会话解析
`opencc-src/memdir/paths.ts`：
- 新增内部 `resolveMemCwd()` = `getSdkContext()?.memoryCwd ?? getCwdState()`。
- `getAutoMemBase()` 用 `resolveMemCwd()` 替换 `getProjectRoot()`。
- `getAutoMemPath`：memoize key 由 `() => getProjectRoot()` 改为 `() => resolveMemCwd()`（保持 lodash memoize，限制 cache 增长）。
- 保持 `validateMemoryPath` / settings / env override 语义不变。

### 4. 去 GB 云旗标
- `memdir/memdir.ts`：`loadMemoryPrompt` 里 `skipIndex` 固定 false（删 `tengu_moth_copse` 分支）；`buildSearchingPastContextSection` 直接返回 `[]`（删 `tengu_coral_fern` 分支）。KAIROS 死分支（`if (false && ...)`）一并删除。
- `memdir/paths.ts` `isExtractModeActive()`：改读 zai settings（`memory.autoWrite`，默认 false）——与 `isAutoMemoryEnabled()` 语义区分开：前者管"自动抽取是否跑"，后者管"记忆系统是否存在"。
- `services/autoDream/config.ts`：`settings.autoDreamEnabled ?? false`（去掉 GB 默认 false 兜底）。

### 5. per-session 抽取状态 + 目录级写互斥
- `services/extractMemories/extractMemories.ts`：把闭包单例状态改为 `Map<key, ExtractState>`，`key = getSessionId() ?? '__global__'`；`initExtractMemories()` 改为初始化这个 Map（保持导出名不变）。
- 目录级互斥：新增按 `memoryDir` 的进程内串行队列，包住 `runForkedAgent` 调用段，保证同项目 N 会话不并发写同一 `MEMORY.md`。
- `drainPendingExtraction` 语义调整为"排空全部会话"。

### 6. 启动接线 + 导出
- `bundle-entry.ts`：`export { initExtractMemories } from './opencc-src/services/extractMemories/extractMemories.js'`、`export { initAutoDream } from './opencc-src/services/autoDream/autoDream.js'`。
- `packages/zai/src/server/services/agentRuntime.ts`：`initAgentRuntime` 中 `enableOpenccConfigs` 之后调用两者（try/catch 包裹，失败不阻塞启动）。

### 7. strip 清单清账
`scripts/strip-list.ts` 的 `STRIP_DIRS` 与 `src/compat/runtime/stripped-dirs.mjs` 的 `STRIPPED_DIRS` 移除 `memdir`、`services/extractMemories`、`services/autoDream`、`services/teamMemorySync`。
`compat/dangling-shims/opencc-stripped.ts` 里对应的 memdir 空壳 export 保留（其他 stripped 路径仍可能需要），但更新头注释说明它们对 memdir 已失效。

### 8. 设置落地
`~/.zai/settings.json` 增加 `memory: { requireApprovalBeforeWrite: false }`。
注意这是**用户全局配置**改动，需在报告中显式说明，并告知如何回退。

### 9. 端到端验收
```bash
pnpm run build:core
pnpm -r exec tsc --noEmit
pnpm --filter @zn-ai/zai test <受影响测试文件>
```
功能验收（询问用户后执行）：起 dev 实例 → 新会话"请记住 X" → 检查 `~/.zai/projects/<slug>/memory/`；
第二个会话（不同子目录）确认共享同一目录；第三个会话（不同仓库）确认不串扰。

---

## 实施结果（2026-09-23 回填）

改动面：**12 个文件，+291/−98，全部在 `packages/zn-agent-core/`**；`packages/zai` **零改动**。
另有新增测试 `packages/zn-agent-core/test/unit/memory/autoMemoryMultisession.test.ts`（9 项）。

### 与计划的偏差（均为实施中的更优解）

| 计划 | 实际 | 原因 |
|---|---|---|
| 步骤 6：`bundle-entry.ts` 导出 init + zai boot 调用 | 改为 **vendor 内部惰性自初始化**（`executeExtractMemories` / `executeAutoDream` 首次调用时 init） | `bundle-entry.d.ts` 有 d.ts 镜像契约：opencc-src 被 tsc 排除、无 d.ts，新增导出要么改 `DTS_PATH_REWRITE` 基础设施，要么改 server tsconfig。惰性初始化的行为等价（门禁本就在调用时读 settings），且顺带覆盖 CLI 以外的 embedder |
| `isExtractModeActive()` 新增 zai settings key | 复用既有同意信号：`isAutoMemoryEnabled() && !isMemoryWriteApprovalRequired()` | 用户已选 `requireApprovalBeforeWrite:false`（"允许免审批写记忆"正是后台抽取所需的同意），无需新增 settings key，也避免与 `memory.autoWrite`语义混淆（后者是"关闭整个记忆系统"的别名） |
| 步骤 4 只提"去 GB" | 额外把 `prompts.ts` 的 section 名改为 `memory:${resolveMemCwd()}` | 这是修复缺口 #2（进程级 section 缓存串味）的关键。借既有 `env_info_simple:${model}` 写法，让缓存键随会话 cwd 变化，无需改动缓存机制本身，也不破坏 prompt cache（后缀不进模型可见文本） |
| 步骤 7 移除 4 个 strip 条目 | 只移除 `memdir` / `services/extractMemories` / `services/autoDream` | `services/teamMemorySync` 已硬关闭且无消费者，留在清单里作为"未来若启用再解封"的标记，降低本次 diff |
| 未计划 | 删除 `memdir.ts` 的 combined（auto+team）分支及其模块级 `require('./teamMemPrompts.js')` | team 关闭后该分支是死代码；更关键的是那个模块级 `require` 在 vite-node 下解析不了 `./teamMemPrompts.js`，会让 `bundle-export.test.ts` 直接报 `Cannot find module` |

### 验证证据

| 检查 | 结果 |
|---|---|
| `pnpm run build:core` | 通过（含 `verify-server-types` 自包含校验） |
| `pnpm -r exec tsc --noEmit` | 通过（无输出） |
| `zn-agent-core` 测试 | 1072 passed / 2 failed —— **2 个失败均为既有**：① `smoke.test.ts` 期望版本 `0.7.0` 而实际 `0.11.0`（陈旧断言）；② `openccRuntime-query.test.ts` 超时（干净树 stash 对照复现，属环境耦合：该测试走 vendor `defaultQuery`，而本机 settings 的 `env` 把 base URL 指向公司端点） |
| `zai` 测试 | 3121 passed / 0 failed |
| 新增多会话单测 | 9/9 通过（含"跨会话目录不串味""同 git root 子目录归一""team 已关闭""env 关闭时抽取门为 false"） |
| bundle 核对 | `memoryCwd` 已进 bundle；`shared team directory` 与 `buildCombinedMemoryPrompt` 均为 **0**（team 相关被完全 tree-shake） |
| **真实服务端到端**（dev 实例 8104/7719 + 真实模型） | ① 建会话并把逻辑 cwd 设为临时 git 仓库 `/tmp/zam-e2e-repo` → `GET /agent/sessions/:id/pwd` 确认落库 → 发 prompt → **`~/.zai/projects/-tmp-zam-e2e-repo/memory/` 被创建**（旧代码只会写进程根目录，该目录不可能存在）；② 浏览器走 `/agent` 完整跑完一轮，模型**主动写入**了 `MEMORY.md` + `project_zai_auto_memory.md` 到**该会话的**记忆目录 —— 证明「per-session 目录 + prompt 注入 + 主 agent 落盘」整条链路在真实服务上打通，且无 console error |
| 未观测到 | 界面未出现「已保存记忆」提示 —— **符合设计**：该轮是主 agent 自己写的，`hasMemoryWritesSince` 会让后台抽取器跳过，而"已保存"提示只由抽取器发出 |

### 后续（未做）

- 真实浏览器端到端验收（起 dev 实例走用户路径）——按仓库规则需先询问用户。
- `extractMemories` 的 per-session 游标 + 目录级写互斥已实现，但**未写针对性单测**（依赖 `runForkedAgent`，需要模型桩）。