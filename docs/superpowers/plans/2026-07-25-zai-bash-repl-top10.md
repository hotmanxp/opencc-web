# Plan: Bash REPL Top-10 全局命令历史

> 任务：在 BashTab 上新增"全局聚合命令历史"能力，展示 top10 常用命令 + 输入框下拉建议补全。
> 范围增量：不在 `docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md` 既有契约内，是 spec 外的独立延伸。

---

## 1. 架构分层

### 1.1 Server 侧（`packages/zai/src/server/`）

| 改动点 | 文件 | 行号参考 | 改什么 |
|---|---|---|---|
| 新建 | `services/repl/ReplHistoryService.ts` | — | 单例：`appendCommand(cmd, sessionId)` 原子 append 到 `~/.zai/repl-history.jsonl`；`getTopCommands(n)` 读文件算 topN；内存 cache（TTL 5min）。内部用 `Map<string, Mutex>` 保护并发写同一文件。文件超 10MB 则 rotate。 |
| 改动 | `services/repl/ReplSession.ts` | `exec()` 第 60 行附近 | `exec(command)` 入口处 try/catch 里调用 `replHistoryService.appendCommand(command, sessionId)`。注意：append 时机是"spawn 成功后"，不等 child exit。spawn 失败（`ReplSpawnError`）不写历史。 |
| 改动 | `services/repl/ReplRegistry.ts` | — | `appendCommand` 需要 sessionId，查 `ReplRegistry` 里 `get(sessionId)` 的 session 拿 sessionId，或从路由层直接传。方案：ReplRegistry 提供 `sessionId` getter，或从调用方传入均可。 |
| 新建 | `routes/replHistory.ts` | — | `GET /api/bash/history/top10` → 返回 `Array<{command, count}>`；`GET /api/bash/history/top10?q=prefix` → 按前缀过滤。走 JSON 200。 |
| 改动 | `index.ts` | 第 110 行附近 | `app.use('/api', bashReplRouter)` 下追加 `app.use('/api', replHistoryRouter)`。 |

### 1.2 Shared 侧（`packages/zai/src/shared/`）

| 改动点 | 文件 | 行号参考 | 改什么 |
|---|---|---|---|
| 新增类型 | `repl.ts` | 文件末尾追加 | `TopCommandEntry = { command: string; count: number }`；`TopCommandsResponse = { entries: TopCommandEntry[] }` |

### 1.3 Web 侧（`packages/zai/src/web/src/`）

| 改动点 | 文件 | 行号参考 | 改什么 |
|---|---|---|---|
| 新建 | `lib/replHistoryApi.ts` | — | `fetchTopCommands(n?: number): Promise<TopCommandsResponse>`；`fetchTopCommandsWithPrefix(prefix: string): Promise<TopCommandsResponse>` |
| 改动 | `hooks/useBashRepl.ts` | 第 9 行附近 | 新增 `topCommands` state；`fetchTopCommands()` 在 sessionId 建立后调用一次；`useEffect` 监听 `focus` 事件（或提供 `refreshTopCommands()` 供外部触发） |
| 改动 | `components/splitPane/BashTab.tsx` | 第 152 行 `<Input>` 附近 | 在 `<Input>` 外层包 `Dropdown` + `AutoComplete`；`autoCompleteSource` 从 `useBashRepl.topCommands` 取；按 prefix 过滤；选中后填入 input 并自动 exec；↑↓ key 导航由 AntD `AutoComplete` 内置处理，不与 `onPressEnter` 冲突（`onSelect` 拦截选中，Enter 走默认行为）。也可直接用原生 `<Input list="suggestions">` + `<datalist>` 轻量方案（无样式控制），先评估 AntD AutoComplete 是否值得。 |

---

## 2. 数据流

```
用户敲 Enter / 点击建议
         │
         ▼
BashTab.handleSubmit(cmd)
  │  exec(cmd) ─── POST /api/bash/repl/:sid/exec {command}
  │                    │
  │                    ▼
  │               bashRepl.ts router
  │                    │
  │                    ▼
  │               ReplSession.exec(command)   ← spawn 成功
  │                    │
  │                    ├──────────────────────► ReplHistoryService.appendCommand()
  │                    │                              │
  │                    │                              ▼
  │                    │                        append JSONL line to
  │                    │                        ~/.zai/repl-history.jsonl
  │                    │                        │
  │                    ▼                        ▼
  │               返回 {ok:true, execId}
  │                    │
  ▼                    ▼
execRepl() 返回 ExecResult
         │
         ▼
SSE 事件流继续(stdout/exit) → BashTab 渲染输出

───────────────────────────────────────────

用户聚焦输入框 / 触发建议
         │
         ▼
BashTab autoComplete.onSearch(prefix)
  │  或 useEffect focus → fetchTopCommands()
  │                    │
  │                    ▼
  │  GET /api/bash/history/top10?q=prefix
  │                    │
  │                    ▼
  │               ReplHistoryService.getTopCommands(n, prefix?)
  │                    │
  │                    ├─ cache hit? → 直接返回
  │                    └─ cache miss? → 读 ~/.zai/repl-history.jsonl
  │                                    → group by command 计数
  │                                    → sort by count desc
  │                                    → take n
  │                                    → cache.set(entries, TTL=5min)
  │                    │
  ▼                    ▼
返回 {entries:[{command,count}]}
         │
         ▼
AutoComplete dropdown 渲染 top10 列表
         │
用户 ↑↓ 选中 / Enter / 点击
         │
         ▼
填入 input → exec(cmd)
```

---

## 3. 关键设计决策

### 3.1 持久化时机

**决策：exec spawn 成功后立即 append 到 JSONL，不 debounce，不等 exit。**

理由：
- `ReplSession.exec()` 在 `child.on('error')` 之前就返回了 `execId`，此时子进程已成功 fork，进入"运行"状态。
- 用 `child.on('exit')` 时机写会漏掉"命令已启动但立刻 crash"的情况（如 `sh -c 'exit 1'`）。
- JSONL append 是 O(1) 追加写入，无锁，单次写入 <1ms，足够轻量。
- `ReplSpawnError` 时不写历史（命令本身都没跑起来）。

### 3.2 top10 计算时机

**决策：读时计算 + 内存 cache（TTL 5min）。**

理由：
- JSONL 文件增长慢（每条 ~100 字节），10MB 可存 ~10 万条；全量扫描 <50ms，Node.js 完全可接受。
- 无需 server 启动时预加载（server 重启频繁，没必要每次都扫描）。
- 5min TTL 平衡了"不过期"和"不过度计算"。
- `ZaiSettingsCache` 模式：用 `Map` 存 `entries` + `fetchedAt`，外部调用 `getTopCommands(n)` 时检查 TTL，过期才重新扫描。

### 3.3 文件大小上限

**决策：单文件上限 10MB；超限 rotate 成 `~/.zai/repl-history.1.jsonl`（最多保留 2 个 rotate 文件）。**

理由：
- 10MB 是合理上限，存约 10 万条命令，覆盖绝大多数场景。
- Rotate 后旧文件不再读（只读主文件），避免无限增长。
- 不做自动 GC，rotate 手动管理最简单。

### 3.4 下拉建议 UI

**决策：聚焦 `<Input>` 时显示 top10 列表，输入时按 prefix 过滤。**

方案选型：AntD `AutoComplete` 优于原生 `<datalist>`（样式控制、键盘导航、prefix 过滤开箱即用）。

交互细节：
- `autoCompleteSource` 取 `topCommands.filter(e => e.command.startsWith(prefix))`（prefix 前缀匹配）。
- `onSelect(value)` 里直接调 `exec(value)` 并清空 input。
- `onPressEnter` 行为不变（已有 `e.preventDefault()`），但当 input 非空时直接 exec。
- **Arrow key 冲突**：AntD AutoComplete 内置处理 ↑↓，不冒泡到 `onPressEnter`（`key !== 'Enter'` 时不 preventDefault）。若使用原生 `<datalist>`，↑↓ 不触发 `onChange`，Enter 走 `onPressEnter`，不冲突。

### 3.5 失败语义

**决策：`ReplSpawnError`（如命令不存在、权限不足）不写历史。**

理由：
- 命令根本没跑起来，用户不太可能在历史里看到"失败命令"。
- 如果用户故意测试错误命令，可以在 replay 中再输入一次。

**`child.on('exit', (code, signal))` 里的 exit code 不影响写入：任何 exit（0/1/127/信号终止）都视为"命令已执行"，都写入历史。**

### 3.6 去重策略

**决策：JSONL 文件按原始顺序存连续相同命令（不去重），top10 按"出现频次"（count）排序。**

理由：
- 保留完整时间序列信息，便于未来做"最近 7 天"或"本月"过滤。
- 如果用户同一命令跑了 3 次，top10 里该命令 count=3。
- **不考虑 LRU**：LRU 适合单 session 本地历史，不适合"全局频次 top10"的语义。

### 3.7 隐私/敏感命令

**决策：blocklist + 长度下限。**

Blocklist 模式（正则）：
- `/(password|passwd|pwd|secret|token|api[_-]?key|aws[_-]?key|bearer)\s*=/i`
- `/(curl|wget)\s+.*\b-H\s+['"](Authorization|Bearer|token)/i`

写入时过滤：匹配 blocklist 的命令直接跳过，不 append。

理由：
- 不做 allowlist（用户命令变化太多）。
- 宁可漏掉一些（假阴）也不写敏感信息（假阳更危险）。
- blocklist 不完美，但覆盖最常见模式。

### 3.8 并发写入

**决策：单进程内用 `async-mutex` 或手写 Promise-chain 串行化同一文件写入。**

实现：`ReplHistoryService` 内部 `Map<string, Promise<void>>`（每个文件路径一个 pending promise chain），每次 append 时 `await` 前一个写完再写下一个。

理由：
- Node.js `fs/promises.appendFile` 本身不是原子写（可能跨多条），但 JSONL 每行独立，追加顺序错位不会破坏格式。
- 真正危险的是"读-改-写"（topN 计算时读文件），通过 TTL cache 规避：读文件只在 cache miss 时发生，此时已是串行的 promise chain。

多进程（多个 zai server 实例）不处理（用户通常只跑一个实例）。

### 3.9 服务端权威 vs 客户端权威

**决策：服务端权威（server 计算 topN，client 只负责展示和 prefix 过滤）。**

理由：
- 客户端无法看到其他 session 的历史，top10 必须是全局的。
- 前端只做 prefix 过滤（`startsWith`）作为 UX 优化，避免每次按键都请求 server。
- 如果 server 返回量小（top10 只有 10 条），前端过滤代价可忽略。

---

## 4. 任务拆分

### Task 1: Shared 类型 + 服务端基础（JSONL append + 路由）

**输入**：`repl.ts`、`paths.ts`、`index.ts` 现状
**输出**：
- `shared/repl.ts` 新增 `TopCommandEntry` / `TopCommandsResponse`
- `services/repl/ReplHistoryService.ts` 新建：单例，`appendCommand(cmd, sessionId)` 原子写 `~/.zai/repl-history.jsonl`；`getTopCommands(n, prefix?)` 带 TTL cache。
- `services/repl/ReplHistoryService.test.ts` 单元测试
- `routes/replHistory.ts` 新建：`GET /api/bash/history/top10`（支持 `?q=` prefix 过滤）
- `index.ts` 挂载新 router
**文件改动**：
- `shared/repl.ts`（尾部追加类型）
- 新建 `services/repl/ReplHistoryService.ts`
- 新建 `routes/replHistory.ts`
- `server/index.ts`（第 110 行附近追加 mount）
**完成判定**：新增路由返回 `{entries:[{command,count}]}`，单元测试覆盖 append + getTopCommands + rotate + blocklist + 并发串行化

---

### Task 2: ReplSession 集成

**输入**：`ReplSession.ts`、`ReplHistoryService.ts`
**输出**：`ReplSession.exec()` 成功返回后调用 `replHistoryService.appendCommand()`
**文件改动**：`services/repl/ReplSession.ts` 第 60-93 行 `exec()` 方法内，在 `spawn` 成功返回 `execId` 后加一行 `void replHistoryService.appendCommand(command, this.sessionId)`。注意：`ReplSession` 目前无 `sessionId` 字段，需在构造或 via 参数传入——最简方案是 `exec(command, opts, sessionId?)`，或在 `ReplRegistry.get()` 时标记 sessionId。
**完成判定**：集成测试 `bashRepl.test.ts` 验证 exec 后 history 文件有对应行

---

### Task 3: 前端 API 层

**输入**：`bashReplApi.ts` 风格
**输出**：新建 `lib/replHistoryApi.ts` —— `fetchTopCommands(n?: number)` 和 `fetchTopCommandsWithPrefix(prefix: string)`
**文件改动**：新建 `packages/zai/src/web/src/lib/replHistoryApi.ts`
**完成判定**：`vitest` 模拟 fetch，验证请求 URL 和响应解析正确

---

### Task 4: useBashRepl hook 扩展

**输入**：`useBashRepl.ts`
**输出**：
- 新增 `topCommands: TopCommandEntry[]` state
- `refreshTopCommands()` 函数（手动刷新）
- `useEffect` 在 sessionId 建立后调用 `fetchTopCommands()` 一次
**文件改动**：`hooks/useBashRepl.ts`（第 18-21 行 state 区新增 `topCommands`；第 25-56 行 useEffect 区新增 fetch）
**完成判定**：`useBashRepl.test.ts` mock `fetchTopCommands`，验证 sessionId 变化触发 fetch

---

### Task 5: BashTab UI — 下拉建议

**输入**：`BashTab.tsx`
**输出**：
- 引入 `AutoComplete` from AntD（或评估 `<datalist>` 轻量方案）
- `autoCompleteSource` 从 `useBashRepl.topCommands` 取
- `onSelect` → `exec(value)` + 清空
- 输入时 `onSearch` 按 prefix 过滤
**文件改动**：`components/splitPane/BashTab.tsx`（第 1-4 行 import 区；第 152 行 `<Input>` 替换为 `<AutoComplete>`；第 51 行 `useBashRepl` 解构增 `topCommands`）
**完成判定**：`BashTab.test.tsx` 验证聚焦显示列表、选中填入、Enter 执行

---

### Task 6: 端到端集成测试

**输入**：所有改动后的文件
**输出**：覆盖完整路径的集成测试
**文件改动**：
- `routes/bashRepl.test.ts` 新增 case：exec 后 `GET /api/bash/history/top10` 验证命令出现
- `services/repl/ReplHistoryService.e2e.test.ts`（或并入 `bashRepl.test.ts`）：多 session 并发写、rotate 验证、blocklist 验证
**完成判定**：所有新 case 通过

---

### Task 7: 清理 + 文档

**输入**：所有新文件
**输出**：
- `docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md`（本文档）已是 plan
- 更新 `AGENTS.md` 关键文件表格（如需）
- 确认 `docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md` 末尾"Out of scope"追加本任务边界说明
**完成判定**：docs 语法正确，引用路径有效

---

## 5. 测试策略

| Task | 测试文件 | 覆盖 case |
|---|---|---|
| Task 1 | `services/repl/ReplHistoryService.test.ts` | `appendCommand` 单条写入；多条追加；`getTopCommands` topN 排序；prefix 过滤；TTL cache 过期重读；rotate 触发（mock fs 大小）；blocklist 过滤；并发串行化（多个 `appendCommand` 并发 await）；`getTopCommands` 文件不存在时返回空数组 |
| Task 1 | `routes/replHistory.test.ts`（新建） | `GET /api/bash/history/top10` 返回 200 + `entries` 字段；`?q=foo` 返回过滤后结果；无历史时返回空数组 |
| Task 2 | `services/repl/__tests__/ReplSession.test.ts` | exec 后 history 有对应行（mock ReplHistoryService）；`ReplSpawnError` 不写历史 |
| Task 2 | `routes/bashRepl.test.ts` | （已在现有 suite 末尾追加 case） |
| Task 3 | `lib/replHistoryApi.test.ts`（新建） | `fetchTopCommands` 解析正确响应；`fetchTopCommandsWithPrefix` 带 query param；404 时抛出 Error；网络错误抛出 Error |
| Task 4 | `hooks/useBashRepl.test.ts` | sessionId 建立后 `fetchTopCommands` 被调用一次；`refreshTopCommands` 被调用时重新 fetch |
| Task 5 | `components/splitPane/BashTab.test.tsx` | 聚焦 input 显示 top10 下拉（mock fetchTopCommands）；点击建议项触发 exec；`onSearch` 按 prefix 过滤（mock topCommands）；busy=true 时下拉仍可用（或不可用，明确策略） |
| Task 6 | `bashRepl.test.ts`（扩展） | exec 后 top10 包含该命令（count=1）；同一命令两次 exec，count=2；不同 session 写同一 history 文件 |

---

## 6. 不做什么（Out of Scope）

- **Tab 补全**（`brew install b` → `brew install brew`）：不在本任务范围。
- **Ctrl-R 历史搜索**：需要独立 UI，不在本任务范围。
- **跨 session 合并 cursor 位置的命令**（history search 里的 ↑↓ 导航）：AntD AutoComplete 内置 ↑↓ 在 dropdown 内导航，不影响 input 默认行为。
- **命令历史重放**（session resume 后 replay 历史命令）：spec §1 已列为 Non-goal，本任务不改变该决策。
- **Ctrl-C 中断后的历史**：child exit 时不额外写历史（已在 Task 1 中明确：写历史时机是 spawn 成功，不等 exit）。
- **MCP 工具的命令历史**：仅限用户直接在 BashTab 输入的 `sh -c` 命令。

---

## 7. 风险清单

### 风险 1: history 文件无限增长

**描述**：用户长期使用 zai，JSONL 文件无限增长到数百 MB，导致 `getTopCommands` 扫描超时或 OOM。

**缓解**：文件超 10MB 时 rotate 成 `.1.jsonl`（最多 2 个 rotate 文件），最多保留 ~30MB 数据。rotate 后旧文件不参与 topN 计算。

**残余风险**：rotate 文件积累（2 个 rotate + 主文件 = 30MB 上限），如果用户高频使用仍有上限保护。

---

### 风险 2: 并发写入损坏 JSONL 格式

**描述**：两个 `ReplSession.exec()` 同时 append 到 `~/.zai/repl-history.jsonl`，两条 JSON 行被 OS 穿插写入，导致 JSONL 行损坏（半条 JSON + 下一条 JSON 前缀）。

**缓解**：单进程内用 Promise-chain 串行化：每个文件路径维护一个 `pendingWrite: Promise<void>`，新写入 `await` 前一个写完后再写。Node.js `fs/promises.appendFile` 在 POSIX 系统上是原子追加（不超过 PIPE_BUF 约 4KB），但 JSONL 单行通常 <200 字节，完全安全。

**残余风险**：多进程（两个 zai server 同时跑同一 `~/.zai`）不做处理（用户通常不会这么做）。

---

### 风险 3: AntD `AutoComplete` 与 `onPressEnter` 键盘冲突

**描述**：`AutoComplete` 的内置 ↑↓ 导航和 Enter 选中逻辑与 `BashTab.handleSubmit` 的 `onPressEnter` 冲突，导致用户在 dropdown 可见时按 Enter 不触发 exec（而是触发了 AutoComplete 默认行为），或在 dropdown 关闭时无法用 Enter 提交输入。

**缓解**：
- `AutoComplete` 设置 `openOnFocus`（仅聚焦时展开，不在输入时自动展开）。
- `onSelect` 里 `exec(value)` 并 `setInput('')`，已满足选中即执行语义。
- `onPressEnter` 保留，行为不变：如果 dropdown 打开且有选中项，Enter 实际上走 `onSelect`（AntD 行为），同时 `onPressEnter` 的 `e.preventDefault()` 不阻止 `onSelect`。若 dropdown 关闭，Enter 正常触发 `handleSubmit`。
- 测试覆盖：确认"dropdown 打开时按 Enter 执行命令"和"dropdown 关闭时按 Enter 执行命令"两种路径。

**残余风险**：需 vitest 覆盖两种 Enter 路径，确保 AutoComplete 版本升级后行为不退化。

---

### 风险 4: blocklist 假阳导致常用命令被误过滤

**描述**：用户频繁运行 `git credential-osxkeychain get` 或 `aws configure` 等合法命令，被 blocklist 正则 `/(password|token|key)/i` 过滤，导致这些高频命令永远不进入 top10。

**缓解**：blocklist 仅过滤"明显包含赋值"的模式（如 `PASSWORD=xxx`），不拦截命令名本身。可选：提供 `ZAI_REPL_HISTORY_DISABLE_BLOCKLIST=1` 环境变量跳过过滤。

**残余风险**：blocklist 永远无法完美，需在文档中说明局限性。

---

### 风险 5: 前端频繁请求 `/api/bash/history/top10`

**描述**：用户每次按字母键，`onSearch` 都发 `fetchTopCommandsWithPrefix` 请求，导致大量无效网络请求。

**缓解**：前端做 debounce（300ms），或直接用已有的 `topCommands` state 做 prefix 前端过滤（`startsWith`），不发请求。选中时或首次聚焦时只请求一次 top10。

**残余风险**：首次聚焦时如果 `topCommands` 为空，需等待请求；用户感知到下拉延迟。可选：server 启动时预热 cache。
