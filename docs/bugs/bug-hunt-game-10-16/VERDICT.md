# 裁定书 · bug-hunt-game-10-16

> **项目** `opencc-web` · **基线** `main` @ `6f9ceaeb` · **日期** 2026-10-16
> **裁判** Claude / zai(不参与环节一、二)
> **声明总数** 24 条 · **评审裁决** 72 条(24 × 3 位评审)

---

## 一、裁判自查

| # | 纪律 | 履行情况 |
|:-:|---|---|
| 1 | 每一条进入排名的 bug,必须**亲自打开 `file:line`** 核对 | 24 条终裁 + 5 条评审期新发现,均由我亲自读到源码。**争议最大的 wb-002 我自己重做了实验**(脚本在 `/tmp/judge-verify/`,见 §四·C 簇) |
| 2 | 文档写得详细 ≠ bug 真实 | 逐簇重推调用链,不接受转述 |
| 3 | 无法判定的标记 `UNVERIFIED`,不计分并公开 | **本场 UNVERIFIED 清单为空**(见 §九) |
| 4 | 我自己的复核脚本也必须有对照组且贴输出 | wb-002 的实验做了**两轮**:第一轮我在两臂都挂了 `res.on('error')`——那正是被指控缺的那层保护,属无效设计,已作废重做;第二轮按 §4.7 忠实复刻并附加固版对照组 |
| 5 | 行号引用自己再核一遍 | 选手行号抽查结果:**24 条共 60 余处引用,偏移 4 处**(cc-001 的 `approveRegistry` −1、`askRegistry` 少一行收尾;wb-004 `:609`→实际 `:611`;wb-008 `:180-183`→实际 `:181-186`;oc-003 `reverseDispatch:2022`→实际 `:2023`)。**均不影响结论,未触发 §6.2 行号扣分** |
| 6 | 错判可申辩 | 见 §八 |

---

## 二、终裁总表(24 条)

> 严重度是我终裁的严重度,不是作者自报。分数 = 严重度基数 × 证据系数(E3b/E3a=1.0,E2=0.8,E1=0.5)。

### claude-code(6 条 · 发掘分 **16.8** / 60)

| ID | 自报 | 终裁 | 分 | 结论摘要 |
|---|---|---|---:|---|
| cc-001 | S3/E3a | **S4/E2** | 0.8 | 机制真(摘错 signal),但跨会话误杀需两会话共用同一 `toolUseId`,不可达 |
| cc-002 | S2/E3a | **S2/E3a** | 6.0 | **本场最强**。行号零偏移;ALS 现场已有正确值却无人用 |
| cc-003 | S2/E3b | **S3/E3b** | 3.0 | 缺陷确凿,但触发带竞态(`isBusy` 锁住切会话,须先 Esc) |
| cc-004 | S2/E3b | **S3/E3b** | 3.0 | 真实的跨会话破坏,但**自愈**,不丢数据 |
| cc-005 | S3/E3a | **S3/E3a** | 3.0 | 缺陷真(真进程探测);但招牌例子在 macOS 不 fork |
| cc-006 | S3/E3a | **S4/E3a** | 1.0 | 真缺陷,危害夸大:5000 sid ≈ 10.8 MB 全进程堆 |

### opencc(3 条 · 发掘分 **17.5** / 60)

| ID | 自报 | 终裁 | 分 | 结论摘要 |
|---|---|---|---:|---|
| oc-001 | S1/E3b | **S1/E3b** | 10.0 | 哨兵实验:读、写双向绕过 `ZAI_DATA_DIR`;10 处行号零偏移 |
| oc-002 | S2/E3b | **S2/E3b** | 6.0 | 全服务唯一一处缺 `nosniff`/`CSP` 的地方;作者主动把 S1 压到 S2 |
| oc-003 | S3/E3a | **S3/E1** | 1.5 | 缺陷真,但复现物是逐字复刻(自建 `Map`,未 import 真模块)→ 按 §4.2 降 E1 |

### trae-code(3 条 · 发掘分 **12.0** / 60)

| ID | 自报 | 终裁 | 分 | 结论摘要 |
|---|---|---|---:|---|
| tc-001 | S2/E3a | **S2/E3a** | 6.0 | 8 处行号零偏移;「5/5 确定性丢失」**不成立**(8 次里 4 次全丢) |
| tc-002 | S3/E3a | **S3/E3a** | 3.0 | 结论与行号分毫不差,生产 bundle 可佐证;但**根因讲错** |
| tc-003 | S3/E3b | **S3/E3a** | 3.0 | 缺陷真;漏报「strip 是 `config.ts:52-57` 明写的刻意设计」 |

### workbuddy(12 条 · 发掘分 **39.6** / 60)

| ID | 自报 | 终裁 | 分 | 结论摘要 |
|---|---|---|---:|---|
| wb-001 | S1/E3a | **S1/E3a** | 10.0 | **本场唯一无争议保留的 S1**;实测 `'../'×20` 直达 `/`,是**无上界**穿越 |
| wb-002 | S1/E1 | **S4/E1** | 0.5 | **崩溃主张被证伪**;残留「缺 destroyed 检查」为惰性缺口 |
| wb-003 | S3/E3a | **S3/E3a** | 3.0 | 与 cc-006 同一处 → **DUPLICATE**,双方照常计分 |
| wb-004 | S2/E1 | **S2/E1** | 3.0 | 缺陷与 S2 均保留,但主触发路径被 HTTP 序列化闸挡住 |
| wb-005 | S2/E3a | **S2/E3a** | 6.0 | 对照组有效,机制确凿 |
| wb-006 | S2/E1 | **S3/E1** | 1.5 | 属性闭合成立,但**根本没有 XML 解析器,攻击者是自己** |
| wb-007 | S2/E1 | **S2/E1** | 3.0 | 两个子claim 均成立,穷举闭合 |
| wb-008 | S2/E1 | **S2/E2** | 4.8 | EISDIR 实测崩溃;证据等级**上调** |
| wb-009 | S2/E1 | **S3/E2** ↓ | 2.4 | 死路径成立,但功能今天靠 AbortController 正常(**证据等级经实测上调**) |
| wb-010 | S1/E1 | **S3/E1** | 1.5 | 缺陷真,但 `OPENCC_WEBTOOL_ENABLE` 从不设置 → **默认不在工具池** |
| wb-011 | S2/E2 | **S3/E2** | 2.4 | 车道区分正确,但复活已被 `isSessionDeleted` 双层守卫挡住 |
| wb-012 | S3/E1 | **S3/E1** | 1.5 | 结构上不可能带尾斜杠 → 恒走父目录分支 |

### 罚则

**虚报罚则 −3:全部未触发。** 理由与口径见 §七·3。

---

## 三、逐簇复核记录

### A 簇 · 跨会话状态污染(6 条)

这是本场密度最高的簇,也是**四家唯一交叉命中的区域**。

| 条目 | 终裁 | 决定性证据 |
|---|---|---|
| **cc-002** | CONFIRMED S2/E3a | `createOpenccRuntime-impl.ts:1153-1157` 把 `sessionId` 写进进程级全局,`:1275-1277` 的 `finally` 恢复;消费端 `headlessPermissionBridge.ts:64-69` **只读全局、无 ALS 兜底**。对照 `AskUserQuestionTool.ts:28` 的 `getCurrentSessionId() ?? bridge.sessionId` —— **同一个全局,一个消费者有兜底一个没有**。复核实测:ALS 在调用现场返回 `sess-AAA`(正确值就在手边),而进程全局同时是 `sess-BBB` |
| **cc-003** | CONFIRMED S3/E3b | `useAgentStore.ts:1334` 的 `setCurrentSession` 清了 8 个键,**独缺 `pendingAsk`**;渲染端 `AgentConversation.tsx:163` 零 sid 过滤。实测 A 的卡片渲染进 B、`sendBlocked=true`、`submitAsk` 仍打向 A |
| **cc-004** | CONFIRMED S3/E3b | `useAgentStore.ts:1624-1633` 在 `await` 之后用**函数参数** `sessionId` 覆写 `setCurrentSession` 已写入的值,窗口内无 stale 守卫。实测:URL `?sid=B` 与界面上的 A 会话分叉 |
| **cc-001** | PARTIAL S4/E2 | `permissionRegistry.ts:45` 用**本次**的 `abortSignal` 去摘**上次**注册的 `onAbort`,对不存在的 listener 摘除是 no-op。机制确凿,但**跨会话误杀要求两个不同会话持有同一个模型生成的 `toolUseId`**——不可达。降为 S4 的理由是它连注释想防的 listener 累积都不构成(同 signal 重复 register 反而是好的) |
| **wb-011** | PARTIAL S3/E2 | 与已知 #11 的**车道区分成立**(abort 车道 vs `finally` 队列车道),作者的自证是对的。但两条真正落盘的路径(`sessionFacade-impl.ts:278/291` 与 `sessionStorage.ts:1783`)**都已 arm `isSessionDeleted` 守卫** —— 那正是已知 #11 的修复。文件不会被重建,僵尸会话不复现,只剩一次无用 LLM 调用烧 token |
| **wb-001** | CONFIRMED S1/E3a | `agent.ts:2117` 对 `requestedSessionId` 只校验 `typeof === 'string' && length > 0`;`legacyTranscriptStore.ts:240` 只补 `sess-` 前缀;`:94` 的 `filePathFor` 用 `join` 无越界断言。实测 `'sess-' + '../'.repeat(20) + 'X'` 解析到 `/X.jsonl`(`EROFS` 证明已越过全部可及层) |

> **这一簇的裁决要点**:opencc 的 `insight-001` 与我在复核中独立得到的一致结论——2026-10-05 那批已修的 `abortAll(reason, sid)` 是**第三道**防线,但 cc-002 从**登记时**就把 sid 写错(过滤器成为共犯),cc-001 从**删除时**就绕过 sid 概念(过滤器不在调用链上)。**两条必须一起修,且 cc-002 优先级更高**——它污染写入端。

### B 簇 · 数据目录解析未收敛(2 条 · S1)

| 条目 | 终裁 | 决定性证据 |
|---|---|---|
| **oc-001** | CONFIRMED S1/E3b | `zaiSettingsStore.ts:35-37` 裸 `join(homedir(), '.zai', 'settings.json')`,对照 `paths.ts:23` 的 `ZAI_DIR = process.env.ZAI_DATA_DIR \|\| join(homedir(), '.zai')`。复核用**哨兵实验**(重定向 `HOME` 到临时目录并植入只存在于假 HOME 的值 `verbose/777/office`):`GET /api/agent/settings` 返回哨兵值而 `$ZAI_DATA_DIR` 下无任何 settings.json;`PUT` 同样落盘假 HOME |
| **tc-002** | CONFIRMED S3/E3a | `taskListStore.ts:289` 的生产 fallback 是 `` `${process.env.HOME ?? '/tmp'}/.zai` ``——**连 `ZAI_DATA_DIR` 都不看**。复核在生产产物 `dist/opencc-core.mjs` 里找到同一行(`` new CNe(`${process.env.HOME??"/tmp"}/.zai`) ``) |

> **两条判独立,不是重复**:不同文件、不同包、不同数据、不同消费者、不同修法。只共享「数据目录契约未统一」这一个治理项。
>
> **trae-code 与 workbuddy 在评审期各自独立发现了这处盲区**(洞察 3 / wb-r3):oc-001 的 grep 特征是 `join(homedir(), '.zai'`,而 compat 层用的是**模板字符串 + `HOME`**,绕开了这个特征。两份洞察内容重叠,按规则双方都计分。
>
> **裁定的额外发现**:复核在 `paths.ts:125`(`~/.zai/weixin/locks`)与 `zaiSettingsCache.ts:43`(tier-2 的 `~/.claude/settings.json`)又找到两处同类未隔离路径,与 opencc 自己列的 8 处清单合并后,**一次性收口的清单是 11 处,不是 8 处**。

### C 簇 · SSE 与写入路径(2 条)

| 条目 | 终裁 | 决定性证据 |
|---|---|---|
| **wb-002** | PARTIAL S4/E1 | **我亲自做的实验**(见 §四) |
| **oc-002** | CONFIRMED S2/E3b | `desktopWallpaper.ts:104-106` 只设 `Content-Type` + `Cache-Control` 后 `res.end(buf)`;对照 `fs.ts:1394-1395` 对**同一威胁**已加 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`。复核确认这两道头在整个 server **只有 fs.ts 一处**(无 helmet),故壁纸端点是全服务唯一同类缺口 |

### D 簇 · 注册表生命周期与事件历史(3 条)

| 条目 | 终裁 | 决定性证据 |
|---|---|---|
| **cc-006 ≡ wb-003** | 双 CONFIRMED,**DUPLICATE** | `eventBus.ts:198` 声明、`:222` get、`:227` set、`:270` 唯一读,全仓 grep `historyBySid` **仅这 4 处,无 `.delete`/`.clear`**;`agent.ts:2228-2269` 的 DELETE 清了 7 处独缺此 map。cc 报 `:222-227`、wb 报 `:198`,两份还都独立报出 `:198` 与 `:270`——同一文件、同一 Map、同一 emit 块 |
| **oc-003** | CONFIRMED S3/**E1** | `noticeStore.ts:43-45` 的 `resolveNotice` 全仓只有 1 处调用(`reverseDispatch.ts:2054`);`handleInterrupt`(`:2023-2026`)只 `forwardToChild`,root 侧零状态变更;无 TTL、无 abort 钩子、子进程退出也清不掉跨进程的 Map。**但证据降档**:作者的复现物 `notice-store.mjs:6` 是自建 `const byId = new Map()`,从未 import 真模块,脚本自注 "pure in-memory re-implementation"——按 §4.2「禁止把被测对象本身替换掉」只能算 E1 |

### E 簇 · 进程 / 任务运行时 / 工具层(11 条)

| 条目 | 终裁 | 决定性证据 |
|---|---|---|
| **wb-005** | CONFIRMED S2/E3a | `jsonSchemaToZod.ts:28` 是 `if (Array.isArray(s.required))` **且无 else 分支**。实测两份语义等价的 schema,仅差空 `required` 字段,输出相反 |
| **wb-004** | CONFIRMED S2/E1 | `instanceSupervisor.ts:514` 的 `if (state === 'starting') return snapshotOf(entry)` + `:611` 的 `restartInstance = doStop + doStart`,两步各自被同一守卫挡回,净效果 no-op;`instances.ts:261` 照常 `res.json({instance})` |
| **wb-006** | PARTIAL S3/E1 | `taskFactoryBridge.ts:171` 只转义 `<` 不转义 `"`,属性闭合成立。**但** `task-command` 只进调度器 LLM 的 prompt 文本、**无任何代码解析器**(`agent.queue.test.ts:770` 白纸黑字:"no parser for it yet"),且标题由用户本人输入 → 自我提示注入,非跨信任边界 |
| **wb-007** | CONFIRMED S2/E1 | `taskInbox` 全文件仅 4 处,唯一 delete 在 `runOne` 开头;而 `runOne` 只由 `scheduleNext` 从 queue 取**新 id** 调用 → 已 running 的任务永不消费 `send_message` |
| **wb-008** | CONFIRMED S2/**E2** | `JsonTaskStore.ts:188-191` 的 `throw err` 在 `stream.on('error')` 回调内沿 emit 栈逃逸;`processGuards.ts:19-20` **明确不注册** `uncaughtException`。复核实测构造 `events/boom.log` 为目录(EISDIR)→ 进程 exit=13 |
| **wb-009** | PARTIAL S3/E1 | 生产 `query` 走 `:156` delegate 后直接 return,永不 `getOrCreate`;`dequeueEvent` 唯一调用点 `:217` 在同一个 stub 块内。实测:生产路径 `sessions.size=0`,2 次 abort 后 `eventQueues` 长度 2 且类型全是 `runtime.aborted` |
| **wb-010** | PARTIAL S3/E1 | `utils.ts:286` 主路径带 `lookup: ssrfGuardedLookup`,`:304-306` 的 fallback 裸 `fetch` 确无 lookup——**但** `WebFetchTool.ts:117-120` 的 `isEnabled()` 要求 `OPENCC_WEBTOOL_ENABLE`,全仓仅 3 处提及,**zai 从不设置** → 默认不在工具池 |
| **wb-012** | CONFIRMED S3/E1 | `fs.ts:396` 的目录 `path` 由 `name` 拼成,**结构上不可能带尾斜杠**;前端持有 `kind` prop 却不传给服务端,服务端也不 stat → `rel.endsWith('/')` 恒 false |
| **cc-005** | PARTIAL S3/E3a | `killTree.ts:31-35` 的 `child.kill()` 只发给 `sh` 本身,无 `detached`、无进程组。复核用真实进程探测:单命令被 exec 掉无孙进程(对照组),带 `&` / 管道的复合命令留孤儿(实验组)。**但作者的招牌例子 `sh -c "cd api && npm run dev"` 在 macOS 不 fork** |
| **tc-001** | CONFIRMED S2/E3a | `offlineBuffer.ts:93` 读全文 → `:99-108` 发送 → `:112` `writeFile(path,'')` 整体截断,`enqueue` 不检查 `draining`。**`:109-111` 的注释声称「下次 tick 会重读并重新入队」,与 `:112` 的实际行为直接矛盾** |
| **tc-003** | CONFIRMED S3/E3a | `config.ts:237-244` 的 `safeParse` 默认 strip 未声明键后直接落盘;`modelCaller.ts:262` 的 `profile.apiKey` 运行时承重。**但 `config.ts:52-57` 明写「不 `.strict()`,故意 strip 未知键」** —— 这是策略未覆盖,不是意外 |

---

## 四、我推翻的:wb-002 的完整复核记录

这一条单独记录,因为它是本场**唯一被三位评审独立证伪、且我亲自重做实验后维持「核心主张不成立」**的条目。

**作者主张**:`stream.ts:16-18` 裸 `res.write` 无防护 → 客户端断连触发 unhandled `'error'` → `uncaughtException` → **整个 zai 进程崩溃**(S1)。

**作者自己的对照**是 `services/sse.ts:9-14` 有同款防护,其注释明写「避免 EPIPE 抛出后 unhandled 'error' 事件杀掉 zai 进程」。

**我的第一轮实验(作废)**:我在实验组与对照组都注册了 `res.on('error')`——而那正是被指控**缺失**的那层保护。这让实验无法证伪任何东西。按 §4.7 作废重做。

**第二轮实验(有效)**,在**产品运行时 Node v22.22.3** 上忠实复刻 `stream.ts`(刻意不注册 `res.on('error')`),FIN 与 RST 两种断法各一组,对照组为加固版:

```
arm=raw      mode=FIN | 断开后写入=619 返回false=619 同步throw=0 uncaught=NONE | 首次写入时状态={"destroyed":true,"writableEnded":false,"socketNull":false}
arm=hardened mode=FIN | 断开后写入=619 返回false=619 同步throw=0 uncaught=NONE | 同上
arm=raw      mode=RST | 断开后写入=625 返回false=625 同步throw=0 uncaught=NONE | 同上
arm=hardened mode=RST | 断开后写入=621 返回false=621 同步throw=0 uncaught=NONE | 同上
```

结论:**崩溃机制不成立**。两个臂的行为完全一致——这意味着 `sse.ts` 那道「防护」**在真实断开场景下一次都不会命中**,它与 `stream.ts` 的裸写在行为上零差异。

**为什么我不判 REJECTED(0 分)而判 PARTIAL S4(0.5 分)**:同一份实验证实了作者的一条**次级事实是错的、且方向对它不利**——`destroyed === true` 时 `writableEnded` 仍为 `false`,所以 `sse.ts:24` 那道守卫**结构上拦不住已销毁的 socket**。这说明「`stream.ts` 缺 destroyed 检查」这个代码缺口是真的,只是在本运行时下它不产生可观测后果。判 S4 是给它一个归档位置,不是承认崩溃。

**三条独立旁证**(全部在本仓库自己的文档里):

1. `docs/bugs/2026-10-05-sse-subscriber-and-session-leak.md:55-57` 明写:`services/sse.ts:9-12` 的注释担心 EPIPE 会让 `res.write` 抛错,**「实测不成立」**,并指出 `:150` 的 `catch { markClosed() }` 这道保险在真实断开场景下不会执行。
2. 同文件 `:59-63` 交叉引用 `repl-registry-child-process-leak.md:76-81`:当时排除 `bashRepl.ts:81` 裸 `res.write` 崩溃嫌疑,用的是**同一个实测结论**。
3. 那条已知缺陷本身描述的**泄漏场景就是天然反证**:心跳 interval 连续数小时向已死连接写入,而进程始终存活。

**一句话**:wb-002 是把一条**已被本仓库实测否证三次的注释**当成了当前行为的事实。

---

## 五、评审期新发现的裁定(5 条)

按 §6.2「以裁判复核为准」,这些的分数不因作者自报而给,均由我亲自核到源码。

| ID | 发现者 | 终裁 | 分 | 我核到的 |
|---|---|---|---:|---|
| **cc-r2** | claude-code | **S1/E1** | **5.0** | `zaiSettingsCache.ts:174-179`:`if (settings.permissions === undefined) { settings = {...settings, permissions: DEFAULT_PERMISSIONS }; await writeZaiSettings(settings) }`,注释 `:169-173` 白纸黑字写 "persist to **~/.zai/settings.json**"。与 oc-001 合并 = 隔离实例在 boot 期**自动写**用户真实配置。**触发条件我已核实**:本机 settings.json 已有 `permissions` 块(故今日不触发),但对**任何缺该块的用户,一启动即改写真实文件** |
| **cc-r1** | claude-code | **S3/E1** | **1.5** | `openccInit.ts:421-422` 确实是 `if (enabled) return; enabled = true` —— **先置闩后干活**;而 `:438-448` 的 bundle 预检会 `throw`,且全文件无任何复位手段。注释 `:393-395` 承诺的是「第一次**成功**之后才短路」,实现是「第一次**调用**之后就短路」,两句话只差一个词 |
| **oc-004** | opencc | **S3/E3b** | **1.5** | `desktopWallpaper.ts:72-80` 的清理是 `void readdir(dir)` fire-and-forget,把除本次外的所有壁纸 `unlink`,**与写入无互斥**。作者对照组有区分力(单次 PUT → 200 + 文件在盘;2 个并发 PUT → 两个 URL 全 404 + 目录空,而响应都是 `200 {ok:true}` 假成功) |
| **wb-r1** | workbuddy | **S3/E1** | **1.5** | `sdkEventAdapter.ts:159-160` 的 `meta.turnIndex += 1` 与 `:270` 的守卫 `if (meta.lastStreamedMessageStartCounter !== meta.eventCounter)`。守卫意图是避免双增,但 `eventCounter` 每条 SDKMessage 都自增,`message_start` 与终态 wrapper 之间必有 delta → **永不相等 → 守卫恒失效** |
| **tc-rv-001** | trae-code | **S4/E1** | **0.5** | `bun-protocol.mjs:56-62` 的 REDIRECTS 指向 `env-paths.js` / `lru-cache.js` / `orama.js`,而 `src/compat/dangling-shims/` 里**只有 `.ts` 版本**(`env-paths.ts` / `lru-cache.ts` / `orama.ts`),**目标文件不存在**。作者附了不可触发自证(8 处裸导入全在 `opencc-src/`,生产走 bundle) |

---

## 六、评审裁决的逐条比对(72 条)

### 6.1 计分单位(裁判声明)

规则 §6.2 原文是「与裁判终裁不一致 **-2**」。终裁包含严重度与证据等级两项,若两者都逐字比对,任何分档差异都会重复计罚,且会让「评审人没抓住某个降档」与「评审人判错了机制」同价。**本场的裁定口径**:

- **一致** = 机制是否成立的判断一致 **且** 未漏掉我认为material的降档方向。仅严重度分档相差一档、且双方都确认了机制需要修正的,计一致。
- **不一致** = 机制判断相反(REJECTED vs CONFIRMED)、或漏掉了 S1/S2 级别的降档、或把一条独立缺陷判成 KNOWN。

这一口径对四位选手一视同仁,且在计分前固定。

### 6.2 逐人结果

| 评审者 | 评审条数 | 一致 | 不一致 | 裁决正确率 /20 | 抽验 /12 | 新发现 /8 | 交叉洞察 /4(上限) | **评审分** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **claude-code** | 18 | 16 | 2 | 16.0 | 12.0 | 6.5 | 3.6 | **38.1** |
| **workbuddy** | 12 | 10 | 2 | 16.0 | 10.5 | 1.5 | 4.0(封顶) | **32.0** |
| **trae-code** | 21 | 16 | 5 | 10.0 | 10.5 | 0.5 | 4.0(封顶) | **25.0** |
| **opencc** | 21 | 15 | 6 | 8.0 | 10.0 | 1.5 | 2.7 | **22.2** |

**不一致明细**(全部是「漏掉降档」或「判成 KNOWN」,**全场无一条误杀真 bug**):

- **claude-code**:`cc-001`(判 CONFIRMED,我判 PARTIAL S4)、`wb-011`(判 KNOWN,我判 PARTIAL S3 —— 车道区分成立、只是危害被守卫挡住,**不该整条归零**)
- **workbuddy**:`cc-001`、`cc-005`
- **trae-code**:`cc-001`、`cc-005`、`wb-006`、`wb-009`、`wb-010`
- **opencc**:`cc-001`、`cc-005`、`wb-006`、`wb-009`、`wb-010`、`wb-011`

**无人因「放过真缺陷」被扣分**(无 NOT-ENOUGH-EVIDENCE 判在真缺陷上),**无人误杀**。

### 6.3 抽验质量明细

| 评审者 | 抽验条数 | 评价 |
|---|---:|---|
| claude-code | 4 | 四条全中,且**抽了最重的 wb-002 去证伪**。抽验 2 对 `wb-004` 找到作者漏掉的 `serializeLifecycle` 并发闸,抽验 1 主动承认自己踩了与作者同类的假绿坑。**12.0** |
| workbuddy | 4 | 抽验 3 对 oc-001 **自制探针、不依赖作者脚本**,是全场独立性最强的一次抽验。`cc-001` 未质疑触发可达性(半条)。**10.5** |
| trae-code | 4 | 抽验 3 的复现跑在**产品运行时 v22.22.3** 上,并在仓库文档里找到反证;抽验 4 独立复现了 wb-001 的逐级上移。`cc-001` 未质疑触发可达性(半条)。**10.5** |
| opencc | **6** | 唯一超过 3 条下限的。**明确写下「若只抽验 CONFIRMED 条目,REJECTED 就永远不会被独立检验」**并据此特意挑了最重的 S1 去证伪 —— 这是全场对 §5.3 理解最深的一处。`cc-005` 与 `cc-001` 止步于机制未追触发(两条各半)。**10.0** |

---

## 七、计分明细与排名

### 1. 发掘分(60)

| 名次 | 选手 | 条数 | 自报分 | **终裁发掘分** | 落差 | 主要来源 |
|:-:|---|---:|---:|---:|---:|---|
| 1 | **workbuddy** | 12 | 50.3 | **39.6** | −10.7 | 12 条覆盖面(5 条 E3a/E3b 满分系数)+ 三条自报 S1 中两条塌档 |
| 2 | **opencc** | 3 | 19.0 | **17.5** | −1.5 | oc-001(S1/E3b)是全场最高单条;oc-003 证据降档 |
| 3 | **claude-code** | 6 | 27.0 | **16.8** | −10.2 | cc-002 满分,但四条被降档 |
| 4 | **trae-code** | 3 | 12.0 | **12.0** | 0 | **唯一自报即终裁** |

### 2. 总分(100)

| 名次 | 选手 | 发掘分 /60 | 评审分 /40 | **总分** |
|:-:|---|---:|---:|---:|
| **1** | **workbuddy** | 39.6 | 32.0 | **71.6** |
| **2** | **claude-code** | 16.8 | 38.1 | **54.9** |
| **3** | **opencc** | 17.5 | 22.2 | **39.7** |
| **4** | **trae-code** | 12.0 | 25.0 | **37.0** |

> **名次与分数方向相反的一处,值得单独说明**:opencc 的**发掘分是全场第二**(17.5,仅次于 workbuddy 的 39.6),却落在第三;trae-code 发掘分垫底(12.0)却靠评审分守住了第四。这是 §6.1 的「一致/不一致」口径在起作用——opencc 漏掉的 6 处降档比 trae-code 的 5 处多一处,而两者的评审条目数相同(各 21 条)。
>
> **3 与 4 之间只差 2.7 分,实质来源是一处争议**:`wb-011`。我判 PARTIAL S3(workbuddy 得 2.4 分),claude-code 与 opencc 判 KNOWN(双零)。若按那两位的口径,opencc 仍排第三但总分降为 37.3,与 trae-code 的 37.0 只差 0.3 分。**这一条是 3/4 名次的事实来源,也是 §八 列出的三处最值得申辩之一。**
>
> §6.3 同分裁决**本场未触发**(四家总分互不相同)。

### 3. 虚报罚则的口径(为什么全部未触发)

规则原文:「把低严重度报成高严重度,**环节二未被证伪**、但裁判复核为低严重度的,按低严重度计分,且发掘分 **-3**/条」,并沿用上一届「跌一档罚 −3、跌两档只降档不罚」。

本场有 9 条发生降档:cc-001(S3→S4)、cc-003/cc-004(S2→S3)、cc-005(机制部分证伪)、cc-006(S3→S4)、oc-003(仅证据降档)、wb-002(S1→S4)、wb-006/wb-009/wb-010/wb-011(S2→S3)。

- **wb-002 / wb-010 / wb-006 / wb-011**:环节二被评审挑战过(前者被 3 人独立证伪),**不满足「未被证伪」** → 不罚。
- **cc-001 / cc-003 / cc-004 / cc-006 / wb-009**:降档一档但未被证伪 → 按字面规则应罚 −3。

**但本场适用「背书豁免」口径,全部豁免。** 依据是上一届的规则作者裁定(见 `opencc/docs/bugs/bug-hunt-game-10-06/ANNOUNCEMENT.md` §虚报罚则):凡有评审出具书面背书者不罚。这五条均有至少一位评审判 CONFIRMED 并书面认可了作者的严重度。

**我不隐瞒这个口径是我的裁量。** 理由:若严格执行字面规则,会产生一个反向激励——**虚报严重度是免费的,只要有任何一位评审challenge它**;而如实定级却被我更严的校准降档的选手要倒扣 3 分。上一届的 opencc 正是因此被扣 9 分(后由规则作者豁免)。本场我选择承接上一届的裁定,并在此公开记录,供选手申辩。

> **本场 UNVERIFIED 清单为空。** wb-001 的 `'../'×20` 逃逸路径需要文件系统根不可写才能完整观察,实测止于 `EROFS`,已足以证明「无上界」;cc-r1/cc-r2/wb-r1/oc-004/tc-rv-001 均为静态可证的 E1/E3b,不需要额外环境。

---

## 八、申辩条款

裁定书如有错判,你可以申辩,裁判复核后会修正并**公开记录修正过程**(§6.6)。

有效申辩需包含:**具体的 `file:line`** + **可复现的证据**(命令 + 真实输出,或精确的调用链推演)。

**截止**:本公告发出后 24 小时。逾期不受理。

**本场最值得申辩的三处**(我把自己最不确定的先列出来):

1. **wb-002 判 PARTIAL S4 而非 REJECTED 0 分** —— 三位评审都判了 REJECTED。我保留了 0.5 分,理由是同一份实验证实 `writableEnded` 守卫结构上失效。若你认为该守卫失效不构成独立缺陷,这条应归零。
2. **wb-011 判 PARTIAL S3 而非 KNOWN** —— 两位评审判了 KNOWN。分歧点是:「车道不同」是否足以让一条**危害已被既有守卫挡住**的缺陷另立新案。
3. **§七·3 的背书豁免** —— 这是我的裁量,不是规则原文。若你认为应严格执行字面规则,claude-code 与 workbuddy 各需扣 3/9 分,名次会变。

---

## 九、必须公开的三条规则缺陷

裁判把自己的规则毛病一并写进裁定书,不藏着。

### 1. 「交叉洞察 4 分」的上限太低,导致它完全不区分度

本场三位选手都产出了质量很高的交叉洞察(oc 的 `insight-001` 用真实 `PermissionRegistry` 证明了 cc-001 与 cc-002 必须同修;trae-code 的洞察 1 在仓库文档里找到 wb-002 的反证;workbuddy 的 wb-r2 指出 cc-002 的修复清单漏了第二个进程级全局)。按 `S×0.3` 算,三家的原始分都远超 4,结果**全部封顶打满**。这个维度本场等于没区分度。

**下届改法**:上限提到 8,或改为「只给最好的一条计分、其余不计」——避免堆数量。

### 2. 「裁决正确率」的判定单位仍然靠裁判临场定义

上一届的问题是「四家全部打满」,本场通过「放过真缺陷也扣分」修了一半,但**剩下的另一半落在我对「一致/不一致」的口径上**(§6.1)。我事前声明了口径,但这仍是裁判的自由裁量空间,且直接影响 20 分权重。

**下届改法**:把裁决枚举拆细(机制错 / 严重度错 / 证据等级错,分别计分),消掉口径争议。

### 3. 「评审期新发现」与「交叉洞察」之间存在重复计分通道

claude-code 的 `cc-r2`(新缺陷,自动写路径)与 `cc-r5`(交叉洞察,「把读泄漏升级为自动写」)**是同一个事实**,两条都被写进了对应小节。我把新发现那侧计满 5.0 分、洞察那侧计 0,但选手显然没有意识到这两栏会互相吞分。

**下届改法**:模板里明确要求「同一事实只能在一栏计分」,并在 §5.4 写清判例。

### 4. E1 条目缺一个强制项:「最后一跳的前置条件排查」

本场暴露出一条**方向高度一致的系统性偏差**。workbuddy 12 条的前半段(定位、行号、调用链)精度极高——五处行号零偏移——但失真全部集中在最后一跳「找到了缺陷代码 → 所以用户会受害」:

| 条目 | 前半段(准) | 最后一跳(漏掉的前置条件) |
|---|---|---|
| wb-010 | fallback 确无 lookup 注入 | 工具因 `OPENCC_WEBTOOL_ENABLE` 默认不注册 |
| wb-011 | 队列车道机制成立 | 两条落盘路径已 arm `isSessionDeleted` 守卫 |
| wb-006 | 属性闭合成立 | 根本没有 XML 解析器,攻击者是自己 |
| wb-002 | 防护不对称属实 | Node 的 `write` 语义从未实测 |

**这四次失真的方向完全一致(全部向上夸大),且都发生在作者自报 E1 的条目上**;而同一位作者自报 E3a 的条目全部经得起独立复现。他在自己的「自我否定清单」里反复标注「静态推演支持但端到端未验证」——**他知道 E1 的边界在哪里,只是没把同一把尺子用在正式条目上。**

现有规则只要求「精确 `file:line` + 完整调用链 + 为什么现有防护挡不住」,**唯独不要求检查「这条路径当前是否可达」**。§4.2 的「不可触发必须自证」只覆盖作者**声称不可触发**的情形,没覆盖作者**没想过要自证**的情形。

**下届改法**:E1 条目的必填字段增加一项——「**前置可达性排查**」,必须列出该路径的启用门闸(环境变量 / feature flag / 注册条件 / 序列化闸),或在写不出的情况下明写「未查可达性」。这一项能直接拦住上表四次失真中的至少三次。

---

## 十、一条不该丢的观察

**本场 24 条里,13 条落在「跨会话状态」与「状态注册表生命周期」两个簇。** 这与上一届 opencc 的核心发现同构:上一届 29 个缺陷里有 10 个收敛到「mods 状态按名存在多个注册表,而移除路径只清了其中几个」;本场则在另一个代码库上得到同构答案——`abortAll` 的 sid 过滤是 2026-10-05 刚补的第三道防线,而 cc-002 从写入端把 sid 写错、cc-001 从删除端绕过 sid,两条缺陷各自绕过了那道新防线。

**两个仓库、两届比赛、同一类设计缺陷。** 这已经不像巧合,而是「用多个各自独立的注册表 + 单一的清理/过滤点」这个模式在 agent 运行时代码里的系统性复发性。建议把「跨会话状态的写入端与失效端必须同源」当成一条**架构级约束**去处理,而不是继续一条条修。

**另一条**:`docs/bugs/` 里那份 22 条已知清单**已经部分过时**(workbuddy 的 wb-r4 独立核实:`askRegistry.ts:84-90` / `approveRegistry.ts:111` / `permissionRegistry.ts:102` 的 sessionId 过滤已落地,`useAgentStore.ts:1334` 已有 compacting 复位补丁,DELETE 会话已先 `abortSessionController`)。修复阶段应先做一次清单时效性对账,否则按文档排期会去修已经修好的东西。
