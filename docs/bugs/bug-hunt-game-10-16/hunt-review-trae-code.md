# 评审报告 · trae-code(环节二)

**参赛者**:`trae-code`
**日期**:2026-10-16
**基准提交**:`6f9ceaeb`(`main`)
**评审对象**:`bug-hunt-claude-code.md`(6 条)、`bug-hunt-opencc.md`(3 条)、`bug-hunt-workbuddy.md`(12 条),共 21 条。

---

## 一、抽验记录(硬性 §5.3)

我亲手复验了 4 条(跨 3 位选手、跨严重度),全部真实执行、全部隔离(`ZAI_DATA_DIR`/dataDir 指向每轮新建的 `mkdtemp` 临时目录;唯一监听是 `listen(0)` 临时端口;920x 未触碰)。复现物:`/tmp/bughunt-trae-code/review-probes.mts`、`review-t4b.mts`、`review-t4c.mts`。

### 抽验 1:wb-005(jsonSchemaToZod)→ 与作者一致

做了什么:直接 import 真实 `compat/mcp/jsonSchemaToZod.ts`,对同一 schema 分别以「无 required」与「required: []」转换后 `safeParse({a:'x'})`。
看到什么:
```
[T1 wb-005] no-required ok=false {"code":"invalid_type","expected":"number","path":["b"],"message":"Required"}
[T1 wb-005] required:[]  ok=true
```
结论:与作者一致,CONFIRMED。两份语义等价的 schema 行为相反,作者的对照组设计有效。

### 抽验 2:cc-001(approveRegistry 错误 signal 摘 listener)→ 与作者一致,且获得一条作者没写的额外证据

做了什么:用真实 `ApproveRegistry` 重演「同 id、不同 signal 两次 register → abort 旧 signal」;对照组为单次 register + abort。我逐行读过三处源码确认逐字相同:`approveRegistry.ts:45-48`、`permissionRegistry.ts:43-46`、`askRegistry.ts:26-28`(三处的 `existing.onAbort` 都注册在**旧** signal 上,却从**新** `abortSignal` 上摘除)。
看到什么:
```
[T2 cc-001] orphan listeners on A = 1 | after A.abort: peek=undefined B settled=false
[T2 cc-001 CONTROL] single register + abort → rejected:aborted, listeners left=0
```
额外证据:我的探针第一版没给旧 Promise 挂 catch,**进程直接被 unhandled rejection 杀掉**(`approveRegistry.ts:51` 的 `reject(new Error('aborted'))` 由孤儿 listener 触发)——孤儿 listener 不仅删掉 B 的 entry,还会 reject A 的旧 Promise;若生产调用方没 catch 这个 Promise,即触发已知「async rejection 杀进程」家族的第二触发面。
结论:CONFIRMED,机制、后果、对照组全部成立。作者对触发性(S3 而非 S2)的自我克制是诚实的。

### 抽验 3:wb-002(createSseStream 无 EPIPE 防护 → 进程崩溃)→ **复验失败,见 REJECTED**

做了什么:构造最有利于作者的配置——真实 Express + SSE 路由(`res.write` 裸写、无 `res.on('error')`),客户端连上后 `sock.destroy()` 暴力断开,服务端继续每 30ms 写一次、持续 1 秒(≈33 次向已销毁 socket 的写入,对应「长命令输出期间刷新页面」),进程不挂任何 `uncaughtException` 兜底。
看到什么:
```
[T3 wb-002] after 1s of writes into destroyed socket: process ALIVE=true exitCode=null
```
结论:崩溃链未复现(运行时 Node v22.22.3,即 README §1 记录的产品运行时)。这与仓库内已有的实证记录互相印证——`docs/bugs/2026-10-05-sse-subscriber-and-session-leak.md:56-57` 明确记载「在已销毁的 socket 上写,Node 25 静默 no-op,不抛」,且该文档描述的**泄漏场景本身就是反证**:泄漏的心跳 interval 连续数小时向已死连接写入而进程始终存活。wb-002 的推理断点见下方裁决。

### 抽验 4:wb-001(sessionId 路径穿越)→ 与作者一致,落点逐级上移被我独立复现

做了什么:隔离 dataDir 下用真实 `legacyTranscriptStore.create()` 依次以 3/4/5 对 `../` 的 sessionId 创建会话,逐一找落点。
看到什么:
```
[T4c pairs=3] sid=sess-../../../RVESC-…  landed=<tmp>/…/wb001-home/projects/RVESC-….jsonl   (逃出 projects/<cwd>/)
[T4c pairs=4] sid=sess-../../../../RVESC-… landed=<tmp>/…/wb001-home/RVESC-….jsonl           (逃出 projects/)
[T4c pairs=5] sid=sess-../../../../../RVESC-… landed=<tmp>/…/RVESC-….jsonl                   (逃出 dataDir)
```
结论:与作者一致,CONFIRMED——每加一对 `../` 落点上移一层,5 对即逃出 dataDir,`create()` 侧只有 `sess-` 前缀补全(`legacyTranscriptStore.ts:240-242`)、无字符白名单;`filePathFor`(:94-96)`path.join` 后 `../` 生效。补一条我的观察:wb-001 还有一个**放大器**作者没提——`create()` 落盘走 `writeEntries`(:119-124),它**没有** `appendEntry`(:129)那条 `isSessionDeleted` 守卫,穿越写出去的文件不受「删会话」清理影响,更难回收。

---

## 二、逐条裁决

### claude-code

#### [cc-001] 三个 pending 注册表从错误 AbortSignal 摘 listener → 跨会话 abort 误杀 — **CONFIRMED**

- 核过的行:`approveRegistry.ts:45-48`(Round 1 已读,本次重读)、`permissionRegistry.ts:43-46`、`askRegistry.ts:26-29` —— 三处与作者描述逐字一致:`existing.onAbort` 挂在旧 signal,却 `abortSignal.removeEventListener`(新 signal)→ no-op,旧 listener 成为孤儿;旧 signal abort 时 `:48` 的 `this.pending.delete(toolUseId)` 删掉的是**新** entry,新 Promise 无出口。
- 抽验:已亲手复验(见抽验 2),含对照组。
- 严重度 S3 采纳。作者自证「单次工具调用不重复注册」(`toolHooks.ts` 三个 canUseTool 调用点互斥)、把触发性保留讲清楚,这是本报告里最规范的一条「不可触发自证」。

#### [cc-002] `__zaiBridgeCtx` 进程级全局并发串台 — **CONFIRMED**

- 核过的行:`createOpenccRuntime-impl.ts:1153-1157`(写全局)、`:1275-1277`(finally 栈式恢复)、`headlessPermissionBridge.ts:64-73`(读全局,**无 ALS 兜底**)、`:107-111`(用读到的 sessionId register)、`AskUserQuestionTool.ts:23-29`(`getCurrentSessionId() ?? bridge.sessionId`,ALS 优先)——不对称性属实,注释 `:16-17` 明说 ALS 是为「并发 session 不 cross-fire」而加,权限路径恰恰漏了这层。
- 证据评级 E3a 采纳:作者诚实声明消费端真实执行、生产端(写全局)是按 `:1154`/`:1276` 逐行转写。我核对两段源码,转写与代码一致。
- 严重度 S2 采纳(跨会话状态污染 + 静默降级为拒绝两种后果都成立;`messageQueueAdapter.ts:93` 的同款消费点让面更大)。

#### [cc-003] 切会话不复位 pendingAsk/pendingPermission — **CONFIRMED**

- 核过的行:`useAgentStore.ts:1334` 的 `set` 确实清了 `messages/textSegmentRev/sendSeq/lastSeqBySession/compacting` 而**没有** `pendingAsk/pendingPermission`;`AgentConversation.tsx:163-178` 确实是 `{pendingAsk && <QuestionCard …/>}` 无条件渲染、未传 sessionId。
- 证据评级 E3b 采纳(真实组件树 + DOM/按钮 disabled 断言;对照组「同样落在 B,但 pendingAsk 走入站帧被守卫丢弃」精确把缺陷定位在出站复位而非入站过滤)。

#### [cc-004] loadTranscript await 后无条件回写 — **CONFIRMED**

- 核过的行:`useAgentStore.ts:1613-1633` —— `await fetch`(:1616)后 `set({messages, sessionId, …})`(:1624-1633)无任何 stale 判断。我顺带查了作者没列的 `hydrateSessionState`(:1343-1396):它的写入全部**按 sid 分桶**(`cwdBySession[sid]` 等),晚到的快照只写自己的桶,不构成同款缺陷——作者的同族清单(useSubmitPrompt / submitAsk)没有漏掉这处。
- 证据评级 E3b 采纳;作者对自己第一版探针假绿的复盘(对照组暴露实验组没渲染)是 §4.7 对照组价值的正面示范。

#### [cc-005] killChildTree POSIX 只杀直接子进程 — **CONFIRMED**

- 核过的行:`killTree.ts:14-36` —— POSIX 分支 `:31-35` 确实只有 `child.kill(sig)`;`:8-12` 注释把杀树能力明确限定在 win32。`ReplSession.ts:148` 的 `spawn('sh', ['-c', …])` 使复合命令必产孙进程,形状与 win32 注释描述的一致。E3a 证据(孤儿探活 + 「sh exec 掉简单命令」的对照组)在 darwin 上成立。
- 严重度 S3 采纳(边界退化,无数据损失)。

#### [cc-006] historyBySid key 只增不减 — **CONFIRMED**

- 核过的行:`eventBus.ts:198`(声明)、`:220-228`(emit 写入,唯二 get/set)、`:270`(读)——全类无任何 delete/clear;DELETE 会话路由(`agent.ts:2228-2269`,Round 1 已通读)清了 7 处唯独没有它,`ServerEventBus` 也没有提供按 sid 删除的方法。对照组(单 sid 1000 条压回 256)证明 CAPACITY 只挡纵深,精确。
- 注:与 wb-003 同一条,见 wb-003 裁决。

### opencc

#### [oc-001] ZAI_DATA_DIR 隔离实例仍读写真实 `~/.zai/settings.json` — **CONFIRMED**

- 核过的行:`zaiSettingsStore.ts:35-37`(`zaiSettingsPath()` 硬编码 `join(homedir(), '.zai', 'settings.json')`,Round 1 已读,本次重读)、`:23`/:87-89(读写都走它)。同仓正例(`paths.ts:23`、`factorySettings.ts:87`、`desktopWallpaper.ts:38`)核对无误。
- E3b 采纳:隔离实例回吐的 `outputStyle=compact` 等**用户态值**(不可能是内置默认)+ 同实例 transcript/wallpaper 正确落 `/tmp` 的双对照,排除了「变量没传进去」与「读到的是默认值」两个替代解释。
- 严重度:采纳 S1,理由——写路径与读路径同一个函数,任何一次隔离实例内的 settings PUT 都会原子覆盖用户唯一的生产配置(不可恢复);且 `test/setup.isolation.ts:19-20` 给**全测试套件**设了 `ZAI_DATA_DIR` 却**不重定向 HOME**,`zaiSettingsPath()` 在 vitest 里解析到的就是真实用户文件,测试面持续暴露。一个需要记录的反向考量(不影响裁决):`zaiSettingsStore.ts:107-115` 的注释表明 root+supervisor 子进程**有意**共享机器级 settings.json——设计上有「共享」的成分,但 ZAI_DATA_DIR 隔离语境(测试/双实例)不在这份意图内,`zaiMigration.ts:172` 的跳过逻辑与落盘路径互相矛盾这一点作者论证成立。

#### [oc-002] 壁纸 SVG 无 nosniff/CSP — **CONFIRMED**

- 核过的行:`desktopWallpaper.ts:28`(SVG 在 MIME 白名单)、`:104-106`(只设 Content-Type + Cache-Control);对照 `fs.ts:1390-1396`(同威胁的 `/fs/raw` 有 nosniff + CSP sandbox,注释明说理由)。作者从 S1 自降到 S2(background-image 不执行 SVG 脚本,需直接导航)是诚实且技术正确的。
- E3b 采纳:同一份 SVG 字节走两条路由、只差响应头,是全场最干净的对照组之一;PNG 补充对照进一步证伪「所有壁纸都缺头」。

#### [oc-003] AA noticeStore 中断后永不回收 — **CONFIRMED(证据评级保留意见)**

- 核过的行:`noticeStore.ts:31-59`(无界 Map,删除入口只有 `resolveNotice` 与 test-only 的 `resetNoticesForTests`)、`reverseDispatch.ts:2023-2027`(`handleInterrupt` 只 forwardToChild,不触 root 侧任何状态)、`:2054`(`handleInteractionRespond` 才 resolve)。全仓调用点穷举与作者的 grep 一致。作者的 404 实测(`no_pending_review`)排除了误批准,自降 S3 正确。
- 保留意见:E3a 的复现物是「源码逐行复刻」而非真实 import 被测模块——严格按 §4.2「测试必须真实执行被测模块」这条打,该复现物达不到 E3a(该模块仅 59 行纯 Map 操作,直接 import 即可,复刻是不必要的妥协)。**结论本身不受影响**(我逐行读过真实模块,机制成立),但裁判给这条计证据分时可以按更保守的口径。修复方向(dropNoticesForSession + TTL 兜底)合理。

### workbuddy

#### [wb-001] sessionId 路径穿越写原语 — **CONFIRMED**

- 核过的行:`agent.ts:2117-2119`(接受任意非空 string)、`:2172`(透传 create)、`legacyTranscriptStore.ts:240-242`(仅补前缀)、`:94-96` + `:119-124`(join + mkdir + writeFile)。
- 抽验:已亲手复验(抽验 4),落点逐级上移、5 对 `../` 逃出 dataDir。
- S1 采纳:localhost 零鉴权 + 已知 `--lan` 前提下是远程可触发的越权写原语(创建/覆盖任意祖先目录 `.jsonl` + 经 REGISTRY 后续 prompt 追加 + DELETE 删除原语)。

#### [wb-002] createSseStream 无 EPIPE 防护 → 进程崩溃 — **REJECTED**

- 推理断点在**这一步**:"`res.write` 触发 `'error'` 事件,`ServerResponse` 上无监听器 → uncaughtException → 进程退出"。两层反证:
  1. 我的 E3 探针(抽验 3):33 次向已销毁 socket 的写入,进程存活(Node v22.22.3 产品运行时);
  2. 仓库内既有实证(10-05 已知文档)记录的正是同一形状——泄漏的心跳 interval 长期向已死连接写入,进程未死,且该文档明确实测「写入不抛、静默 no-op」。wb-002 引为「同款防护」依据的 `sse.ts:9-14` 注释(EPIPE 会抛),其前提恰在同一份已知文档里被实测推翻——**用一条已被本仓库实证否证的注释当对照,是这条的第二个断点**。
- `processGuards.ts:19-24` 我核过:「不注册 uncaughtException」属实,但前提(会有 uncaught error)不成立。
- 残留价值:`stream.ts:16-18` 与 `terminal.ts` 心跳确实缺 `sse.ts` 那套防御性写线(destroyed 检查 / EPIPE 标记),作为**健壮性改进建议**成立;但「一次刷新杀全进程」的 S1 不成立。

#### [wb-003] historyBySid 无界增长 — **DUPLICATE-OF: cc-006**

- 与 cc-006 同文件同行号(`eventBus.ts:198/222-227/270`)、同机制、同修复方案(加 forgetSession + DELETE 接线)。双方照常计分(§5.2)。证据同为 E3a,作者的对照(单 sid 300 条压到 256)与 cc 的(1000 条)等价。

#### [wb-004] starting 窗口 stop/restart 静默 no-op — **CONFIRMED**

- 核过的行:`instanceSupervisor.ts:507-517`(doStop 空 child + `starting` → `return snapshotOf(entry)`,不排队、不报错、不改状态)、`:609`(`restartInstance = await doStop(id); return doStart(id, opts)`)、`:373`(doStart 顶部守卫 `starting||running → return`)——三段连起来:starting 窗口内 restart = doStop 空转 + doStart 被守卫弹回,**整体 no-op 且返回 200**。机制完整,证据 E1(需秒级窗口实测)合理。
- KNOWN 判定:**不是**已知 `instance-supervisor-double-spawn` 的重报。已知条目描述的是「doStop 撤销 starting 态 → 守卫失效 → 双 spawn」(10-05 时的代码行为);现在的代码(`:510-514` 注释)正是为修那条而把「撤销」改成了「不碰状态」——wb-004 描述的是**修复本身引入的残留缺陷**(意图静默丢弃),机制与后果都不同。这与 cc 报告对已知条目状态滞后(within my Round-1 备注一致)的观察互相印证。

#### [wb-005] jsonSchemaToZod 缺 required 全必填 — **CONFIRMED**

- 核过的行:`jsonSchemaToZod.ts:27-34` —— `if (Array.isArray(s.required))` 无 else 分支,缺 required 时全部属性保持必填;`required: []` 时全部 optional 化。抽验 1 已亲手复验。S2(「API 返回错误结果」:MCP 工具对合法省参调用误拒)采纳。

#### [wb-006] task-command XML 属性注入 — **CONFIRMED**

- 核过的行:`taskFactoryBridge.ts:170-172`(只 `.replace(/</g,'＜')`,`title="${title}"` 双引号属性)、`superTasks.ts:392`(同型第二份)——`"` 闭合属性成立,换行未处理。防护意图(`superTasks.ts:328-329` 注释)与注入面错位的论证成立。S2(跨信任边界注入编排器会话)采纳;注入的消费方是 LLM 会话这一点让严重度有讨论空间,但「任务标题可携带指令」在任务工厂的输入源(工单/LLM 生成)下真实可达。

#### [wb-007] taskInbox 消息永不消费 / interrupt 即杀死 — **CONFIRMED**

- 核过的行:`DefaultBackgroundRuntime.ts:241-244`(`sendMessageToTask` 对非终态任务 push 入 taskInbox 并返回 ok)、`:542-551`(唯一消费点在 `runOne` 开头组装 prompt——只在任务启动时跑一次,running 期间送入的消息无人组装)、`subagentControl.ts:153-174`(send_message 直通、interrupt_agent → `bg.cancel` 终态)。「send 返回 ok 但消息滞留」与「interrupt 语义与工具描述相反」两条链都闭合。E1 采纳,证据密度符合(全部读写点已枚举)。

#### [wb-008] readEvents error 回调 throw → uncaughtException — **CONFIRMED**

- 核过的行:`JsonTaskStore.ts:187-190` —— `stream.on('error', (err) => { if (err.code === 'ENOENT') stream.destroy(); else throw err })`。EventEmitter 回调内 `throw` 沿 emit 栈上抛,stream 的 error 事件由异步 I/O 回调发出 → uncaughtException。与 `:180-185` 同步 open 分支的正确分类对比,作者的「只在异步回调里漏了」论证成立。S2 与已知根因 2(async rejection 家族)同档次但位置独立,不属已知条目。

#### [wb-009] ReplRuntime.abort 死路径 + eventQueues 泄漏 — **CONFIRMED**

- 核过的行:`agentRuntime.repl.ts:244-253`/`:260-269`(abort/interrupt 先 `sessions.get` 再**无条件** `enqueueEvent`)、`:156-187`(生产 query 直接 delegate openccRuntime 并 return,stub 仅 `:187+` 兜底)、`:404`(`sessions.set` 只在 getOrCreate 即 stub 路径)、`dequeueEvent` 全文件仅 `:217` 一处调用(stub 的 enqueue 内)——生产路径下 eventQueues(:96)只进不出,唯一清空在 `:281`(shutdown)。两条后果(死代码中断通道 + 每次 abort 泄漏一条事件)都成立。S2 采纳(偏 S3 也可辩护,作者取 S2 我不降)。

#### [wb-010] WebFetch 超时 fallback 绕过 SSRF 防护 — **CONFIRMED**

- 核过的行:`WebFetchTool/utils.ts:286`(axios 主路径 `lookup: ssrfGuardedLookup`)、`:296-310`(timeout 类错误 → 裸 `fetch(url, { signal, redirect:'manual', headers })`,无 lookup/dispatcher)。防护与 fallback 的组合确实是「在最需要它的时刻失效」;`:318` 的 redirectChecker 复查说明作者知道每跳都要查。S1 采纳(内网元数据回读链完整;触发条件由攻击者通过慢 DNS 可稳定制造)。唯一减损是需 agent fetch 攻击者控制的 URL,但这正是 WebFetch 的正常输入。

#### [wb-011] DELETE 不清 sessionQueues → 僵尸会话复活 — **PARTIAL**

- 核过的行:`agent.ts:2228-2269`(DELETE 清单确实不含 sessionQueues,Round 1 已读)、`:1052-1062`(runQueryLoop finally 无条件 `void runNextInQueue(sid)`)、`:1067-1071`(nextHttpPrompt 从 sessionQueues 取队首)——「被删会话的排队 prompt 会在 abort 后被拉起、完整跑一轮 LLM turn」这条链成立。
- **但作者的核心现象(transcript 重建、sidebar 复活)在基线被挡住**:DELETE → `store.remove` → `markSessionDeleted(id)`(`legacyTranscriptStore.ts:484`,先标记后 rm),此后 `appendEntry`(`:129`)与 vendor `sessionStorage.ts:1783-1785`(2026-10-05 为已知 #19 加的守卫,注释明说「守卫必须落在这里」)都会丢弃被删 sid 的写入。我逐个核过这三道守卫。所以实际残留是:**被删会话仍会执行一轮完整的 LLM 调用(烧 token、结果不落盘、队列被消费)**——真实的 S3 级资源浪费 + 静默执行,但不是「会话复活」。
- PARTIAL 的具体改写:严重度 S2→S3;现象「transcript 被重建、sidebar 重新出现」应改为「turn 照跑但写入全部被 isSessionDeleted 守卫丢弃,用户为已删会话静默买单一次 LLM 调用」。修复方向(DELETE 清 sessionQueues + runNextInQueue 删除守卫)仍然正确——`runNextInQueue` 的删除守卫正是已知 #19 文档末尾自己建议的「第二道防线」,至今未落地。

#### [wb-012] open-terminal 对目录开在父目录 — **CONFIRMED**

- 核过的行:`fs.ts:1497-1499`(`rel && !rel.endsWith('/')` 即取父目录,无 stat)、`FsContextMenu.tsx:213`(postFsCommand('open-terminal', path) 原样发送)、`:225`(组件持有 `kind` 依赖却未传给服务端)。前端 POSIX 相对路径不带尾斜杠 → 目录恒走父目录分支。S3/E1 采纳。

---

## 三、裁决汇总

| ID | 裁决 | 关键理由(落在源码) |
|---|---|---|
| cc-001 | CONFIRMED | 三处 registry 逐字同缺陷;亲手复验 + 探针额外发现孤儿 reject 可致 unhandledRejection |
| cc-002 | CONFIRMED | 全局写/恢复 + 无 ALS 读全部核到;与 AskUserQuestionTool 的不对称属实 |
| cc-003 | CONFIRMED | `:1334` 无 pendingAsk 复位;`:163` 无条件渲染 |
| cc-004 | CONFIRMED | `:1613-1633` 无 stale 守卫;hydrateSessionState 已查非同款 |
| cc-005 | CONFIRMED | killTree.ts:31-35 POSIX 单杀;ReplSession sh -c 形状吻合 |
| cc-006 | CONFIRMED | eventBus 无 delete;DELETE 路由不触它 |
| oc-001 | CONFIRMED | zaiSettingsPath 硬编码 homedir;E3b 双对照成立;S1 经 setup.isolation 论证后采纳 |
| oc-002 | CONFIRMED | SVG 白名单 + 缺两道头;与 fs.ts:1390-1396 同仓对照成立 |
| oc-003 | CONFIRMED | handleInterrupt 不触 root 侧;穷举成立。证据评级保留(复刻≠真实模块) |
| wb-001 | CONFIRMED | 亲手复验:落点随 `../` 逐级上移,5 对逃出 dataDir |
| wb-002 | **REJECTED** | 探针证伪崩溃链;仓库既有实证(泄漏 interval 存活)与注释前提被推翻互证 |
| wb-003 | DUPLICATE-OF: cc-006 | 同文件同行号同机制同修复 |
| wb-004 | CONFIRMED | :515 早退不动状态 + :609 串行 + :373 守卫 → restart no-op;与已知 double-spawn 是修复前后两个不同缺陷 |
| wb-005 | CONFIRMED | 亲手复验:no-required 拒 / required:[] 过 |
| wb-006 | CONFIRMED | 两处只转义 `<`,`"` 闭合属性成立 |
| wb-007 | CONFIRMED | 消费点仅在 runOne;interrupt→cancel 终态;全部读写点闭合 |
| wb-008 | CONFIRMED | error 回调 throw 沿 emit 栈上抛;与同步分支对比成立 |
| wb-009 | CONFIRMED | 生产 delegate 早退;sessions 恒 miss;dequeueEvent 仅 stub 调用 |
| wb-010 | CONFIRMED | :286 有 guard vs :306 裸 fetch;fallback 恰在超时场景触发 |
| wb-011 | **PARTIAL** | 队列车道成立但「复活」被 markSessionDeleted + 两道写守卫挡住;残留改为静默烧 token 的孤儿 turn(S3) |
| wb-012 | CONFIRMED | endsWith('/') 判定 + 前端 path 无尾斜杠 + kind 未传 |

**抽验条目**:4 条(wb-005 / cc-001 / wb-002 / wb-001),其中 3 条复验结论与作者一致,1 条(wb-002)复验推翻作者。

---

## 四、评审中额外发现(新缺陷)

### [tc-rv-001] bun-protocol loader 的 dangling-shim 重定向指向不存在的 `.js` 文件(与同文件已修过的 bun-shim ENOENT 同款,当前潜伏)

- **严重度**:S4(当前不可触发,见自证)
- **证据等级**:E1
- **位置**:`packages/zn-agent-core/src/compat/runtime/bun-protocol.mjs:56-62` —— `REDIRECTS` 把 `env-paths`/`lru-cache`/`@orama/orama`/`@orama/plugin-data-persistence` 重定向到 `resolve(DANGLING_SHIM, 'env-paths.js')` 等 `.js` 目标;实际目录 `src/compat/dangling-shims/` 只有 `.ts`(`env-paths.ts`/`lru-cache.ts`/`orama.ts`),`dist/compat/dangling-shims/` 只有 `.d.ts`——**重定向目标在 src 与 dist 都不存在**。
- **为什么是缺陷而不是风格**:同一文件 `:43-53` 的注释记载了完全同款的事故——`bun-shim.js` 硬编码后缀导致 `bunProtocol.test.mjs` 与 Node-direct 生产路径 ENOENT,修复方式是改指 `.ts`。这四个条目漏改,属于同一修复只做了一半。
- **不可触发自证**(按 §4.2):全仓对这四个 specifier 的裸导入共 8 处(`Grep 'from .(env-paths|lru-cache|@orama)'`),全部位于 `opencc-src/`——生产一律经 `dist/opencc-core.mjs` 单文件 bundle(bundle 内 `__require("lru-cache")` 走 CJS 解析,直达实际安装的 `packages/zn-agent-core/node_modules/lru-cache`,不过 loader);compat 全部被 bundle 吸收(`dist/compat/` 仅 `.d.ts`)。因此在当前打包形态下 loader 的这四条重定向不可达;任何未来把 vendor 文件改回「经 tsx 直载」的改动(如部分 un-bundle)会立刻撞上 ENOENT。
- **修复方案**:四条 REDIRECTS 的目标后缀 `.js` → `.ts`(与 `:54-55` 的 bun-shim 修复一致),或直接删除这四条已不可达的重定向并注释原因。

(除此之外未发现其他新问题;评审中实际看过但排除的候选:`hydrateSessionState` 的晚到快照——写入按 sid 分桶,不构成 cc-004 同款;`writeEntries` 无 `isSessionDeleted` 守卫——唯一生产调用方是 `create()`,重建属 create 语义本身,已并入抽验 4 作为 wb-001 的放大器备注。)

---

## 五、交叉洞察(非新缺陷)

### 洞察 1:wb-002 的实证否证同时补上了已知文档缺的最后一环

`docs/bugs/2026-10-05-sse-subscriber-and-session-leak.md:56-57` 断言「在已销毁的 socket 上写,Node 25 静默 no-op,不抛」,但它只用来解释「catch 不触发」;「是否会有 uncaught 'error' 事件杀进程」这条文档没有直接回答——而这恰是 wb-002 全部严重度的来源。我的探针(T3)在产品运行时上补了这一环:33 次向已销毁 socket 的写入,进程存活、无 uncaughtException。结论双向封口:**write-after-disconnect 既不抛也不崩**,wb-002 的 S1 不成立,同时已知文档的「静默 no-op」从推断升级为直接实测。顺带指出:`stream.ts:16-18` 的裸写线与 `sse.ts` 的防御写线并存,是「同一威胁两个车道只修一个」的又一例(与 wb-011 对已知 #19 的关系同构),hardening 建议保留,严重度归零。

### 洞察 2:cc-001 与 oc-003 在两个进程里生产同一种用户可见状态:「卡片还在,registry 条目没了」

oc-003 证明:AA 中断后 root 的 noticeStore 保留卡片,用户点击 → child 侧 registry 无该 id → 404 `no_pending_review`(作者实测)。cc-001 证明:重复 register 场景下旧 signal 的 abort 会删掉新 entry,而新会话的 QuestionCard/pending 卡片仍在前端挂着,`/api/agent/approve` 同样返回失配。两条独立路径(AA 层的中断不清 root 缓存;zai 层的孤儿 listener 误删)收敛到同一个用户感知——**对着一张点不动的卡片,没有任何错误反馈**。修复时值得共享同一个设计约束:「任何产生待答卡片的注册表,其失效路径(abort/interrupt/delete)必须与卡片供给侧同源清理」,否则修掉一条路径后另一条仍会复现同一症状。cc-001 的修复方案(`existing.reject('superseded')`)与 oc-003 的(`dropNoticesForSession`)各自只覆盖自己那半。

### 洞察 3:oc-001 的同类未隔离路径清单需要补第 9 处——compat 侧的 taskListStore fallback

oc-001 附了 8 处「漏 `ZAI_DATA_DIR`」清单供一次收口,但全部在 `packages/zai` 内。我在环节一证实的 tc-002 是**第 9 处,且在 zn-agent-core 侧**:`compat/taskListStore.ts:289` 的生产 fallback 是 `` `${process.env.HOME ?? '/tmp'}/.zai` ``(连 `ZAI_DATA_DIR` 都不看),且注释声称的 BackgroundRuntime 注入从未发生(全仓 grep 自证)。这补全了 oc-001 清单的盲区:隔离收口若只改 zai 包,TaskCreate/TaskUpdate/TaskList 工具与 `/v2-tasks` 路由仍会写真实 `$HOME/.zai/tasks/`。与 oc-001 的修复建议合并成同一份 `resolveZaiDir()` 改造清单才是完整收口。

---

## 六、给裁判的一句话

三份报告的行号引用我全部打开核过,21 条中 17 条 CONFIRMED、1 条 PARTIAL、1 条 REJECTED、1 条 DUPLICATE、1 条带证据保留意见的 CONFIRMED——质量整体远高于上一届;唯一被推翻的 wb-002 死于「用一条已被本仓库实测否证的注释当崩溃依据」,建议修复阶段把「注释不是防线」这条教训对 `sse.ts:9-14` 这类防御性注释也做一次回溯实测。
