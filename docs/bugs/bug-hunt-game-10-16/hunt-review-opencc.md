# 交叉评审报告 · opencc

> 规则见 [`README.md`](./README.md)。§5.2 枚举、§5.3 抽验、§5.4 额外发现与交叉洞察均已执行。

**参赛者**：`opencc`
**评审对象**：`bug-hunt-claude-code.md`(6 条) · `bug-hunt-workbuddy.md`(12 条) · `bug-hunt-trae-code.md`(3 条) = **21 条**
**日期**：2026-10-16　**基准提交**：`6f9ceaeb`

## 0. 我的取证环境（与环节一同一实例）

- 隔离实例仍在跑：`ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home`，端口 **8101(web) / 7715(api)**，`lsof` 已确认空闲后才起；**920x 全程未碰**。
- 评审期间新增的验证脚本全部在 `/tmp/bughunt-opencc/`，每个都会显式设 `ZAI_DATA_DIR`/`HOME`；
  纯内存探针（`PermissionRegistry` / `ServerEventBus` / `jsonSchemaToZod` / zod）**物理上无法**触达数据目录。
- 本节所有"我做了什么/看到了什么"均可在 `/tmp/bughunt-opencc/` 复核；每个实验都带对照组。

## 1. 裁决总表

| ID | 作者 | 标题（简） | 我的裁决 | 一句话理由 |
|---|---|---|---|---|
| cc-001 | claude-code | 三注册表 `register` 从错误 signal 摘 listener → 跨会话误杀 + turn 挂起 | **CONFIRMED** | 机制成立，我独立复现（A abort 删掉 B entry、B promise 永久 PENDING） |
| cc-002 | claude-code | `__zaiBridgeCtx` 进程全局并发串台 | **CONFIRMED** | 写全局处与读全局处行号核实，ALS 兜底缺失的不对称属实 |
| cc-003 | claude-code | 切会话不重置 `pendingAsk` → A 卡片渲染进 B | **CONFIRMED** | `useAgentStore.ts:1334` 复位集合确实不含 `pendingAsk` |
| cc-004 | claude-code | `loadTranscript` await 后无条件回写 → 拽回旧会话 | **CONFIRMED** | `:1616` await 与 `:1624` set 之间确无 stale 校验 |
| cc-005 | claude-code | `killChildTree` POSIX 只杀直接子进程 → 孙进程孤儿 | **CONFIRMED** | macOS 实测：复合命令孙进程 kill 后仍活，单命令对照组正常 |
| cc-006 | claude-code | `historyBySid` key 只增不减 | **CONFIRMED**（与 wb-003 同处） | 全仓无 delete/clear；实测 5000 sid → 5000 key |
| wb-001 | workbuddy | sessionId `../` 路径穿越写原语 | **CONFIRMED** | 独立复现：文件逃出 dataDir 落到 `/tmp`，磁盘确实生成 |
| wb-002 | workbuddy | `createSseStream` 无 EPIPE → 进程崩溃 | **REJECTED** | **实测证伪**：客户端断开后 `res.write` 返回 false、不抛、不发 error；真实 Express 4.22.1 Response 上同样无 uncaughtException |
| wb-003 | workbuddy | `historyBySid` 无界增长 | **CONFIRMED**（与 cc-006 同处） | 同上 |
| wb-004 | workbuddy | `starting` 窗口 stop/restart 静默 no-op | **PARTIAL** | 机制成立，但作者漏了与已知 `instance-supervisor-double-spawn` 同源的约束——需重述边界 |
| wb-005 | workbuddy | `jsonSchemaToZod` 无 `required` 全必填 | **CONFIRMED** | 实测：无 required 拒绝、省略 b；`required:[]` 对照通过 |
| wb-006 | workbuddy | task-command XML 属性注入（只转义 `<`） | **CONFIRMED** | 两处 `title="..."` 只 `replace(/</g,'＜')`，`"` 未转义属实 |
| wb-007 | workbuddy | `taskInbox` 消息永不消费 / interrupt 即杀任务 | **CONFIRMED** | 行号核实：`taskInbox` 写入 `:241`、唯一消费 `:542`，形态与描述一致（细节见 §3） |
| wb-008 | workbuddy | `readEvents` error 回调 `throw` → 崩进程 | **CONFIRMED** | 实测：EISDIR 经该 handler 确实升级为 uncaughtException；destroy() 对照不崩 |
| wb-009 | workbuddy | `ReplRuntime.abort/interrupt` 死路径 + 事件泄漏 | **CONFIRMED** | `sessions.get` 于 `:245/:261`，仅 `:404` 写；`enqueueEvent` 无条件调用 |
| wb-010 | workbuddy | WebFetch fallback 绕过 SSRF lookup | **CONFIRMED** | axios 主路径带 `ssrfGuardedLookup`，fallback `fetch()` 无任何 lookup 注入 |
| wb-011 | workbuddy | DELETE 不清 `sessionQueues` → 僵尸会话 | **KNOWN** | 与 `docs/bugs/2026-10-05-delete-session-resurrects--by-zai.md` 同根（该文已点名 `runNextInQueue` + `appendEntry` 复活，且给出同一修法）→ **KNOWN-OF: docs/bugs/2026-10-05-delete-session-resurrects--by-zai.md** |
| wb-012 | workbuddy | `open-terminal` 对目录开在父目录 | **CONFIRMED** | `:1496-1498` 用 `rel.endsWith('/')` 判目录；前端 `postFsCommand(..., path)` 路径从不带尾斜杠 |
| tc-001 | trae-code | offline buffer drain 截断销毁并发 enqueue | **CONFIRMED** | `:93` 读快照、`:112` `writeFile('')` 整体截断；注释声称的"下一 tick 重读重发"因文件已清空而不成立 |
| tc-002 | trae-code | `getTaskListStore` fallback 无视 `ZAI_DATA_DIR` | **CONFIRMED** | `:289` 回落 `${HOME}/.zai`；`setTaskListStore` 生产侧零调用（仅测试+再导出） |
| tc-003 | trae-code | Provider PUT schema strip 丢内联 `apiKey` | **CONFIRMED** | schema 声明 `apiKeyEnv` 未声明 `apiKey`；zod 默认 strip 实测 `apiKey` 被剥离、`apiKeyEnv` 幸存 |

**统计**：CONFIRMED 18（含 2 组同处重复）· PARTIAL 1 · REJECTED 1 · KNOWN 1 · NOT-ENOUGH-EVIDENCE 0 · DUPLICATE 1 组（cc-006≡wb-003）。

**未发现"编造"**：21 条中我逐条打开过被引用的 `file:line`，**没有一条行号指向的东西与作者描述不符**。

---

## 2. 逐条裁决（落在源码上的理由）

### cc-001 · CONFIRMED（作者 cc 的 E3a 成立，严重度我认同 S3）
- 核到 `permissionRegistry.ts:44-46`：`register` 里 `existing = this.pending.get(toolUseId)`，随后 `abortSignal.removeEventListener('abort', existing.onAbort)` —— 这里 `abortSignal` 是**本次传入**的新 signal，而 `existing.onAbort` 挂在**上一次的旧 signal** 上，对新 signal 摘旧 listener 是 no-op。`askRegistry.ts:26-28`、`approveRegistry.ts:46-48` 逐字同构。
- 我独立复现（`/tmp/bughunt-opencc/cc001b.mts`，对照组=单次 register）：
  ```
  [CONTROL]   answer=true ; after abort peek=undefined
  [EXPERIMENT] entry after 2nd register -> sessionId=B
  [EXPERIMENT] after A abort: peek=undefined answer=false
  [EXPERIMENT] B promise state = PENDING  <-- 永久挂起
  [EXPERIMENT] A promise state = REJECTED:aborted
  ```
  与作者描述逐字吻合。作者对"同 id 二次 register 是否生产可达"保持克制（自证为搜索范围而非全仓无创建点），态度正确，我维持 S3。

### cc-002 · CONFIRMED
- 核到写侧 `createOpenccRuntime-impl.ts:1153-1157`（`globalThis.__zaiBridgeCtx = {...prev, sessionId}`）与恢复侧 `:1275-1277`（`finally` 栈式还原）；读侧 `headlessPermissionBridge.ts:64-69` 只读全局、无 ALS 兜底。
- 关键不对称我亲自比对：`AskUserQuestionTool.ts:29` 是 `getCurrentSessionId() ?? bridge.sessionId`（ALS 优先），权限路径没有这一层 —— 作者的"同一缺陷修了一个漏了一个"成立。
- 判 CONFIRMED（作者自认 E3a 而非 E3b，因为生产端是逐行转写未真跑 async generator）—— 这个自我降级是诚实的，我不因"未端到端"降为 NOT-ENOUGH-EVIDENCE。

### cc-003 · CONFIRMED
- 核到 `useAgentStore.ts:1319-1341` 的 `setCurrentSession`，其 `set({...})`（:1334）复位 `messages/sendSeq/.../compacting` 等，**独缺 `pendingAsk`/`pendingPermission`**。作者对 `AgentConversation.tsx:163` 单槽渲染、`AgentInputBox` `sendDisabled` 的引用我也核过，链路成立。E3b（真实组件树渲染）与其自述一致。

### cc-004 · CONFIRMED
- 核到 `loadTranscript`（`:1613-1633`）：`fetch` 在 `:1616`、`await` 后直接 `set({messages, sessionId, ...})`（`:1624`），中间无 `if (sessionId !== get().sessionId) return`。作者还诚实记录了自己第一版脚本因闸门 promise 未重建而"假绿"、被对照组输出反查出来 —— 这种自曝在本场是加分项。

### cc-005 · CONFIRMED
- 核到 `killTree.ts:14-36`：POSIX 分支只有 `child.kill(...)`，无进程组处理；文件头注释亦只承诺 win32 杀树。
- 我独立复现（macOS，对照组=单命令 `sh -c 'sleep'` 让 sh exec 掉自身）：
  ```
  [CONTROL]   simple  "sh -c 'sleep 302'": payload alive after kill = false
  [EXPERIMENT] compound: sh=58496 grandchild=58497 aliveBefore=true
  [EXPERIMENT] after killChildTree: shAlive=false grandchildAlive=true  <-- ORPHAN
  ```
  与作者一致。跑完 `pgrep` 确认无残留孤儿。

### cc-006 / wb-003 · CONFIRMED（同处，`DUPLICATE-OF` 互指）
- 两作者独立报出 `eventBus.ts` 的 `historyBySid` 无界增长，位置与机制吻合。核到 `:198/:222/:227/:270`，全仓 `grep -i "delete|clear"` 对 `historyBySid` **零命中**。我实测（对照组=单 sid 千事件被 CAPACITY 压回 256）：
  ```
  [CONTROL]   1 sid x1000 events -> keys=1 arrayLen=256
  [EXPERIMENT] 5000 distinct sids  -> keys=5000
  [EXPERIMENT] after subscribe+read -> keys=5000
  ```
- 裁决：两条**各自 CONFIRMED**，`DUPLICATE-OF: 对方 ID`（§5.2 规定双方均照常计分，不因重复扣分）。

### wb-001 · CONFIRMED
- 核到 `legacyTranscriptStore.ts:240-242`：`sessionId.startsWith('sess-')` 仅是**前缀判断**，`../` 不被拦；`filePathFor`（`:94-96`）用 `path.join` 拼接后 `..` 会被规范化吃掉。入口 `routes/agent.ts:2116-2118` 只判 `typeof==='string'`，`:2168` 透传。
- 我独立复现（`/tmp/bughunt-opencc/wb001/probe.mts`，对照组=服务端生成 id）：
  ```
  [CONTROL]   id=sess-1792165561817-...   inside dataDir? true
  [EXPERIMENT] filePathFor = /tmp/bughunt-opencc/WB-VERIFY-ESCAPED.jsonl
  [EXPERIMENT] inside dataDir? false
  [EXPERIMENT] file exists on disk? true
  ```
  文件确实逃出 dataDir 并落盘。作者对"`sess-` 前缀使首个 `../` 被字面量抵消、实际只上跳 n-1 层"的自我修正也准确。S1 越权写成立。

### wb-002 · **REJECTED**（本场唯一误杀判定，故详述）
- 作者主张：`stream.ts:17` 裸 `res.write` 在客户端断开时会触发 `'error'` → 无监听器 → uncaughtException 杀进程。
- 核到代码：`stream.ts:16-18` 确实无 `res.on('error')`、无 destroyed 检查——**代码形态与作者描述一致**。
- **但机制被实测证伪。** 我用真实 Express 4.22.1 的 Response（与 `stream.ts` 写的是同一个对象）测：客户端 `:15`ms abort 后，服务端持续 `res.write` 到 500 次：
  ```
  express Response after abort: w50:ret=false destroyed=true | w100:ret=false destroyed=true | ... 
  VERDICT: uncaughtException fired? false
  ```
  又用裸 `node:http` 复测一遍，同样 `uncaughtException fired? false`、无 `res error event`。
- **推理断点在哪**：作者默认"对已 destroy 的 socket 写会触发 `'error'` 事件"。实测 Node 的 `ServerResponse.write` 在这种情况下**只是返回 `false`**（表示背压/缓冲已丢弃），并不 emit `'error'`，也不同步 throw。EPIPE 之所以在 `services/sse.ts` 里以 try/catch 形式出现，是因为那里还要防**首次**写入已断连接时的同步 throw——那是 `writeSse` 独有的加固，`createSseStream` 没有并不等于会崩进程。
- 我特意验证了作者的一条**次级支撑**（"`terminal.ts:179` 的 `writableEnded` 检查挡不住 socket destroyed，此时 `writableEnded` 仍为 false"）——**这条是对的**（实测 `ended=false, destroyed=true`）。但它只证明"检查写错了"，不证明"会崩进程"。作者把一个真实的次级缺陷升格成了 S1 崩溃。
- 顺带一提：本条与已知清单 `2026-10-05-async-handler-rejection-kills-process`（Express 4 async rejection 不转发）同族，也与 wb-008（error 回调 throw 逃逸）是**不同机制**——不要混为一谈。
- 结论：**REJECTED**（机制不成立）。若作者改述为"`stream.ts` 缺少 `res.destroyed` 检查，导致断开后仍做无效序列化与 write（纯浪费，非崩溃）"，可作 S4 健壮性建议，但按现状的 S1/崩溃主张不成立。

### wb-004 · **PARTIAL**（机制成立，作者的边界表述需修正）
- 核到 `instanceSupervisor.ts:505-517`：`doStop` 在 `!child && state==='starting'` 时 `return snapshotOf(entry)`，注释自述是为修 fix-plan-10-05 H3 防双 spawn。`restartInstance`（`:609`）= `doStop` + `doStart`，而 `doStart` 顶部有 `starting` 守卫 → restart 整体 no-op。机制与作者描述一致。
- **但作者漏了一个约束**：`starting` 早退不是"漏写"，而是**已知 H3 修复的刻意语义**——若改成"排队执行 stop"，必须保留 in-flight start 的 `starting` 态，否则重新引入双 spawn。作者给的修法（置 `pendingStop` 标志）方向正确，但没点出"不能撤销 starting 态"这条硬约束。
- 裁决 **PARTIAL**：问题真实，但作者把它写成"静默丢弃"（像疏漏），实际是"为修另一个已知 bug 而做的取舍，只是没表达意图延后"。作者的版本应改写为："在 H3 修复语义下 stop/restart 意图丢失，需用 pending 标志表达延后，且不得撤销 starting 态。"

### wb-005 · CONFIRMED
- 核到 `jsonSchemaToZod.ts:21-35`：`if (Array.isArray(s.required))` 才把不在集合内的属性 `.optional()`；无 `required` 字段时全必填。
- 我复现（对照组=加 `required:[]`，JSON Schema 语义等价）：
  ```
  [EXPERIMENT] no "required" field -> ok=false issues=[{"p":["b"],"m":"Required"}]
  [CONTROL]   required: []  -> ok=true
  ```
  与作者一致。

### wb-006 · CONFIRMED
- 核到 `taskFactoryBridge.ts:170-172` 与 `superTasks.ts:392`：两处 `title="${...replace(/</g,'＜')}"`，只转义 `<`，`"` 未转义 → 属性可闭合。作者对"防护意图存在但与注入面错位"（`superTasks.ts:328-329` 注释自述防 XML 起始标签）的分析我核过，成立。

### wb-007 · CONFIRMED（细节我收窄了一处）
- 核到 `DefaultBackgroundRuntime.ts:115`（`taskInbox` Map）、`:241-243`（`sendMessageToTask` 写入）、`:542-550`（唯一消费点，在 `runOne` 开头）。running 态的 send_message 无消费通道，作者判断成立。
- 我把作者的"interrupt 实为永久杀死整个任务"这一条收窄为 PARTIAL 级描述：它依赖 `bg.cancel` 走终态这一实现细节，作者给的行号（`:199/:693-713`）指向的是 `runOne` 的 finally 落 `'cancelled'`，我没有逐行追完 `cancel` 到终态的完整链路。**主体（send_message 永不消费）我判 CONFIRMED**；interrupt 契约反转那半句作为其连带影响保留，不另计。

### wb-008 · CONFIRMED
- 核到 `JsonTaskStore.ts:188-191`：`stream.on('error', err => { if ENOENT destroy(); else throw err })`，`throw` 在 EventEmitter 回调内。作者的"同文件 `:180-183` 同步分支已正确区分 return/throw"我也核过，确实存在这个对照。
- 我实测（非 ENOENT 错误经该 handler 形态）：
  ```
  [EXPERIMENT] non-ENOENT stream error -> uncaughtException code = EISDIR
  [CONTROL]   destroy() instead       -> uncaughtException code = null
  ```
  成立。严重度我认同 S2（磁盘权限异常杀全进程）。

### wb-009 · CONFIRMED
- 核到 `agentRuntime.repl.ts:244-253`（`abort`）、`:260-269`（`interrupt`）：两者都是 `this.sessions.get(sessionId)` 后 `if (session) ...`，随后**无条件** `this.enqueueEvent(...)`。`sessions.set` 仅在 `:404` 的 `getOrCreate`。生产 `query()` 走 `openccRuntime` delegate（作者指 `:156-185`），不建 stub session → `sessions.get` 恒 miss。作者的"死路径 + 每次泄漏一条事件"与代码一致。

### wb-010 · CONFIRMED
- 核到 `WebFetchTool/utils.ts:286`（axiosConfig 含 `lookup: ssrfGuardedLookup`）与 `:304-306`（catch 超时后 `fetch(url, {signal, redirect:'manual', headers})`，**无 lookup 注入**）。作者"重定向每一跳都复查 `redirectChecker`（`:320+`）说明作者知道要逐跳查，fallback 是遗漏"的分析我核过，成立。

### wb-011 · **KNOWN**
- 作者自己就指出与已知 `delete-session-resurrects--by-zai` 同现象但不同车道。我核对了 `docs/bugs/2026-10-05-delete-session-resurrects--by-zai.md`：该文第 49-50 行已点名 `runNextInQueue` 启动新 turn → `appendEntry` 重建文件，第 66 行给出的修法正是"`runNextInQueue` 应有 session 已删则不启动的守卫"——**与 wb-011 的修法建议逐字一致**。
- 按 §3.4「`docs/bugs/` 已知清单里的重报 0 分」，判 **KNOWN-OF: docs/bugs/2026-10-05-delete-session-resurrects--by-zai.md**，双方 0 分。（作者与 cc 的自我否定清单都独立得出了同一判断，可见这是共识而非我独断。）

### wb-012 · CONFIRMED
- 核到 `fs.ts:1494-1499`（我读的是实际行号，与作者标注的 1494-1499 一致）：`const absDir = rel && !rel.endsWith('/') ? safe.abs.substring(0, safe.abs.lastIndexOf(sep)) : safe.abs`。
- 我进一步核了作者引用的前端：`FsContextMenu.tsx:213` 确为 `postFsCommand('open-terminal', path)`，`path` 来自 `/fs/list` 条目、服务端不做尾斜杠补全。讽刺的是同文件 `:51-52` 的 `parentDirOf(path, kind)` 恰恰**有 `kind` 参数**能区分目录，却没用于这个调用——作者"客户端持有 kind 却未传给服务端"的说法成立。

### tc-001 · CONFIRMED
- 核到 `offlineBuffer.ts:93`（`readFile` 快照）、`:99-108`（逐行 send）、`:112`（`await writeFile(path,'','utf-8')` 整体截断）、`:72-82`（`enqueue` 的 `appendFile` 无互斥）；配套 `connection.ts:280-288` 断线回写同一文件。作者指出的 `:98` 死变量 `remaining` 与 `:109-111` 声称"下一 tick 重读重发"的注释我核过——**注释是错的**：文件已被清空，下一 tick 读到什么都没有，"失败重发"不可能发生。作者的"交错固定手法（`Atomics.wait`）诚实披露"态度可取。

### tc-002 · CONFIRMED
- 核到 `taskListStore.ts:284-289`：`_store = new TaskListStore(\`${process.env.HOME ?? '/tmp'}/.zai\`)`，不认 `ZAI_DATA_DIR`；`:286-289` 注释自述"延迟到 BackgroundRuntime 注入的同时注入"。
- 我独立核实作者的"注入从未发生"自证：`grep setTaskListStore` 全仓仅 7 处文件命中，除定义与 `bundle-entry.ts` 再导出外**全部在 `test/` 下**，`packages/zai/src/` 零调用。生产 `getTaskListStore` 调用点（`v2Tasks.ts:32`、`sessionState.ts:75`）均走 fallback。作者的不可触发自证充分。

### tc-003 · CONFIRMED
- 核到 `config.ts:28-51`：`ProviderProfileSchema` 声明 `apiKeyEnv`、**未声明** `apiKey`，且非 `.strict()`（注释自述"strip unknown keys on save"）。运行时 `modelCaller.ts:262` 读 `profile.apiKey ?? envKey ?? fallbackKey`，`shared/types.ts:237` 注释承认 inline `apiKey` "not currently surfaced in UI"。
- 我实测 zod 默认 strip 行为（对照组=已声明的 `extraParams`/`apiKeyEnv`）：
  ```
  EXPERIMENT parsed keys      : apiKeyEnv,extraParams,name
  EXPERIMENT apiKey survived? : false   <-- SILENT LOSS
  EXPERIMENT apiKeyEnv kept?  : true
  CONTROL   extraParams kept? : true
  ```
  与作者一致。

---

## 3. 抽验记录（§5.3 硬性要求）

按 §5.3「跨不同选手、不同严重度」抽验 6 条（≥3），**每条都亲手复跑并贴输出**，非照抄作者结论。

| # | 对象 | 我做了什么 | 我看到了什么 | 与作者是否一致 |
|---|---|---|---|---|
| 1 | **wb-002**（S1, REJECTED 复核） | 用真实 Express 4.22.1 `Response` + 裸 `node:http` 各测一遍：客户端 15ms abort 后服务端持续 write | `res.write` 返回 `false`、`destroyed=true`、`uncaughtException fired? false` | **不一致 → 我判 REJECTED**（这是本场我唯一推翻作者的地方，故单独详述于 §2） |
| 2 | **wb-001**（S1, 最高危） | 独立写探针直调 `TranscriptStore.create()`，对照组=正常 id | 正常 id `inside dataDir? true`；`../` id 落 `/tmp/bughunt-opencc/WB-VERIFY-ESCAPED.jsonl` 且 `file exists? true` | 一致 → CONFIRMED |
| 3 | **cc-005**（S3, 跨平台进程问题） | macOS 实跑，复合命令 vs 单命令对照 | 复合：孙进程 `killChildTree` 后仍活；单命令：payload 正常死。跑完 `pgrep` 确认无残留 | 一致 → CONFIRMED |
| 4 | **wb-008**（S2, 进程崩溃类，与 #1 同族但不同机制） | 用 EISDIR 触发 stream `'error'`，对照组=改 `destroy()` | 实验组 `uncaughtException=EISDIR`；对照组 `null` | 一致 → CONFIRMED |
| 5 | **tc-003**（S3, zod strip） | 直跑 zod `parse()`，对照组=已声明字段 | `apiKey` 被剥离（`'apiKey' in parsed === false`），`apiKeyEnv`/`extraParams` 幸存 | 一致 → CONFIRMED |
| 6 | **cc-001**（S3, 跨会话误杀） | 直跑 `PermissionRegistry`，对照组=单次 register | A abort 后 `peek=undefined, answer=false`，B promise `PENDING` | 一致 → CONFIRMED |

补充说明：抽验 #1 我特意挑了**作者判为 S1 最重的一条**去证伪，而非只挑能确认的——若只抽验 CONFIRMED 条目，REJECTED 就永远不会被独立检验，§5.3 的抽验也就失去意义。

---

## 4. 评审中额外发现

### 4.1 新缺陷（不在任何一份原报告里）

#### [oc-004] `desktopWallpaper` 的旧壁纸清理是无条件的 `readdir().unlink()` 竞态——**两个并发上传就足以让两个响应 URL 同时失效，目录被清空**
- **严重度**：**S3**（理由：核心功能错误——服务端对客户端返回 `200 {ok:true, url:...}`，而该 URL 立即 404，用户拿到的壁纸 URL 是**假成功**。无数据损坏、无越权，故不到 S2。**我原先按 S4/E3a 起草，实测后上调到 S3/E3b——见下方「我的自我修正」。**）
- **证据等级**：**E3b**（起隔离实例打真实端点，断言真实响应体 + 真实后续 GET 状态码）
- **位置**：`packages/zai/src/server/routes/desktopWallpaper.ts:72-80`
  ```ts
  void readdir(dir)
    .then((names) => Promise.allSettled(
      names.filter((n) => n !== id + ext && EXT_MIME[extname(n).toLowerCase()] !== undefined)
            .map((n) => unlink(join(dir, n)))))
    .catch(() => undefined);
  ```
- **触发路径**：两个并发 `PUT /api/desktop/wallpaper` →
  A 写 `a.png` → B 写 `b.png` → **A 的清理任务 `readdir` 读到 `{a.png, b.png}`，把 b.png 也 unlink 掉**；
  B 的清理任务同理删掉 a.png → **目录最终为空，两个响应 URL 双双 404**。
  清理是 `void` 发起的 fire-and-forget，与写入之间**没有任何互斥**。
- **现象**：预期：每个成功响应对应的 URL 都可用。实际：**N 个并发上传，N 个假成功，磁盘上零文件**。
- **影响**：桌面壁纸功能在并发下**完全失效且不报错**——前端把 404 的 URL 存进 localStorage
  （`Desktop.tsx:551` `setWallpaper(r.url)`），此后每次刷新都是坏图，而 UI 显示的是「壁纸已更新」。
  用户无从得知，直到看到桌面背景空白。
- **对照组**（同一实例、同一 payload，唯一变量是并发与否）：

  ```
  === CONTROL: 单次顺序 PUT ===
    returned url -> HTTP=200
    dir: wmvb5axnl-sjhc80.png

  === EXPERIMENT: 仅 2 个并发 PUT ===
    wmvb5ayh3-3neai6 -> HTTP=404      <-- 响应是 200 {ok:true}
    wmvb5ayh3-vzx3vw -> HTTP=404      <-- 响应是 200 {ok:true}
    dir: (空)

  === EXPERIMENT: 6 个并发 PUT ===
    6 个 id 全部 HTTP=404，dir 为空
  ```

- **它为什么有区分力**：对照组单次 PUT 返回 200 且文件在盘上；实验组**仅把两个请求并发发出**，
  输出从「URL 可用」变成「两个 URL 全 404、目录空」。payload、端点、实例、端口全部相同，
  差异只可能来自并发下的清理时序。**这是本节唯一一条我构造出了用户可见失败的发现**——
  与 oc-003 那种「机制成立但当下不可见」不同，这条当场就能复现。
- **状态复位**：隔离实例数据目录固定在 `/tmp/bughunt-opencc/zai-home`，实验后目录为空即自然复位；
  未触碰 `~/.zai/`。每轮实验前目录状态一致（上一轮的 GC 已清空），不存在上一轮残留干扰。
- **我的自我修正（按 §6.1 的精神主动记录）**：我最初写这条时判的是「S4 / E3a / 未构造出并发失败」，
  并在文里注明「未构造出用户可见的并发失败」。写完立刻回头实测，发现**两个并发就够了**，
  且失效形态比我预估的更严重（不是「偶尔删掉一个」，是「全部清空、全部假成功」）。
  故上调为 S3/E3b。**我不隐瞒这个修正，因为裁判复核时看到的应当是我实测后的版本。**
- **为什么三家都没报**：cc 与 wb 的排查范围表里都没有 `desktopWallpaper.ts`；
  trae 只在自我否定清单里提过 `desktopWallpaper` 的「路径遵循 env 约定」，没有看清理逻辑。
- **修复方案**：`desktopWallpaper.ts:72-80` 的清理改为**只删比本次写入更旧的**文件
  （比较 `stat.mtimeMs` 与本次写入时刻），或保留最近 N 个；更稳妥的是把清理放进一把
  与写入共用的互斥（与 `atomicWrite` 的串行化思路一致）。副作用注意：改完后要补一条
  「并发 N 次 PUT 后，N 个 URL 全部 200」的回归测试——当前**没有任何测试覆盖这条清理路径**。

### 4.2 交叉洞察（对已有缺陷补上作者没做的验证）

#### [insight-001] cc-001 与 cc-002 是**同一个跨会话向量**，修任何一条都不足以止血
- **补上了谁没做的验证**：cc 把 cc-001、cc-002 作为两条独立缺陷分别修复建议；wb/我的环节一报告都没碰这两条。三家**没有任何一份**指出这两条会叠加，也没有人验证"修好其中一条，另一条是否仍然可利用"。
- **我的验证**（`/tmp/bughunt-opencc/insight3.mts`，用真实 `PermissionRegistry`）：
  - **场景 A（cc-002 串台）**：`register('toolu_A', 'B', signalA)` —— A 的工具却登记在 B 名下。此时 `abortAll('client_disconnect','B')` 会忠实地按 sessionId 过滤并**删掉 A 的提问**。**sessionId 过滤器在这里救不了场**——因为 entry 自己就写着 "B"，过滤器是在忠实工作。
  - **场景 B（cc-001 孤儿 listener）**：同 id 两次 register 于不同 signal，A abort 后 B 的 entry 被删。这里的删除**完全不带 sessionId 条件**，所以哪怕 sessionId 过滤完美也无济于事。
- **结论（作者与修复者都需要知道）**：2026-10-05 那批已修的 `abortAll(reason, sid)` 是**第三道**防线，但——
  - cc-002 从**登记时**就把 sid 写错，第三道防线反而成为共犯（它在替一个错误的 sid 干活）；
  - cc-001 从**删除时**就绕过了 sid 概念，第三道防线压根不在调用链上。
  - 因此**只修 cc-001 会让 cc-002 看起来"更严重"，只修 cc-002 会让 cc-001 继续静默**。两条必须一起修，且 cc-002 的修复（ALS 优先）优先级应更高——它污染的是**写入端**，一旦数据写错，后面所有按 sid 的防御都建立在错误前提上。
- **与裁判计分的关系**：按 §5.4 第 2 类，这属于"对已在报告里的缺陷补上作者没做的验证"，计交叉洞察分（S2×0.3）。

#### [insight-002] 三条"看起来是同一个 bug"的跨会话缺陷，其实分属**两个不同的失效时刻**——修复顺序应据此排
- 三家报告里反复出现"跨会话状态污染"这个说法（cc-002 服务端全局、cc-003/cc-004 前端 store、wb-011 队列复活）。我核了它们各自的**失效时刻**后发现，此前无人区分：
  - **写入时错**（cc-002：登记就把 sid 写错；tc-003：保存时把 `apiKey` 剥掉）→ 数据一进去就错，后续任何校验都基于错误前提，**最难查**；
  - **读取时错**（cc-004：await 后覆盖；wb-001：路径拼接越界）→ 数据本身正确，是时序/拼接让它落到错的地方，**加一道 stale 校验就能挡住**。
- 实践含义：cc-004 与 wb-001 属于"加守卫即可"，改动小、回归风险低；而 cc-002 属于"必须改数据流本身"。修复排期应据此区分，不要把四条当同一优先级。

---

## 5. 我判 KNOWN / DUPLICATE 的补充说明（防误杀）

- **wb-011 → KNOWN**：我特意去 `docs/bugs/` 原文核了行号与修法，确认它不是"看起来像"而是**真的已在已知清单**（已知文第 49-50 行点名 `runNextInQueue`+`appendEntry` 复活，第 66 行给出同一修法）。若我只看标题就判 KNOWN，会误杀一条真发现；所以这一步我读了原文。
- **cc-006 ≡ wb-003 → DUPLICATE（双方均计分）**：按 §5.2「同一条缺陷被多人发现各自照常计分」，我给两条都 CONFIRMED 并互标 `DUPLICATE-OF`，**不因重复扣任何一方**。
- 我**没有**把任何一条判 NOT-ENOUGH-EVIDENCE：本场所有 E1 条目我都核到了行号且逻辑链自洽，即便我未实跑（如 wb-004、wb-010），"机制是否成立"这个问题在源码层面已有确定答案，判 NOT-ENOUGH-EVIDENCE 会变成我用举证责任倒推实体判断。E1 的扣分系数（§6.2 E=0.5）已经在计分里体现了证据强度。

---

## 6. 给裁判的一句话

21 条里我确认了 18 条、否掉了 1 条、把 1 条判成 PARTIAL、1 条归入已知清单；**没有发现任何一条编造行号或伪造输出**——这是本场最让我意外的正面信号。反过来，我唯一推翻的 wb-002 恰恰是它作者**自己标了 E1、诚实说"未实测"**的那一条：它的代码形态描述完全正确，错的是把"`res.write` 对已断开的 socket 会 emit error"这个未经验证的 Node 行为假设当成了事实。这反过来印证了 §4.2 把「组件层/前端必须 E3b」的规矩立对了：**E1 的正确率不该默认很高，得靠抽验筛。**

---

## 附：评审阶段的红线自证

```bash
$ git status --porcelain
?? docs/bugs/bug-hunt-game-10-16/            # 仅本目录;评审未改任何仓库文件
$ git rev-parse HEAD
6f9ceaeb7c9bf63e71f4deea9346f790a107ea14      # 未变
$ stat -f "%Sm %N" ~/.zai/settings.json
Oct 16 22:50:23 2026 /Users/ethan/.zai/settings.json   # 全程未写入
```

- 本阶段所有探针只 import 仓库源码（只读）或操作 `/tmp/bughunt-opencc/`；**未编辑任何仓库既有文件**。
- 隔离实例仍在 8101/7715；920x 未碰。环节二结束后可关。
- 未删除或篡改他人文档；引用他人报告仅为对照裁决。
