# 交叉评审报告 · workbuddy

**评审者**：`workbuddy`
**日期**：2026-10-16
**评审对象**：`bug-hunt-claude-code.md` · `bug-hunt-opencc.md` · `bug-hunt-trae-code.md`（本人的 `bug-hunt-workbuddy.md` 按 §5.1「评审另外三位」不列入逐条裁决；claude-code#cc-006 与本人 wb-003 为同一条缺陷，在 cc-006 条目下标注 DUPLICATE）

---

## 一、评审原则自查

- [x] 我对**每一处**被引用的 `file:line` 都实际 `Read` 过（sed/Read 到位），确认行号所指内容与作者描述一致
- [x] 我的每条裁决都给出了**源码上的理由**
- [x] 我没有因为「这不可能」就 `REJECTED`（本轮没有 REJECTED 裁决）
- [x] 我完成了至少 3 条**亲手抽验**——实际做了 4 条（见第四节）
- [x] 「评审中额外发现」有 1 条新缺陷（第五节 5.1）
- [x] 「交叉洞察」有 2 条（第五节 5.2）
- [x] 本轮无 `KNOWN` 裁决；对疑似与已知 22 条同源的条目（cc-005、cc-001）我逐条核过已知文档的机制差异，理由见对应条目

---

## 二、逐条裁决

### `claude-code#cc-001` — 三个 pending 注册表重复 register 时从错误的 AbortSignal 摘 listener

- **裁决**：`CONFIRMED`
- **我核到的位置**：`permissionRegistry.ts:44-46`、`approveRegistry.ts:46-48`、`askRegistry.ts:26-28` —— 三处逐字相同：`abortSignal.removeEventListener('abort', existing.onAbort)`，其中 `abortSignal` 是**本次的新 signal**，而 `existing.onAbort` 注册在上一次的旧 signal 上。三处注释都自述「先把旧 listener 从 signal 上摘掉」——意图与实现错位，与作者描述一致。
- **理由**：机制在源码层面无歧义（对新 signal 摘旧 listener = no-op；旧 signal abort 时孤儿 listener 执行 `this.pending.delete(toolUseId)` 误删新 entry）。作者对触发性做了诚实的收窄（S3 而非 S2，未证明同 id 二次 register 在生产必现），我核对了其自证的搜索范围（canUseTool 调用点互斥），认可按 S3 计。与已知 `prompt-close-aborts-all-sessions` 不同根因：那条是 abortAll 无 sessionId 过滤（且该过滤**现已落地**，见交叉洞察 r4），本条是孤儿 listener 误删，两者可并存。
- **修正后的严重度**：不适用（维持 S3）

### `claude-code#cc-002` — `globalThis.__zaiBridgeCtx.sessionId` 并发 query 串台

- **裁决**：`CONFIRMED`
- **我核到的位置**：`createOpenccRuntime-impl.ts:1153-1157`（写入全局，注释自述 "restore on exit so a stale sessionId never leaks into a later query"）、`:1275-1277`（finally 栈式恢复）、`headlessPermissionBridge.ts:64-69`（读全局且无 ALS 兜底，守卫只查字段存在）、`compat/tools/opencc/AskUserQuestionTool.ts:23-29`（`resolveAskBridgeCtx` 明确 `getCurrentSessionId() ?? bridge.sessionId`，注释直接写明「全局指针不会 cross-fire」）。
- **理由**：四段源码拼出的不对称与作者论证完全一致——同一个缺陷（并发下全局 sessionId 串台）在 AskUserQuestion 消费者上用 ALS 修了、在权限桥消费者上没修。作者诚实声明「生产端（写全局的时序）是按源码逐行转写、消费端真实执行」——我核对后认可这仍构成 E3a（被测对象 `wrapHeadlessPermissionFn` + `PermissionRegistry` 未被 mock，转写的只是输入时序），且裁判可直接比对 `:1154`/`:1276` 验证转写保真度。修复方案的第三点（messageQueueAdapter 优先级相反）我在源码里也确认了方向差异存在。
- **补充**：见交叉洞察 r2——修复范围还漏了第二个全局 `__zaiCurrentSessionId` 的消费家族。
- **修正后的严重度**：不适用（维持 S2）

### `claude-code#cc-003` — 切会话不清 pendingAsk/pendingPermission

- **裁决**：`CONFIRMED`
- **我核到的位置**：`useAgentStore.ts:1334`（`setCurrentSession` 的 set 清了 messages/seq/compacting 等 9 个字段，**无 pendingAsk/pendingPermission**）、`:1413-1425`（createNewSession 同样漏）、`AgentConversation.tsx:163-178`（`{pendingAsk && <QuestionCard …/>}` 无条件渲染且不传 sessionId）、`AgentInputBox.tsx:282-283`（`sendBlocked = … || pendingAsk?.status === "pending"`）。
- **理由**：单槽状态 + 切换不复位 + 渲染无过滤 + 输入禁用读同一槽位，四环齐备。作者引 `applyPromptAsk` 的注释说明「单槽不带过滤会串台」是代码自认的设计意图，进一步排除「设计如此」。作者对照组设计（入站帧有 currentSid 守卫 vs 出站切换无复位）精确隔离了缺陷位置，我重跑其组件测试，输出与其报告一致（见抽验 4）。
- **修正后的严重度**：不适用（维持 S2）

### `claude-code#cc-004` — loadTranscript await 后无条件回写

- **裁决**：`CONFIRMED`
- **我核到的位置**：`useAgentStore.ts:1613-1633`——`await fetch` 之后 `set({ messages, sessionId, … })`，**无任何「我还是当前会话吗」检查**；`sessionId` 与 `messages` 同时被覆盖，与作者描述逐字一致。
- **理由**：竞态窗口真实存在（`Agent.tsx` 的 fire-and-forget 调用无序列化）；作者还正确指出了 naive 修复（`get().sessionId !== sessionId` 就 return）会破坏冷启动路径（`setCurrentSession` 先写目标值），这个副作用分析是对的。我重跑其组件测试，EXPERIMENT 以 `expected 'A' to be 'B'` 失败、CONTROL 通过，与报告声称的呈现方式完全一致（见抽验 4）。
- **修正后的严重度**：不适用（维持 S2）

### `claude-code#cc-005` — killChildTree 在 POSIX 只杀直接子进程

- **裁决**：`CONFIRMED`
- **我核到的位置**：`killTree.ts:14-36`——win32 分支 taskkill `/T /F` 递归杀树，POSIX 分支只有 `child.kill(opts.force ? 'SIGKILL' : 'SIGTERM')`；`ReplSession.ts:148` `spawn('sh', ['-c', command], { cwd, env })` **无 `detached: true`**，孙进程与 sh 同组，杀 sh 后孙进程被 init 收养。
- **理由**：`sh -c` 复合命令必然产生孙进程，`child.kill` 只达 sh——机制成立且作者在 macOS 实测（对照组单命令 `sh -c 'sleep 300'` 被 exec 无孙进程、杀得掉；实验组复合命令孙进程存活）。与已知 `repl-registry-child-process-leak` 不同根因：那条是「进程退出时 ReplRegistry 未接线」（dispose 缺失），本条是「接线后的 kill 语义不足」（杀不到位），修复互不替代。
- **修正后的严重度**：不适用（维持 S3）

### `claude-code#cc-006` — ServerEventBus.historyBySid 只增不减

- **裁决**：`DUPLICATE-OF: wb-003`
- **我核到的位置**：与本人 wb-003 完全同一处（`eventBus.ts:198/220-228`，全仓无 delete）。我在环节一独立发现并做了 E3a 复现（探针 `/tmp/bughunt-workbuddy/probe1.mts` T2），claude-code 的复现（5000 个 distinct sid）与我的（5 个 sid + 300 条单 sid 对照）结论一致、互补。
- **理由**：按 §5.2 双方照常计分。claude-code 版本补充了我没写的两点：被删会话内容仍可通过 `getHistoryAfterForSid` replay 出死会话内容、`sessionArchive` 归档的恰是 map 里留得最久的批次——这两点我认可，不改变裁决。

### `opencc#oc-001` — ZAI_DATA_DIR 隔离实例仍读写真实 `~/.zai/settings.json`

- **裁决**：`CONFIRMED`
- **我核到的位置**：`zaiSettingsStore.ts:35-37` `zaiSettingsPath() = join(homedir(), '.zai', 'settings.json')`——**不看 `process.env.ZAI_DATA_DIR`**；对照组正例 `desktopWallpaper.ts:39`、`instanceStore.ts:34` 确实都写了 `process.env.ZAI_DATA_DIR || …`。
- **理由**：我做了独立探针（见抽验 3）：`ZAI_DATA_DIR=/tmp/...` 下 `zaiSettingsPath()` 返回 `/Users/ethan/.zai/settings.json`。作者的 E3b（隔离实例 GET /api/agent/settings 与真实文件逐键比对 differing=0 + 同实例内 transcript/wallpaper 正确落 /tmp）是本场最强的端点证据之一；同类路径清单我 grep 复核属实（fileStore:13-14/119、mcpConfig:135/208、commands/fileStore:9、mainAgents:24、manifest:6、historyArchive:33）。发现隔离漏洞后停手改只读 + 自曝，符合铁律 10 的精神。**这条同时是本场比赛机制本身的高价值发现**（铁律 10 的隔离承诺对 settings 一族失效）。
- **修正后的严重度**：不适用（维持 S1）

### `opencc#oc-002` — 壁纸端点回吐带脚本 SVG 无 nosniff/CSP

- **裁决**：`CONFIRMED`
- **我核到的位置**：`desktopWallpaper.ts:29`（`'image/svg+xml': '.svg'` 在白名单）、`:104-106`（回吐只设 Content-Type + Cache-Control）、对照 `fs.ts:1391-1396`（同仓对同类威胁已有 nosniff + `CSP: sandbox`，注释明说「SVG 内嵌脚本会以应用 origin 执行」）。
- **理由**：同一 SVG 字节走两条路由、响应头不同的对照设计有强区分力；作者把 S1 自降到 S2 的理由（UI 用 background-image 消费不执行脚本、需直接导航）我认可——这是诚实的减损披露而非漏报。生产模式同源（`start.ts:116` static 挂同一 app）的论证使 S2 站得住。
- **修正后的严重度**：不适用（维持 S2）

### `opencc#oc-003` — AA 审批中断后 noticeStore 永不回收

- **裁决**：`CONFIRMED`
- **我核到的位置**：我自己 grep 复核：`resolveNotice` 全仓唯一调用点 `reverseDispatch.ts:2054`（handleInteractionRespond），`aaClient/` 下无任何 drop/abort/disconnect 清理路径；`noticeStore.ts:43` 是唯一的按条删除。
- **理由**：核心负向断言（「中断路径无人清理」）经我独立 grep 成立；作者还在真端点实测证伪了「误批准」（404 no_pending_review），据此把子 agent 初稿降档到 S3——定级诚实。**一处证据分级保留意见**：作者的复现脚本是「源码逐行复刻」而非真实执行 `noticeStore` 模块，严格按 §4.2 E3a 的「真实执行被测模块」口径，这条的机器证据应落在 E1（调用点穷举）+ E2（真端点 404）的组合，而非 E3a。机制与严重度均成立，但**计分时证据系数建议按 E1/E2 口径复核**。模块级 Map（§3.2 第 6 条警告的形态）作者用 `reset()` 显式复位，对照组设计合规。
- **修正后的严重度**：不适用（维持 S3）

### `trae-code#tc-001` — offline buffer drain 截断销毁并发 enqueue

- **裁决**：`CONFIRMED`
- **我核到的位置**：`offlineBuffer.ts:72-82`（enqueue = `appendFile`，无互斥）、`:93-112`（drain = `readFile` 快照 → send 循环 → `writeFile(path, '')` 整体截断）；`:98` 死变量 `remaining` 与 `:105-108` 注释「下一 tick 重读重发」与实际行为相反（截断后重读的是空文件）也逐一属实。
- **理由**：读快照与截断之间的窗口内 append 的条目既未发送也被抹掉——这是经典的 TOCTOU 丢失，作者的 5/5 确定性丢失复现 + 对照组（无并发 drain 时 5 条全在盘上）我重跑完全一致（见抽验 2）。`draining` 标志只拦 drain 重入、拦不住 enqueue，修复方案（互斥 + 按已发送前缀截断）方向正确。
- **修正后的严重度**：不适用（维持 S2）

### `trae-code#tc-002` — getTaskListStore 生产 fallback 无视 ZAI_DATA_DIR

- **裁决**：`CONFIRMED`
- **我核到的位置**：`taskListStore.ts:284-292`——fallback 是 `` `${process.env.HOME ?? '/tmp'}/.zai` ``，注释声称「延迟到 BackgroundRuntime 注入的同时注入」；我 grep `setTaskListStore(` 全仓（排除 test），**仅命中定义处** `taskListStore.ts:294` —— zai server 无任何生产注入点，与作者的「注入从未发生」断言一致。
- **理由**：与 oc-001 同族（数据目录隔离失效）但在 vendor compat 层、机制不同（oc-001 是 helper 丢 env，本条是承诺的注入不存在 + fallback 用 HOME 而非 ZAI_DATA_DIR）。S3 定级合理（文件仍可读写，只是落点错 + 隔离失效）。见交叉洞察 r3。
- **修正后的严重度**：不适用（维持 S3）

### `trae-code#tc-003` — Provider PUT schema strip 掉内联 apiKey

- **裁决**：`CONFIRMED`
- **我核到的位置**：`config.ts:28-51` `ProviderProfileSchema` 声明了 `apiKeyEnv`/`extraParams`/`capabilities`，**无 `apiKey`**；zod `z.object` 非 strict 默认剥离未声明键；`modelCaller.ts:262` `apiKey: profile.apiKey ?? envKey ?? fallbackKey`——内联 key 是解析顺位 #1。**schema 注释里自己写着 "Resolution order: inline apiKey → env[apiKeyEnv] → …"**——注释承认的字段被 schema 剥掉，这是最有力的内证。
- **理由**：GET 返回该字段、PUT 返回 200、落盘消失——静默丢失链完整，作者的 E3b（真实 Express 挂载真实路由 + 真实 fileStore 落盘断言）可信；前端 `Config.tsx` 保留 `extraParams` 却不保留 `apiKey` 的放大器我也在源码确认了形状。S3 合理（可手工恢复、影响面限于内联 key 用户）。
- **修正后的严重度**：不适用（维持 S3）

---

## 三、裁决统计

| 选手 | CONFIRMED | PARTIAL | REJECTED | NOT-ENOUGH-EVIDENCE | DUPLICATE | KNOWN | 合计 |
|---|---|---|---|---|---|---|---|
| claude-code | 5 | 0 | 0 | 0 | 1 (cc-006→wb-003) | 0 | 6 |
| opencc | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| workbuddy | — | — | — | — | — | — | （本人报告，不在评审范围） |
| trae-code | 3 | 0 | 0 | 0 | 0 | 0 | 3 |

（对 oc-003 我给 CONFIRMED 但附证据分级保留意见，见该条理由；不计入 PARTIAL。）

---

## 四、抽验记录（硬性，4 条）

### 抽验 1：`cc-001`（claude-code / S3）

- **我的动作**：先 Read 三个注册表 `:26-58` 确认源码；再直接重跑作者留在 `/tmp/bughunt-claude-code/cc-001-repro.mts`：
  ```
  packages/zai/node_modules/.bin/tsx /tmp/bughunt-claude-code/cc-001-repro.mts
  ```
- **我看到的**（真实输出）：
  ```
  CONTROL   PermissionRegistry  listeners pending/after = 1/0  answer=true  settled=true
  EXPERIMENT PermissionRegistry  orphan listeners on A = 1 (expected 0)
  EXPERIMENT PermissionRegistry  after A abort: B entry DELETED  answer=false  B hung=true
  （ApproveRegistry / AskRegistry 两组同型输出）
  ```
- **与作者结论是否一致**：一致——对照组正常收尾，实验组孤儿 listener 残留、A 的 abort 误删 B 的 pending entry 且 B 永久挂起，三个注册表全部复现。
- **最终裁决**：`CONFIRMED`

### 抽验 2：`tc-001`（trae-code / S2）

- **我的动作**：Read `offlineBuffer.ts:70-115` 确认 append/read/truncate 结构；重跑 `/tmp/bughunt-trae-code/repro-offline-race.mts`。
- **我看到的**（真实输出）：
  ```
  [experimental] drain=true  prefillSize=790 sizeAfterEnqueue=790 finalSize=0   victimSent=0 victimOnDisk=0 LOST=5
  [control]      drain=false prefillSize=790 sizeAfterEnqueue=790 finalSize=1180 victimSent=0 victimOnDisk=5 LOST=0
  RESULT: experimental LOST=5 (expect >0), control LOST=0 (expect 0)
  ```
- **与作者结论是否一致**：一致。对照组证明 enqueue 本身可靠，实验组 5 条并发 enqueue 被 drain 的整体截断静默销毁。
- **最终裁决**：`CONFIRMED`

### 抽验 3：`oc-001`（opencc / S1）——自制探针，不依赖作者脚本

- **我的动作**：写了独立探针 `/tmp/bughunt-workbuddy/rv-oc001.mts`（进程内设 `ZAI_DATA_DIR=/tmp/bughunt-workbuddy/rv-zai-home`，import 真实 `zaiSettingsStore.ts`，打印 `zaiSettingsPath()`）：
- **我看到的**（真实输出）：
  ```
  EXPERIMENT zaiSettingsPath() = /Users/ethan/.zai/settings.json
  CONTROL    instanceStore 风格 = /tmp/bughunt-workbuddy/rv-zai-home
  逃逸判定: zaiSettingsPath 在 ~/.zai 下 = true
  ```
- **与作者结论是否一致**：一致——`ZAI_DATA_DIR` 已设的情况下 `zaiSettingsPath()` 仍解析到真实 `~/.zai`。我没有对真实 settings 做任何写入（探针只调 path 函数，不读写文件）。
- **最终裁决**：`CONFIRMED`

### 抽验 4：`cc-003` + `cc-004`（claude-code / 均 S2，E3b 组件树证据）

- **我的动作**：重跑作者留的组件测试（单文件 include，未触碰仓库既有测试）：
  ```
  cd packages/zai && ./node_modules/.bin/vitest run --config /tmp/bughunt-claude-code/vitest.cc004.config.mts --reporter=verbose
  ```
- **我看到的**（真实输出）：
  ```
  × cc-005-transcript-race.test.tsx > EXPERIMENT: slow A response lands after B and yanks the UI back to A
    → expected 'A' to be 'B'
  ✓ cc-005-transcript-race.test.tsx > CONTROL: without the concurrent fetch, B stays selected …
  ✓ cc-004-session-switch.test.tsx > EXPERIMENT: switching A -> B still renders A's QuestionCard and keeps Send disabled
  ✓ cc-004-session-switch.test.tsx > CONTROL: an INBOUND ask frame for a foreign session IS filtered …
  # Test Files 1 failed | 1 passed (2)   Tests 1 failed | 3 passed (4)
  ```
- **与作者结论是否一致**：一致。cc-004 的「失败的那条正是缺陷本身」（EXPERIMENT 断言 sessionId 被拽回 A）与报告原话吻合；cc-003 的两组按设计通过（实验组证明卡片串台 + 发送禁用、对照组证明入站帧有过滤——精确定位缺陷在出站复位）。E3b 的「真实渲染组件树」性质经此确认。
- **最终裁决**：两条均 `CONFIRMED`

（合规自证：抽验 1/2/4 的脚本自带隔离或纯内存；抽验 3 探针用 `/tmp` 目录；全程未起服务、未占用端口、未触碰 `~/.zai/`。）

---

## 五、评审中额外发现（硬性）

### 5.1 新缺陷

### [wb-r1] sdkEventAdapter 的 turnIndex 防双增守卫在正常流式路径下恒为真（死代码），每 turn 双增——恰是注释警告要防的症状

- **严重度**：S3（UI 层 turn 分组错乱：wrapper 合成事件携带比预期高 1 的 turnIndex，前端 strict-greater 检测误判「新 turn」，在流式块与合成块之间产生空 turn 气泡；无数据损失）
- **证据等级**：E1（静态可证：三个锚点的源码均已亲读，协议时序保证 ≥1 条 delta 夹在中间；端到端「空气泡」需真实流式会话，未实测）
- **执行环境**：静态分析（不依赖运行时）；产品 Node-direct。
- **位置**：
  - `packages/zn-agent-core/src/compat/runtime/sdkEventAdapter.ts:159-161` —— stream_event 的 message_start 分支：`meta.turnIndex += 1` 并记录 `meta.lastStreamedMessageStartCounter = meta.eventCounter`
  - `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:1267-1273` —— **每条** SDKMessage 处理完后 `adapterMeta.eventCounter++`
  - `packages/zn-agent-core/src/compat/runtime/sdkEventAdapter.ts:270-272` —— 守卫 `if (meta.lastStreamedMessageStartCounter !== meta.eventCounter) { meta.turnIndex += 1 }`
- **为什么我确信**：守卫意图（`:262-269` 注释自述）是「stream_event 已为本 turn bump 过，wrapper 不要再 bump」，判定方法是计数器相等。但 message_start（stream_event）与终态 `assistant` wrapper 之间必然夹着若干 content_block_delta SDKMessage（SDK 协议决定），每条都使 `eventCounter++`，到达 wrapper 时两个值**永不相等** → 跳过分支是死代码 → 正常流式路径每 turn 双增。注释明说双增后果是 "create empty bubbles between streamed and synthesized blocks"。该守卫只在「message_start 后零条消息直接到 wrapper」的非流式回放（vendor playback）下才会正确跳过——而这恰是它不需要的场景。
- **为什么前四位没报**：trae-code 检查过同文件的相邻疑点（合成事件 seq 不推进计数器）但方向在前端 seq 水位，证伪后止步；我本人在环节一也把它列在自我否定清单（时间不够做端到端验证）。三个锚点分散在 compat 与 vendor 两个包，单独读任一个都看不出问题。

### 5.2 交叉洞察

### [wb-r2] cc-002 的修复清单漏了第二个进程级全局：`__zaiCurrentSessionId` 的消费家族有同款 cross-fire

- **针对**：`claude-code#cc-002`（作者 / S2）
- **作者的原论证**：根因是 `__zaiBridgeCtx.sessionId` 进程级全局在并发 query 下串台；修复方案列了三处（createOpenccRuntime-impl 改 ALS、headlessPermissionBridge 补 ALS 兜底、messageQueueAdapter 统一优先级）。
- **我补上的**：grep `__zaiCurrentSessionId`（另一个承载 sessionId 的进程级全局，zai 侧 `setCurrentSessionId` 每条 prompt 覆写）发现同款疾病的治疗不对称**不止一处**：`subagentControl.ts:73-94` 的注释**明确写着**「`__zaiCurrentSessionId` 是进程级单例……并发两个 session 时会读到别人的 sessionId」并因此改用 ALS——而 `SpawnAgentTool.ts:639`、`CliAgentTool.ts:639`（`readZaiCurrentSessionIdBridge`）、`subagentReport.ts:26` 仍然**只用全局**。后果：子 agent 任务完成后的 `<task-notification>` 按 `parentSessionId` 路由（`subagentNotifier.ts`），并发窗口下会投进错误的会话，或全局为空时被静默吞掉。
- **结论**：cc-002 成立，但其修复方案**不完整**——只把 `__zaiBridgeCtx` 迁到 ALS，`__zaiCurrentSessionId` 家族（SpawnAgent/CliAgent/subagentReport 三个消费者）的 cross-fire 原样保留。修「一个全局」不等于修「这一类全局」。

### [wb-r3] oc-001 的同类路径清单缺了整个 compat/vendor 象限——tc-002 就是漏网的那一条

- **针对**：`opencc#oc-001`（作者 / S1）
- **作者的原论证**：oc-001 给出 8 处「同类未隔离路径清单」（全部在 `packages/zai/src/`），建议一次性收口。
- **我补上的**：我用 oc-001 同款 grep 模式（`join(homedir(), '.zai'`）扫 `packages/zn-agent-core/src/` **零命中**——不是因为没有问题，而是 compat 层用了**另一种写法** `` `${process.env.HOME ?? '/tmp'}/.zai` ``（`taskListStore.ts:289`），模板字符串 + HOME 绕开了 `join(homedir()` 这个 grep 特征。这正是 trae-code#tc-002。按同样的「模式变体」思路还应检查 compat 内其他 `${HOME}`/`~` 展开点。
- **结论**：oc-001 的清单对 `packages/zai` 象限完全准确（我逐条核过），但「一次收口」的修复建议若只按它的 grep 执行，会漏掉 compat 层的同族缺陷。两个 grep（`join(homedir(), '.zai'` + `HOME ?? '/tmp'}/.zai` + `/\.zai` 模板串）应一起跑。

### [wb-r4] 已知 22 条清单部分已过时：`abortAll` 的 sessionId 过滤已落地，修复状态「未修」记载与源码不符

- **针对**：`docs/bugs/` 基线清单的整体口径（影响 oc-001 文中「已修复的 bug 不报」的判断、以及环节三对 KNOWN 的认定）
- **作者的原论证**：opencc 在排查范围里写「prompt-close-aborts-all-sessions 已知，且源码里 sessionId 过滤已经加上了」；trae-code 在结语里独立观察到「已知清单其实是下界」。
- **我补上的**：我亲自核了三个 registry 的 `abortAll`：`askRegistry.ts:84-90`（`if (sessionId !== undefined && p.sessionId !== sessionId) continue`）、`approveRegistry.ts:111`、`permissionRegistry.ts:102`——**过滤确实已实现**，注释还写明了收窄意图。同时 `useAgentStore.ts:1334` 的 `setCurrentSession` 已带 2026-10-12 的 compacting 复位补丁、DELETE 会话已先 `abortSessionController`——已知文档描述的若干「未修」现状已被后续提交部分修复。
- **结论**：环节三做 KNOWN 认定与修复验证时，应以**当前源码**为准而非 `docs/bugs/` 文档描述；反之，这也不减轻本文其余条目的有效性（我核过的 12 条全部在当前源码成立）。

---

## 六、我给评审过程的一句话

三份报告我没有找到一条可以 REJECTED 的——三家都把证据做到了自己声称的等级，claude-code 的对照组设计与 opencc 的「发现隔离漏洞即停手自曝」是本场质量最高的两个动作；我唯一的实质性保留意见是 oc-003 的复现物是源码复刻而非真实模块执行（建议裁判按 E1/E2 口径计其证据系数），以及三家共同的盲区都在「第二个全局 / 第二种 grep 模式 / 第二条 SDK 消息」这类「只差一个变体」的缝隙里（r2/r3/r1 分别是一例）。
