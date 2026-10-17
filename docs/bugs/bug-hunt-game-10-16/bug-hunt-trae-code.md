# Bug 发掘报告 · trae-code

**参赛者**：`trae-code`
**日期**：2026-10-16
**基准提交**：`6f9ceaeb`（`main`）

---

## 一、取证环境

- 工作树状态（收口前 `git status --porcelain` 输出）：
  ```
  ?? docs/bugs/bug-hunt-game-10-16/
  ```
  开局（基线快照时）与收口前一致：仅比赛目录本身，无任何其他改动。HEAD 全程 `6f9ceaeb7c9bf63e71f4deea9346f790a107ea14`。
- typecheck 基线结果（§3.3）：
  ```
  zai  exit = 0   错误数 = 0
  core exit = 0   错误数 = 0
  ```
  （core 尾行：`[verify-server-types] OK — 5 d.ts file(s) ... self-contained`）
  - 已知基线：两个包都是 **exit 0，零预存错误**（README §3.4）
  - 我的基线与已知基线的差异：**无**（完全一致）。本报告未引用任何 typecheck 证据，不存在差集问题。
- 我实际执行过的命令（取证类）：
  ```bash
  mkdir -p /tmp/bughunt-trae-code
  git rev-parse HEAD > /tmp/bughunt-trae-code/head.txt
  git status --porcelain  > /tmp/bughunt-trae-code/status-before.txt
  pnpm --filter @zn-ai/zai run typecheck          > /tmp/bughunt-trae-code/tc-zai.log  2>&1   # exit 0
  pnpm --filter @zn-ai/zn-agent-core run typecheck > /tmp/bughunt-trae-code/tc-core.log 2>&1   # exit 0

  # 复现 1（tc-001）：
  cd packages/zai && ./node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-offline-race.mts
  # 复现 2（tc-002）：
  cd packages/zn-agent-core && ../zai/node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-tasklist.mts
  # 复现 3（tc-003）：
  cd packages/zai && ./node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-provider.mts
  ```
- **数据隔离自证（铁律 10）**：是。三个脚本全部显式隔离，**没有任何一步触碰 `~/.zai/`、`~/.zai.json`、`~/.claude.json`**：
  - `repro-offline-race.mts` 脚本头部注明隔离声明，每个用例执行 `process.env.ZAI_DATA_DIR = /tmp/bughunt-trae-code/aa-cases/<case>`（`aaDir()` 每次调用重读 env，故同进程切换目录安全）；
  - `repro-tasklist.mts` 同时重定向 `process.env.HOME` 与 `process.env.ZAI_DATA_DIR` 到 `/tmp/bughunt-trae-code/tl-cases/*`（该 bug 的验证点正是 HOME vs ZAI_DATA_DIR 的分叉）；
  - `repro-provider.mts` 重定向 `process.env.HOME=/tmp/bughunt-trae-code/prov-cases/fakehome`——`fileStore.ts:22-26` 的全部落盘路径基于 `homedir()`，因此 PUT/GET 的真实磁盘写入落在 `fakehome/.claude.json`。
  - `/tmp/bughunt-trae-code/node_modules` 是指向 `packages/zai/node_modules` 的符号链接，仅为让 `/tmp` 下的脚本解析 bare import，不写仓库。
- **端口自证（铁律 11）**：我未起 zai dev 实例，未占用任何固定端口；唯一监听来自 `repro-provider.mts` 的 `app.listen(0, '127.0.0.1')`（OS 分配临时端口，用毕 `server.close()`），920x 全程未触碰。

---

## 二、排查范围

| 子系统 | 是否排查 | 结论 |
|---|---|---|
| `packages/zai/src/server/routes/` | 部分 | 读了 `event.ts`、`tasks.ts`、`terminal.ts`、`bashRepl.ts`、`config.ts`、`v2Tasks.ts`、`agent.ts`(DELETE 路由段)、`system.ts`；发现 tc-003 |
| `packages/zai/src/server/services/` | 部分 | 读了 `sse.ts`、`eventBus.ts`、`sessionInbox.ts`、`subagentNotifier.ts`、`approveRegistry.ts`、`stateBridge.ts`、`updater.ts`、`historyArchive.ts`、`fileStore.ts`、`zaiSettingsStore.ts`、`paths.ts`、`repl/ReplRegistry.ts`、`repl/ReplSession.ts`、`terminal/TerminalService.ts`、`aaClient/offlineBuffer.ts`、`aaClient/connection.ts`；发现 tc-001 |
| `packages/zai/src/web/`（前端组件 / store / hooks） | 部分 | 读了 `useEventStream.ts`、`lib/eventSource.ts`、`useAgentStore.ts` 的 seq 守卫与 `applyAgentTaskChanged`、`Config.tsx` 的 ProviderForm；tc-003 的触发路径在此 |
| `packages/zn-agent-core/src/compat/` | 部分 | 读了 `bashTracker.ts`、`permissions.ts`、`cwdStore.ts`、`taskListStore.ts`、`sandboxManager.ts`、`inboxBridge.ts`、`messageQueueAdapter.ts`、`dangling-shims/*`、`subprocess/{spawn,jsonRpc}.ts`、`runtime/bun-protocol.mjs`；发现 tc-002 |
| `packages/zn-agent-core/src/agents/` `tools/` `commands/` | 未排查 | 时间预算用尽（见下） |
| `packages/zn-agent-core/src/opencc-src/`（vendor） | 仅点状 | 只沿 import 链查了 `utils/memoize.ts` 等对 `lru-cache` 的裸导入（为核实 dangling-shims 断链，见自我否定清单）；未做系统性扫描 |
| 其他：`docs/bugs/`（22 条已知清单 + rank.md 索引） | 是 | 全部读了一遍标题与共同根因，用于避坑 |

**我读过但明确放弃的区域**：

| 区域 | 放弃理由 |
|---|---|
| `services/weixinBot/**` | 已知 22 条中 5 条集中于此（游标 / 指纹去重 / 锁累积 / 记忆轮转 / media），继续挖重报风险最高 |
| `services/instanceSupervisor.ts`、`services/factorySettings.ts`、`taskFactoryBridge.ts`、`utils/fsWrite.ts` | 已知清单或「同族未修」直接点名 |
| vendor 被 stub 的 `.tsx` 组件体 | §3.2 第 5 条，不是缺陷 |
| `fs.ts` 路径解析 / `safePath.ts` | 已知 symlink-traversal / DNS rebinding 两条的领地 |

**为什么没排查其它区域**：时间预算用尽，优先保证三个已抓到的缺陷全部做到「有对照组的可执行复现」，而不是继续铺开新区域。

---

## 三、Bug 报告

### [tc-001] 标题：AA offline buffer 重连补发期间的并发 enqueue 被 drain 的整体截断静默销毁（5/5 条确定性丢失）

- **严重度**：S2（理由：静默丢用户工作——离线期间积压的 AA 会话状态 / timeline 通知在重连补发时被无条件 `writeFile(path,'')` 整体抹掉，既未发送也未留存；AA Web 端时间线永久缺帧，无任何报错）
- **证据等级**：E3a（理由：真实执行被测模块 `OfflineBuffer`（仅连接层用受控 fake 替代——它是依赖而非被测对象），断言可观测的磁盘终态与发送记录；未做真实 HTTP/WS 端到端，故不自称 E3b）
- **执行环境**：运行时 Node v22.22.3 · 工具链 tsx 4.23.0（产品 dev 同款 tsx 直跑路径）· 平台 darwin-arm64
  - 为什么这个环境代表用户：产品 Node-direct 运行时即 `tsx` + Node 22；脚本只 import 真实模块源码，未 mock 被测对象
- **位置**：`packages/zai/src/server/services/aaClient/offlineBuffer.ts:93`（readFile 快照）、`:99-108`（send 循环）、`:112`（`await writeFile(path, '', 'utf-8')` 整体截断）、`:72-82`（`enqueue` 的 `appendFile` 无互斥）；同文件 `:98` 残留死变量 `const remaining: string[] = []`、`:109-111` 注释声称的「下一 tick 重读重发」与实际行为相反。配套调用方：`packages/zai/src/server/services/aaClient/connection.ts:280-288`（断线时 `queueOffline` 重回**同一文件**）、`:307-316`
- **触发路径**：AA 连接抖动 → 事件适配器/`sendNotification` 断线分支把通知 `enqueue` 进 `outbox-<port>.jsonl` → 重连成功 → `maybeDrain()`（1s 轮询触发）开始 `readFile` → 补发期间（真实场景：重连瞬间恰是流量恢复、新通知最多的时候）任何一次 `enqueue` 的 `appendFile` 落在「readFile 快照之后、截断之前」→ `writeFile(path,'')` 把它连同快照外的一切一并抹掉 → **该通知既未发送也不在磁盘上，永久丢失**
- **现象**：预期——drain 与 enqueue 并发时，drain 后落盘的新条目保留到下一轮补发；实际——条目被截断清零，`maybeDrain` 返回的 `replayed` 计数也不包含它们
- **影响**：断网恢复窗口内产生的 AA 通知（session.state.updated / timeline.itemUpsert / notice.upserted 等，即 AA Web 时间线的全部素材）静默丢失；断续网络（地铁/睡眠唤醒）下每次重连都是一次暴露窗口；无日志无重试（`replayed++` 只计成功发送，丢失不可见）
- **对照组**（E3 必填）：
  - 对照组是什么：同一 OfflineBuffer、同一 5 条 `victim` enqueue、同一磁盘目录布局，唯一差别是**是否有一条 drain 在飞**（experimental `drain=true` vs control `drain=false`）
  - 对照组输出（真实输出）：
    ```
    [experimental] drain=true  prefillSize=790 sizeAfterEnqueue=790 finalSize=0   victimSent=0 victimOnDisk=0 LOST=5
    [control]      drain=false prefillSize=790 sizeAfterEnqueue=790 finalSize=1180 victimSent=0 victimOnDisk=5 LOST=0
    RESULT: experimental LOST=5 (expect >0), control LOST=0 (expect 0)
    ```
  - 它为什么有区分力：control 证明同样的 enqueue 在无并发 drain 时**全部持久化**（1180 字节 = 预填 790 + 5×78）；experimental 中相同 5 条既不在磁盘（finalSize=0，说明截断发生在全部 append 之后）也从未被发送。两组唯一变量是并发 drain，输出差异只能由 drain 的截断造成
  - 状态复位：每个用例独立 `ZAI_DATA_DIR` 子目录 + `resetOfflineBufferForTests()`（重置单例），文件系统 `rmSync` 从零建
- **复现步骤**（E2/E3 必填）：
  1. `ZAI_DATA_DIR=<tmp>/aa-cases/experimental` 下预填 outbox-9099.jsonl 10 条（全部落盘确认）
  2. 启动 `maybeDrain()`（不 await），主线程 `Atomics.wait` 25ms——readFile 在线程池并行完成，读快照冻结为 10 条预填
  3. 并发发起 5 条 `enqueue('victim',...)`（不 await），再阻塞 25ms 让 appendFile 落盘
  4. 解除阻塞 → drain 补发 10 条预填后 `writeFile(path,'')` 截断 → 5 条 victim 被抹
  5. 断言：磁盘 0 字节、`victimSent=0`、`victimOnDisk=0` → 5 条全部丢失
  - 交错固定手法说明（诚实披露）：两段 `Atomics.wait` 只是把 libuv 线程池并行性转成确定交错——真实场景里 `sendNotification` 的 WS 帧/TLS/日志耗时同样在读快照与截断之间留出窗口，且重连后高流量使并发 enqueue 必然出现；脚本未对被测模块做任何补丁
- **复现命令与输出**（E3 必填，贴真实输出，注明与 §3.4 基线的差集）：
  ```bash
  cd /Users/ethan/code/opencc-web/packages/zai && ./node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-offline-race.mts
  # [experimental] drain=true  prefillSize=790 sizeAfterEnqueue=790 finalSize=0   victimSent=0 victimOnDisk=0 LOST=5
  # [control]      drain=false prefillSize=790 sizeAfterEnqueue=790 finalSize=1180 victimSent=0 victimOnDisk=5 LOST=0
  # RESULT: experimental LOST=5 (expect >0), control LOST=0 (expect 0)
  ```
  与 §3.4 基线差集：无（基线零错误，本复现不涉及 typecheck）
- **修复方案**：改 `offlineBuffer.ts:112` 的 `maybeDrain`——把「读全文 → 发送 → `writeFile(path,'')`」改为**逐行消费**：读出后记住本次消费的字节偏移/行数，只对已成功 `sendNotification` 的**行前缀**做截断（或重写为剩余行）；并给 `enqueue` 与 `drain` 加同一把 Promise 互斥（draining 标志目前只拦 `maybeDrain` 重入，拦不住 `enqueue`）。同时删除 `:98` 死变量、修正 `:109-111` 注释。副作用注意：部分发送失败时重写需保留未发送行，避免把「发送失败」降级为「丢弃」
- **上游对照**：未查

### [tc-002] 标题：`getTaskListStore()` 生产 fallback 永远落 `${HOME}/.zai`，无视 `ZAI_DATA_DIR`；注释声称的注入从未发生

- **严重度**：S3（理由：设置了 `ZAI_DATA_DIR` 的实例把 V2 任务清单写到错误位置 `$HOME/.zai/tasks/`——既违背仓库自己文档化的数据目录契约（`paths.ts` 为同一目录族提供 env 感知函数），也让多实例/测试环境「数据目录隔离」承诺对 TaskCreate/TaskUpdate/TaskList 工具与 `/v2-tasks` 路由失效。不到 S2：文件仍能读写，只是落点错，无数据损坏）
- **证据等级**：E3a（理由：真实模块、真实磁盘断言、无 mock；端到端需起隔离 dev 实例跑一轮真实 agent turn 才能到 E3b，时间预算内未做）
- **执行环境**：运行时 Node v22.22.3 · 工具链 tsx 4.23.0 · 平台 darwin-arm64（产品同款 Node-direct 路径）
- **位置**：`packages/zn-agent-core/src/compat/taskListStore.ts:284-292`（`getTaskListStore` fallback `` `${process.env.HOME ?? '/tmp'}/.zai` ``）、`:286-289`（注释「这里延迟到 BackgroundRuntime 注入的同时注入」）；调用面：`packages/zai/src/server/routes/v2Tasks.ts:32`、`packages/zai/src/server/routes/sessionState.ts:75`、`packages/zn-agent-core/src/compat/tools/tasks/TaskCreateTool.ts:14`（TaskUpdate/TaskGet/TaskList 同）；对照面：`packages/zai/src/server/services/paths.ts:23,26`（`ZAI_DIR`/`BACKGROUND_DIR` 均感知 `ZAI_DATA_DIR`）
- **触发路径**：zai 实例以 `ZAI_DATA_DIR=/x` 启动 → LLM 调 TaskCreate 工具（或前端访问 `GET /api/agent/sessions/:sid/v2-tasks`）→ `getTaskListStore()`（`taskListStore.ts:284`）→ `setTaskListStore` 全仓**仅测试调用**（grep 证据见下）→ 走 `:289` fallback → 任务文件写到 `$HOME/.zai/tasks/<sid>.json` 而非 `/x/tasks/`
- **现象**：预期——数据目录重定向后任务清单跟随 `ZAI_DATA_DIR`；实际——永远写真实 `$HOME/.zai/tasks/`，与同进程内 `BACKGROUND_DIR`（`paths.ts:26`，感知 `ZAI_DATA_DIR`）互相分叉
- **影响**：① 隔离环境（`ZAI_DATA_DIR` 是本仓库测试/多实例的标准姿势，AGENTS.md 明文记载）下任务数据污染真实用户目录；② 多实例共享 `$HOME/.zai/tasks/`，隔离失效；③ 注释描述的注入机制不存在，后续维护者会按错误心智模型改动
- **对照组**（E3 必填）：
  - 对照组是什么：显式 `setTaskListStore(new TaskListStore(<ZAI_DATA_DIR>))`（即注释声称会发生、实际从未发生的注入路径），同样执行 `create`
  - 对照组输出（真实输出）：
    ```
    fallback wrote to $HOME/.zai/tasks : true
    intended ZAI_DATA_DIR/tasks      : false
    control (explicit setTaskListStore) wrote to ZAI_DATA_DIR/tasks : true
    control fallback file for sess-tc-2 absent: true
    ```
  - 它为什么有区分力：同一进程、同一 sessionId 规则，唯一变量是「走 fallback」还是「显式注入」；fallback 落 `$HOME/.zai`、注入落 `ZAI_DATA_DIR`，证明缺陷在 fallback 根目录的解析而非 TaskListStore 本身
  - 状态复位：每用例独立 `/tmp` 目录；`HOME` 与 `ZAI_DATA_DIR` 显式重定向后进程即退出，无共享单例污染
- **复现步骤**（E2/E3 必填）：
  1. `process.env.HOME=<tmp>/fakehome; process.env.ZAI_DATA_DIR=<tmp>/zai-home`（双隔离）
  2. 直接调用生产路径 `getTaskListStore().create('sess-tc-1', ...)`（zai server 从不注入，这就是生产行为）
  3. 检查两侧目录
- **复现命令与输出**（E3 必填）：
  ```bash
  cd /Users/ethan/code/opencc-web/packages/zn-agent-core && ../zai/node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-tasklist.mts
  # fallback wrote to $HOME/.zai/tasks : true
  # intended ZAI_DATA_DIR/tasks      : false
  # control (explicit setTaskListStore) wrote to ZAI_DATA_DIR/tasks : true
  # control fallback file for sess-tc-2 absent: true
  ```
  与 §3.4 基线差集：无
- **不可触发自证**：本缺陷「生产必触发」，反向需要自证的是**注入确实从未发生**——全仓 grep `setTaskListStore`：命中 17 处，除 `taskListStore.ts:294` 定义与 `bundle-entry.ts:279` 再导出外，**全部是 `test/` 下的测试文件**（`taskToolsIntegration.test.ts`、`TaskCreateTool.test.ts` 等），`packages/zai/src/server/` 无任何调用（含 `backgroundRuntime.ts`、`agentRuntime.ts`）。zai 侧对 `getTaskListStore` 的生产调用点为 `v2Tasks.ts:32` 与 `sessionState.ts:75`，均走 fallback
- **修复方案**：两选一——① zai server 启动时按 `paths.ts` 的数据目录解析显式 `setTaskListStore(new TaskListStore(<ZAI_DIR>))`（兑现注释承诺）；② 把 `taskListStore.ts:289` 的 fallback 改为 `` join(process.env.ZAI_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.zai'), 'tasks') `` 并加目录名一致性测试。副作用注意：既有用户在 `$HOME/.zai/tasks/` 已有历史文件，改动后需一次性迁移或兼容读取
- **上游对照**：未查（`compat/` 是 zai 专属层）

### [tc-003] 标题：`PUT /api/config/:tool/provider` 的 zod schema strip 未声明字段——profile 内联 `apiKey`（运行时解析顺位 #1）一次保存即静默丢失

- **严重度**：S3（理由：静默配置丢失——用户手工写入 `~/.zai.json`/`~/.claude.json` 的内联 key 在任何一次 Provider 表单保存/删除操作后无提示消失，此后 `modelCaller` 解析链静默跌落到 env/全局 env，表现为「没改过任何东西但 LLM 突然 401/用错 key」。不升 S2：可通过重新手工编辑恢复，且受影响人群限于使用内联 `apiKey` 的用户）
- **证据等级**：E3b（理由：真实 HTTP——以真实 Express 挂载**真实路由模块** `routes/config.ts`，走真实 handler 链与真实 `fileStore` 磁盘写入，断言真实响应体与落盘 JSON；唯一偏离是挂载在最小 app 而非完整 zai server，路由注册路径 `/api` 与生产 `index.ts` 相同）
- **执行环境**：运行时 Node v22.22.3 · 工具链 tsx 4.23.0 · 平台 darwin-arm64（产品 Node-direct 同款；Express 4.22.1 与 zai 锁定版本一致）
- **位置**：`packages/zai/src/server/routes/config.ts:28-51`（`ProviderProfileSchema` 声明了 `apiKeyEnv` 但**没有** `apiKey`，zod `z.object` 非 strict 默认剥离未声明键）、`:233-249`（PUT handler `:243` 把剥离后的 `parsed.data.profiles` 整体写回）；运行时消费方：`packages/zai/src/server/services/modelCaller.ts:262`（`apiKey: profile.apiKey ?? envKey ?? fallbackKey`）、`packages/zai/src/shared/types.ts:237`（注释承认「inline, if set — not currently surfaced in UI」）；前端放大器：`packages/zai/src/web/src/pages/Config.tsx:136-155`（`handleModalOk` 重建 profile 时显式保留 `extraParams` 却**不保留** `apiKey`）、`:160`（`api.put(endpoint, { profiles: updated })`）
- **触发路径**：用户手工在 `~/.zai.json` 写入带内联 `apiKey` 的 profile → 打开 Config → Provider 表单，编辑任意字段（改名/改 baseUrl）或删除另一个 profile → 前端以表单值重建 profile 数组 PUT → 服务端 schema 再 strip 一次 → `~/.zai.json` 落盘时 `apiKey` 消失 → 下一次 LLM 调用解析链跌落到 `zaiEnv[apiKeyEnv]` → 环境变量缺失时请求失败或用错凭据
- **现象**：预期——round-trip 保存不丢用户配置字段（同文件里 `extraParams` 就被专门保留了）；实际——GET 明文返回 `apiKey`（前端拿得到），PUT 返回 200 `{ok:true}`，落盘 JSON 中 `apiKey` 无声消失
- **影响**：静默凭据丢失 + LLM 请求发错凭据目标；GET 仍返回该字段又会误导用户以为它还在
- **对照组**（E3 必填）：
  - 对照组是什么：同一 PUT 流程中只含**已声明字段** `apiKeyEnv` 的 profile
  - 对照组输出（真实输出）：
    ```
    GET  round-trip: apiKey present = true
    PUT status = 200 { ok: true }
    DISK after PUT: apiKey present = false | apiKeyEnv present = true | model present = true
    CONTROL: apiKeyEnv survived = true
    ```
  - 它为什么有区分力：同一 schema、同一 PUT、同一落盘路径——已声明字段（`apiKeyEnv`、`model`）全部幸存，唯独未声明的 `apiKey` 被剥，证明丢失由 schema 白名单造成而非写盘环节
  - 状态复位：独立 `HOME=fakehome`，预置文件与结果文件都在 `/tmp`，进程退出即弃
- **复现步骤**（E2/E3 必填）：
  1. `HOME=<tmp>/fakehome`，预置 `fakehome/.claude.json`，`providerProfiles[0]` 含 `apiKey: 'sk-INLINE-SECRET'` 与 `apiKeyEnv`
  2. 真实 Express 挂载 `routes/config.ts` 于 `/api`（临时端口 `listen(0)`）
  3. `GET /api/config/opencc/provider` → 记录响应含 `apiKey`
  4. `PUT` 原样回传同一 profiles 数组（等价于前端保存）
  5. 读落盘文件断言 `apiKey` 消失
- **复现命令与输出**（E3 必填）：
  ```bash
  cd /Users/ethan/code/opencc-web/packages/zai && ./node_modules/.bin/tsx /tmp/bughunt-trae-code/repro-provider.mts
  # GET  round-trip: apiKey present = true
  # PUT status = 200 { ok: true }
  # DISK after PUT: apiKey present = false | apiKeyEnv present = true | model present = true
  # CONTROL: apiKeyEnv survived = true
  ```
  与 §3.4 基线差集：无
- **修复方案**：改 `config.ts:28-51` 的 `ProviderProfileSchema`，增加 `apiKey: z.string().optional()`（与 `modelCaller.ts:262` 的运行时解析对齐）；前端 `Config.tsx:136-155` 的 `nextProfile` 同步补 `...(existing?.apiKey ? { apiKey: existing.apiKey } : {})`（照抄旁边 `extraParams` 的保留写法）。副作用注意：若担心 GET 泄露明文 key，可另行做响应侧脱敏，但**必须**与保存侧解耦——只做脱敏不修 schema 仍会丢 key
- **上游对照**：未查

---

## 四、汇总表

| ID | 标题 | 严重度 | 证据等级 | 位置 |
|---|---|---|---|---|
| tc-001 | AA offline buffer drain 截断销毁并发 enqueue 的已持久化通知（5/5 确定性丢失） | S2 | E3a | `packages/zai/src/server/services/aaClient/offlineBuffer.ts:112` |
| tc-002 | `getTaskListStore()` 生产 fallback 无视 `ZAI_DATA_DIR`，任务清单永远落 `$HOME/.zai` | S3 | E3a | `packages/zn-agent-core/src/compat/taskListStore.ts:289` |
| tc-003 | Provider PUT schema strip 未声明字段，内联 `apiKey` 一次保存即静默丢失 | S3 | E3b | `packages/zai/src/server/routes/config.ts:28-51` |

**正式报告条目数**：`3`　**其中 E0 条数**：`0`

---

## 五、不确定与自我否定清单

| 线索 | 位置 | 为什么站不住 / 为什么没能证实 |
|---|---|---|
| `bun-protocol.mjs` 把 `env-paths`/`lru-cache`/`@orama/*` 重定向到 `dangling-shims/*.js`，但该目录只有 `.ts`（src）与 `.d.ts`（dist），重定向目标不存在（与同文件 `:43-53` 注释修过的 `bun-shim.js` ENOENT 同款） | `packages/zn-agent-core/src/compat/runtime/bun-protocol.mjs:56-62` | 不可触发（已自证方向但未走完全部搜索）：裸导入这四个 specifier 的 8 处全部位于 `opencc-src/`，生产一律经 bundle 内联/`__require`（CJS 解析直达 `packages/zn-agent-core/node_modules/lru-cache`，实际已安装），不经 loader；compat 被 bundle 吸收（`dist/compat` 仅 `.d.ts`）。潜在 S4/E1，价值低，未升级为正式条目 |
| SSE 合成事件 `synth-bgstate-*` 用 `getNextSeq()` 发 seq 但不推进 `seqCounter`，疑似与后续真实事件 seq 撞车污染客户端高水位 | `packages/zai/src/server/routes/event.ts:155-165` + `useAgentStore.ts:974-977` | 证伪：`lastSeqBySession` 只在 `upsertToolCall`/`upsertStreamBlock` 两个 reducer 更新，`applyAgentTaskChanged`（`useAgentStore.ts:2448`）无 seq 守卫且按 taskId 幂等 upsert；真实事件自身 seq 严格递增，守卫不受合成 seq 影响 |
| `bashTracker.unregisterForeground` 不清理 `persistedOutputPath` 落盘文件（对比 `evictFinished` 有 unlink） | `packages/zn-agent-core/src/compat/bashTracker.ts:125-130` | 未证伪也未证实触发面：需确认 foreground 自然结束路径是否可能已 set 持久化路径（大输出通常伴随转后台），且与后台任务 30min TTL 相比影响极小，时间不够放弃追击 |
| weixin `WeixinPendingStore`/`SyncBufStore`/`ContextTokenStore` 仍用固定 `${path}.tmp`（对比 `WeixinSessionMap.ts:293` 已修为 pid+seq） | `services/weixinBot/*` | 与已知 `settings-tmp-path-collision` 同族（「共同根因 1」），且写入频率/并发度未证实足以撞名，按同族风险处理不单独立项 |
| `GET /api/bash/repl/:sessionId/events` 对任意 sessionId 走 `reg.get` **创建** ReplSession 条目，疑似可被跨站 GET 无限撑大注册表 | `routes/bashRepl.ts:73-94` + `ReplRegistry.ts:15-25` | 未证实：ReplSession 构造极轻（无进程无文件），泄漏只有内存一个对象；且与已知 exec CSRF 条目同属「localhost 零鉴权」大前提，单独报会被判同根因 |
| `messageQueueAdapter` 的 inbox 消息 id 用 `${kind}-${Date.now()}`，同毫秒同源撞 id | `compat/inboxBridge.ts:39` | 证伪：`SessionInbox` 各 lane 无按 id 去重逻辑（followup/inject 直接 push），撞 id 无后果 |

---

## 六、给裁判的一句话

这个仓库的修复响应速度很快——已知 22 条里我核对到 `/api/event` 的 close-before-await、DELETE 会话的 `disposeSessionAgents`/`disposeSessionInbox`、approveRegistry 的 sessionId 过滤都已在源码落地（比已知文档的「未修复」状态新）——所以「已知清单」其实是**下界**而非全貌；真正的缺陷藏在更新的子系统（AA 桥、compat 工具层）和「注释声称的机制与代码不符」这类缝隙里，我的三条全部属于后者。
