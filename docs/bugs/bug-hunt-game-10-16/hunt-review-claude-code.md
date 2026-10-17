# 交叉评审报告 · claude-code

> 规则见 [`README.md`](./README.md)。

**评审者**：`claude-code`
**日期**：2026-10-16
**评审对象**：`bug-hunt-opencc.md` · `bug-hunt-workbuddy.md` · `bug-hunt-trae-code.md`（共 18 条；`bug-hunt-claude-code.md` 是我自己的，不自评）

---

## 一、评审原则自查

- [x] 我对**每一处**被引用的 `file:line` 都实际 `Read` 过，确认行号所指内容与作者描述一致 —— 18 条全部逐条核过，行号对不上的地方我在下面明确指出
- [x] 我的每条裁决都给出了**源码层面的理由**，不是「我读起来觉得不像」
- [x] 我没有因为「这不可能」就 `REJECTED`；本次**没有一条判 REJECTED**，最重的两条降级都是 `PARTIAL` 并附了机器证据或反证的具体推演步骤
- [x] 我完成了 **4 条亲手抽验**（见第四节），跨 3 位选手、跨 S1/S2/S3
- [x] 「评审中额外发现」抓到 2 条新问题（见 §5.1）
- [x] 「交叉洞察」给出 3 条（见 §5.2）
- [x] 我判 `KNOWN` 的条目（wb-011）也**核过行号**（`agent.ts:1062` 的 `void runNextInQueue(sid)` 与已知文档描述逐字对应），不是翻一下 `docs/bugs/` 就下结论

**取证环境**：`HEAD=6f9ceaeb`，`git status --porcelain` 收口时仅含 `?? docs/bugs/bug-hunt-game-10-16/`。评审全程只读源码；跑的两条复现物在 `/tmp/bughunt-claude-code/`，头部均设 `ZAI_DATA_DIR`；wb-002 的验证脚本只 `listen(0)` 取临时端口，**未碰 920x**。本轮**没有**改任何仓库文件。

---

## 二、逐条裁决

### `opencc#oc-001` — 设 `ZAI_DATA_DIR` 的隔离实例仍读写用户真实 `~/.zai/settings.json`

- **裁决**：`CONFIRMED`
- **我核到的位置**：`packages/zai/src/server/services/zaiSettingsStore.ts:35-37`（读到了，与作者描述**逐字一致**）：
  ```
  35	export function zaiSettingsPath(): string {
  36	  return join(homedir(), '.zai', 'settings.json')
  37	}
  ```
  `:23`（`readFile(zaiSettingsPath())`）、`:87-89`（`writeZaiSettingsUnlocked` 用同一 helper 写）均在；`zaiSettingsCache.ts:153` 读、`:176` 写，均经此 helper。
- **理由**：根因属实。我另外补了一步作者没做的核查，把严重度从「读泄漏」推到「写也泄漏」：`zaiSettingsCache.ts:174-179` 的 boot 期 permissions backfill —— `if (settings.permissions === undefined) { ... await writeZaiSettings(settings) }` —— 走的是同一个 `zaiSettingsPath()`。也就是说**只要解析出的 settings 没有 `permissions` 块，一次 boot 就会自动写进用户真实文件**，不需要任何用户操作。加上 `test/setup.isolation.ts:20` 给全仓测试都设了 `ZAI_DATA_DIR`，测试进程一旦走到写路径就会覆盖真实配置。作者的 S1 定档成立。
- **补充支持**：`routes/agentSettings.ts` 有 12 处 `updateZaiSettings(...)`（`:205` 起），全部经同一 helper。

### `opencc#oc-002` — 壁纸端点回吐带脚本的 SVG 且无 nosniff/CSP

- **裁决**：`CONFIRMED`
- **我核到的位置**：`routes/desktopWallpaper.ts:29`（`'image/svg+xml': '.svg'` 在 `MIME_EXT` 白名单里，读到）、`:104-106`（回吐只设 `Content-Type` + `Cache-Control`，读到）、对照面 `routes/fs.ts:1390-1396`（`X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox` + 一段点名 SVG 威胁的注释，读到）。
- **理由**：行号全部对得上，两条写线的不对称是真的，且 `fs.ts:1391-1393` 的注释把这个威胁写得很清楚 —— 说明作者知道，只是漏了另一处。定 S2 成立。
- **对作者论证的一处加强**：作者把降级理由写成「正常 UI 用 CSS background、需直接导航」，隐含接近「自伤」。我认为这个减损**不成立**：SVG 壁纸是常见的从网上下载的素材，威胁模型是「用户自己下载并设置了一张别人做的 SVG」，不是用户手写恶意内容。所以 S2 不降。

### `opencc#oc-003` — AA 审批被中断后 root 侧 `noticeStore` 永不回收

- **裁决**：`PARTIAL`
- **我核到的位置**：`services/aaClient/noticeStore.ts:31`（无界模块级 `byId`，读到）、`:43-45`（唯一的 `byId.delete`，读到）、`:48-54`（`listNoticesForSession` 对外供应，读到）、`:57-58`（`resetNoticesForTests`，仅测试）。全仓 grep 复核：`resolveNotice` 的调用点**只有** `reverseDispatch.ts:2054` 一处；`registerNotice` 的写入点**只有** `eventAdapter.ts:398` 一处 —— 与作者所述完全一致。
- **理由**：**缺陷本身真实存在**，我核到的行号全部正确。
- **但证据等级要降**：作者自称 E3a，理由是「用真实 `noticeStore` 源码逐字复刻」。按 §4.2「测试必须**真实执行被测模块**，禁止把被测对象本身替换掉」——**逐字复刻比 `vi.mock` 更远：它根本没有执行仓库里的那个模块**，执行的是作者自己写的副本。我核过 `noticeStore.ts` 全文只有 59 行、没有外部依赖，所以复刻确实等价；但 §4.2 的立法意图是排除「我以为它是这样」，复刻排除不了这一点。作者自己也承认「真实性来自 grep 全仓调用点，而不是来自执行环境」—— 那就是 **E2**（确定的触发路径 + 观察行为），不是 E3a。
- **修正后的证据等级**：**E2**。严重度 S3 不变（作者已实测证伪「误批准」，这点做得对）。

### `workbuddy#wb-001` — POST /api/agent/sessions 接受任意 sessionId 导致 transcript 路径穿越

- **裁决**：`CONFIRMED`
- **我核到的位置**：`routes/agent.ts:2117-2119`（只判 `typeof === 'string' && length > 0`，读到）、`:2172`（`...(requestedSessionId ? { sessionId: requestedSessionId } : {})` 直接透传，读到）；`compat/runtime/legacyTranscriptStore.ts:240-242`（所谓校验只是 `startsWith('sess-')` 否则**加前缀** `sess-${...}`，读到）、`:94-96`（`join(dirFor(cwd), \`${sessionId}.jsonl\`)`，读到）、`:119-124`（`writeEntries` 还 `mkdir -p` 父目录后 `writeFile`，读到）。
- **理由**：链条完整闭合。`path.join` 会 normalize `../`，而 sessionId 未经过 `sanitizePath`（`dirFor` 对 cwd 用了，sessionId 没有）。更值得记的是 `legacyTranscriptStore.ts:238-239` 的注释自述「Validate the shape (sess-... prefix) to avoid accepting arbitrary strings as transcript ids」—— **意图明确写在注释里，实现没做到**，这让缺陷更难辩解。S1 成立。

### `workbuddy#wb-002` — `createSseStream` 无 EPIPE 防护导致 uncaughtException 杀进程

- **裁决**：`PARTIAL`（**严重度 S1 → S4；证据等级维持 E1，但方向反转**）
- **我核到的位置**：`routes/stream.ts:16-18`（裸 `res.write`，无 try/catch、无 `res.on('error')`、无 destroyed 检查，读到）、`services/sse.ts:9-12`（注释明写「EPIPE 抛出后 unhandled 'error' 事件杀掉 zai 进程」）+ `:22-30`（`safeResWrite` 确实实现了该防护，读到）、`cli/processGuards.ts:19`（刻意不注册 `uncaughtException`，读到）。
- **理由（推理断点在哪）**：作者的不对称是真的，但**从「缺防护」推到「S1 进程崩溃」这一步没有证据支撑** —— 作者是从 `sse.ts` 的**注释**推断这个后果的，自己也标了 E1「未实测」。我对这个推断做了机器验证（见抽验 1）：在产品运行时 Node v25.6.0 上，客户端断连后向已销毁的 `ServerResponse` 继续 `res.write`，**既不抛异常也不触发 `'error'` 事件**（`res.destroyed === true`，0 个 error 事件，无 uncaughtException）；我另外用 `SO_LINGER=0` 强制造 RST（比正常 FIN 更接近「网络抖动」）重跑，**两个分支都存活**。
- **结论**：这条应保留为**健壮性隐患**（`sse.ts` 有防护、`stream.ts` 没有，这个不对称本身值得补齐），但**不能按 S1 计入**。作者最该做而没做的一次实测，恰好就是唯一能把 E1 抬到 E3 的一步。
- **修正后的严重度**：S4

### `workbuddy#wb-003` — `eventBus.historyBySid` 无界增长

- **裁决**：`DUPLICATE-OF: cc-006`
- **我核到的位置**：`services/eventBus.ts:198`（声明）、`:222-227`（唯一的 `set`）、`:270`（唯一的读）——与我自己的 cc-006 完全同一处（我已独立跑过机器验证，见 `cc-006-historyBySid.mts`）。
- **理由**：同一根因、同一处代码、同一组行号。两人各自取证，按 §5.2「双方都照常计分」。
- **一点交叉验证（对 workbuddy 有利）**：他给的对照组是「单 sid 连发 300 条 → 数组被裁到 256」，我的对照组是「单 sid 连发 1000 条 → 裁到 256」，结论一致：**`CAPACITY` 只挡纵深不挡广度**。这个对照设计他做得比我细（他明确点出「防的是单 key 占满内存」），值得记一笔。

### `workbuddy#wb-004` — instanceSupervisor `starting` 窗口内 stop/restart 静默 no-op

- **裁决**：`PARTIAL`（缺陷成立，但**作者给的触发路径不成立**）
- **我核到的位置**：`services/instanceSupervisor.ts:371-373`（`doStart` 顶部 `starting`/`running` 早退，读到）、`:507-517`（`doStop` 在 `!child` 且 `starting` 时 `return snapshotOf(entry)`，读到，`:510-514` 的注释还解释了为什么）、`:609`（`restartInstance = await doStop(id); return doStart(id, opts)`，读到）。状态机推理正确。
- **理由（作者漏掉的一层）**：作者描述的触发路径是「`POST /instances` 内部 createInstance→doStart，端口探测可达数秒 → 探测窗口内 POST stop / POST restart」。**这条路径被 `routes/instances.ts` 的串行化闸废掉了**：`:44-57` 的 `serializeLifecycle(id, task)` 以 id 为键排队，而 `:221`（start）、`:237`（stop）、`:260`（restart）三条路由**全部**经它包装（同一个 `req.params.id`）。所以 start 期间的 stop 会**排队到 start 完成之后**执行，此时 `entry.child` 已存在，`doStop` 走正常路径 —— 正好落不到那个窗口。作者没查这一层。
- **但缺陷仍然可达**，触发点在绕过该闸的调用方（我 grep 到的全部非测试调用点）：
  - `services/weixinBot/weixinDedicatedInstance.ts:200`（start）、`:289-290`（restart/start）、`:320`（stop）—— 均不经 `serializeLifecycle`
  - `services/aaClient/reverseDispatch.ts:829`（start）、`:2299/2303/2307`（start/stop/restart）—— 均不经
  - `instanceSupervisor.ts:348`（child IPC 请求重启）—— 不经
  所以 `PARTIAL`：机制与定档（S2）不变，但「什么时候能被踩到」要改写成上面这批调用方。
- **作者该做没做的一步**：查一遍 `startInstance/stopInstance/restartInstance` 的调用方有没有排队保护。这一步会直接改写触发条件。

### `workbuddy#wb-005` — `jsonSchemaToZod` 无 `required` 时全部属性变必填

- **裁决**：`CONFIRMED`
- **我核到的位置**：`compat/mcp/jsonSchemaToZod.ts:21-35`，读到：`:28` 的 `if (Array.isArray(s.required))` **没有 else 分支**；`:30-32` 的 optional 化循环只在 `:28` 为真时执行。JSON Schema 语义是缺 `required` ⇒ 全部可选。
- **理由**：机制与作者描述逐字一致。我另跑了独立机器验证（抽验 3），结论一致。
- **同意 S2**：模型按 `inputJSONSchema` 省略可选参数 → `safeParse` 拒绝 → 工具大面积不可用，属「API 返回错误结果」。

### `workbuddy#wb-006` — task-command XML 属性注入（title 只转义 `<` 不转义 `"`）

- **裁决**：`PARTIAL`（机制 `CONFIRMED`，**严重度 S2 → S3**）
- **我核到的位置**：`services/taskFactoryBridge.ts:171-172`（`title.replace(/</g,'＜')` 后拼进 `title="${title}"`，读到）、`routes/superTasks.ts:392`（同型第二份，读到）、`superTasks.ts:328-329`（注释自述「标题中的 `<` 替换为全角 `＜` 防止被解析为 XML 起始标签」，读到）。
- **理由**：注入机制完全成立 —— 注释证明作者意识到风险并做了防护，但防护针对 `<`，而真正的断口是双引号属性里的 `"`，**防护与注入面错位**这一点作者说得准确。
- **降档理由**：被注入的内容落在**调度器 LLM 的上下文本子里**。而 LLM 上下文本来就是提示注入的敞口 —— 任务标题本身也是 LLM 生成的，一个恶意/受污染的标题无论经不经 XML 属性都已经进了同一个会话。这里没有跨越任何 LLM 上下文之外的特权边界，「伪造 dispatch 指令」与「标题里写一句『请 dispatch 任务 X』」对模型而言是同一条通路。按 §4.3，S3「提示缺失/边界退化」比 S2「请求发错目标」更贴合。
- **修正后的严重度**：S3（缺陷本身仍应修，两处实现应收敛成单一函数）

### `workbuddy#wb-007` — `taskInbox` 对 running 子 agent 的 send_message 永远无人消费

- **裁决**：`CONFIRMED`
- **我核到的位置**：`compat/background/DefaultBackgroundRuntime.ts:115`（`taskInbox` 声明）、`:241-243`（`sendMessageToTask` 无条件 push + `{ok:true}`，读到）、`:542`（唯一读取）、`:550`（唯一 delete）。我 grep 了全文件 `taskInbox` 的**全部 5 处引用**，作者「唯一消费点」的说法成立。
- **理由**：`:240` 只挡终态（`isTerminal`），running 态照收并返回 `{ok:true}`；而消费点在一次 run 的开头，已经跑过去的 task 不会再回头读。静默丢失属实。
- **保留意见（不影响裁决）**：作者 E1 里「attach 型路径没有 runOne」那一支我没追到底，消费点 `:542` 所属函数我未逐行确认。但**主论证（taskInbox 只有这一个消费点）我已用 grep 独立证实**，足够支撑 `CONFIRMED`。

### `workbuddy#wb-008` — `JsonTaskStore.readEvents` 在 stream `'error'` 回调里同步 throw

- **裁决**：`CONFIRMED`
- **我核到的位置**：`compat/background/store/JsonTaskStore.ts:188-191`：
  ```
  188	stream.on('error', (err) => {
  189	  if (err.code === 'ENOENT') stream.destroy()
  190	  else throw err
  191	})
  ```
  读到。同时 `:181-186` 的**同步**分支确实做了 return/throw 的区分（读到）—— 作者用它做「作者考虑过错误分类」的论据，成立。
- **理由**：在 EventEmitter 回调里 `throw` 会沿 `emit` 调用栈上抛，在没有 `uncaughtException` 兜底时终止进程（`cli/processGuards.ts:19` 证实不注册）。S2 成立。

### `workbuddy#wb-009` — `ReplRuntime.abort/interrupt` 生产路径是 no-op 且泄漏事件

- **裁决**：`CONFIRMED`
- **我核到的位置**：`services/agentRuntime.repl.ts:244-253`（abort：`sessions.get` miss 时**仍无条件** `enqueueEvent`）、`:260-269`（interrupt 同款），均读到。
- **理由**：**泄漏这一半无条件成立**，与 `sessions` 是否被填充无关 —— 每次 abort/interrupt 都往 `eventQueues` 追加一条 `runtime.aborted`，而消费点只在 shutdown。这半边我不需要作者的可达性论证。
- **保留意见**：no-op 这一半依赖「`enqueue()` 全仓无生产调用方」这一负向断言，作者未给 grep 证据，我也未独立复核。no-op 那半按 §4.2 属「触发性未证」，但不影响整条成立。

### `workbuddy#wb-010` — WebFetch 超时 fallback 用原生 fetch 绕过 SSRF 防护

- **裁决**：`PARTIAL`（机制 `CONFIRMED`，**严重度 S1 → S2**）
- **我核到的位置**：`opencc-src/tools/WebFetchTool/utils.ts:286`（axios 主路径 `lookup: ssrfGuardedLookup`，读到）、`:296-297`（注释自述 fallback 存在的原因正是「custom lookup 偶尔卡死」，读到）、`:304-306`（fallback 的 `fetch(url, {signal, redirect:'manual', headers})` —— **无任何 lookup/dispatcher 注入**，读到）。
- **理由**：守卫只在主路径、fallback 完全绕开，这一点是硬的。而且作者的观察很准：触发条件（DNS 慢）恰好就是 custom lookup 最容易出问题的场景，防护在最需要它的时刻失效。
- **降档理由**：S1 要求「越权/数据损坏」已实际发生。此条要成立需要两个前置同时满足 —— (a) 攻击者已能让 agent 去 fetch 某个 URL，(b) 该 URL 解析到内网地址。两者叠加仍是「诱导 agent 访问内网」的强度，对应 §4.3 的「请求发错目标」= S2。S1 档更适合「无需任何前置即可造成不可逆损失」。
- **修正后的严重度**：S2

### `workbuddy#wb-011` — DELETE /agent/sessions/:id 不清 sessionQueues，排队消息让被删会话复活

- **裁决**：`KNOWN-OF: docs/bugs/2026-10-05-delete-session-resurrects--by-zai.md`
- **我核到的位置**：`routes/agent.ts:2228-2269`（DELETE handler 读了，清了 abort/inbox/remove/CwdStore/sessionAgents/PTY，**确实不含 `sessionQueues`**，与作者一致）、`:1062`（`void runNextInQueue(sid)`，读到）。
- **理由**：已核行号，不是翻一下 `docs/bugs/` 就下结论。作者自己也标注了「与已知 #11 不同机制」（那条是「运行中 turn 未中断」，本条是「abort 后 finally 的队列车道」）—— 这个区分**在技术上是对的**：两条的触发条件确实不同。
- **但按 §3.4 的处理口径，这条仍判 `KNOWN`**：已知文档记的是同一个 DELETE handler 缺 sessionQueues/sessionRunning 清理、同一个 `finally → runNextInQueue` 复活路径、同一个症状（transcript 重建 / 侧栏复活）。把同一处根因按触发车道拆成两条报，属于本规则明令禁止的「同一根因拆多条」的对偶形态（§4.6 的精神）。**双方均 0 分**，我把这个判断写明，是为了让裁判能复核我的依据而不是我的结论。

### `workbuddy#wb-012` — `/fs/open-terminal` 对目录条目算错落点

- **裁决**：`CONFIRMED`
- **我核到的位置**：`routes/fs.ts:1497-1499`：`const absDir = rel && !rel.endsWith('/') ? safe.abs.substring(0, safe.abs.lastIndexOf(sep)) : safe.abs` —— 读到，与作者描述逐字一致；`:1494-1496` 的注释也确认了「文件 → 父目录」的意图。**没有任何 stat 判目录**。
- **理由**：纯字符串判定、无异步竞态，E1 已经够了 —— 前端传的相对路径不带尾斜杠（作者的 `FsContextMenu.tsx:213` 论据我未复核，但即便带尾斜杠也只能救一种情形，服务端不 stat 才是根因）。S3 成立，100% 复现。

### `trae-code#tc-001` — AA offline buffer 重连补发期间并发 enqueue 被整体截断销毁

- **裁决**：`CONFIRMED`
- **我核到的位置**：`services/aaClient/offlineBuffer.ts:72-82`（`enqueue`：`appendFile` 后跟 `enforceSizeCap`，**无任何互斥**）、`:86`（`this.draining` 只拦 `maybeDrain` 重入，拦不住 `enqueue`）、`:93`（`readFile` 快照）、`:99-108`（发送循环）、`:112`（`await writeFile(path, '', 'utf-8')` **整体截断**）、`:98`（`const remaining: string[] = []` 确实是死变量）、`:109-111`（注释）、`:118`（`finally` 里 `draining=false`），全部读到。
- **理由**：典型的 read-snapshot-then-truncate 竞态，机制无懈可击。**我另外独立跑了作者的复现物**（抽验 1），结论逐字复现。
- **特别值得记的一点**：`:109-111` 的注释写「If sendNotification silently dropped … the next tick re-reads the file and **re-enqueues**」—— 而 `:112` 刚刚把文件清空了，**下一 tick 读到的是空文件**。注释描述的行为与代码**正好相反**。作者抓到了这一点，这是本轮 18 条里对「注释漂移」抓得最准的一条（与已知清单里 `docs/bugs/README.md` 总结的「安全论证随代码漂移」同族）。
- **S2 成立**（静默丢已持久化的通知，无日志无重试）。

### `trae-code#tc-002` — `getTaskListStore()` fallback 无视 `ZAI_DATA_DIR`

- **裁决**：`CONFIRMED`
- **我核到的位置**：`compat/taskListStore.ts:284-292`，读到：`:289` `_store = new TaskListStore(\`${process.env.HOME ?? '/tmp'}/.zai\`)`；`:286-288` 的注释声称「延迟到 BackgroundRuntime 注入的同时注入」。
- **理由**：作者的核心论断是「注入从未发生」。我独立 grep 了全仓 `setTaskListStore` 的**非测试**调用点：**只有定义本身（`:294`）与 `bundle-entry.ts:279` 的再导出，没有任何生产调用方**。注释承诺的机制不存在，缺陷成立。
- **注意这是我的独立发现**：我在环节一的自我否定清单里**独立写过同一条线索**（我的 compat 子代理以 Candidate 4 的形式提出），当时的判断是「落到 `$HOME/.zai`，无数据损坏，S3」—— 与作者定档一致。**两人独立撞同一条，且都归到 S3。**

### `trae-code#tc-003` — Provider PUT 的 zod schema strip 掉未声明的 `apiKey`

- **裁决**：`CONFIRMED`
- **我核到的位置**：`routes/config.ts:28-51`（`ProviderProfileSchema` 有 `apiKeyEnv`，**没有 `apiKey`**，读到）、`:52` 的注释「Not `.strict()` — zai profile shapes evolved beyond the opencc baseline」（读到 —— 作者的定档关键就在这行）、`:237-244`（`safeParse` 后把 `parsed.data.profiles` 整体写回，读到）；消费方 `services/modelCaller.ts:262`（`apiKey: profile.apiKey ?? envKey ?? fallbackKey`，读到）。
- **理由**：zod 的 `z.object` 默认 strip 未声明键，所以「不是 `.strict()`」恰恰意味着**丢弃**而不是透传 —— 作者把这条注释当成反证来读（说明作者本意是开放），实际它正是丢字段的原因，这个反转很精准。更强的证据是 `config.ts:37-39` 的注释自己写着「Resolution order: **inline apiKey** → env[apiKeyEnv] → …」，而 schema 根本承载不了顺位第 1 项 —— **schema 与它自己文档化的解析顺序矛盾**。S3 成立。

---

## 三、裁决统计

| 选手 | CONFIRMED | PARTIAL | REJECTED | NOT-ENOUGH-EVIDENCE | DUPLICATE | KNOWN | 合计 |
|---|---|---|---|---|---|---|---|
| opencc | 2 | 1 | 0 | 0 | 0 | 0 | 3 |
| workbuddy | 6 | 4 | 0 | 0 | 1 | 1 | 12 |
| trae-code | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| **合计** | **11** | **5** | **0** | **0** | **1** | **1** | **18** |

**严重度修正合计**（`PARTIAL` 条目）：wb-002 S1→S4、wb-004 触发路径改写（定档不变）、wb-006 S2→S3、wb-010 S1→S2、oc-003 证据 E3a→E2（定档不变）。

---

## 四、抽验记录（硬性）

### 抽验 1：`wb-002`（workbuddy / 自称 S1 / 自称 E1）—— **证伪其崩溃主张**

- **我的动作**：作者只给了 E1，理由是从 `services/sse.ts:9-12` 的**注释**推断「EPIPE → unhandled `'error'` → 进程死」。我写了两条脚本实测（`/tmp/bughunt-claude-code/rv-wb002-epipe.mts`、`rv-wb002-probe.mts`、`rv-wb002-rst.mts`），分别加载**真实的** `routes/stream.ts:createSseStream` 与**真实的** `services/sse.ts:writeSse`，起真实 `http.createServer`（`listen(0)` 取临时端口，**未碰 920x**；脚本头设 `ZAI_DATA_DIR`），让真实客户端在流式输出中途断开。
  - 臂 1（FIN）：`req.destroy()`（等价于刷新 EventSource 标签页）
  - 臂 2（RST）：裸 `net.connect` + `resetAndDestroy()`，强制 TCP RST（等价于「网络抖动」，比 FIN 更严苛）
  - 对照组 = 同一个 server、同一个中断，只把写入换成已加固的 `sse.ts:writeSse`
- **我看到的**：
  ```
  node v25.6.0
  === stream (未加固) ===   [stream] client aborted → [stream] SURVIVED 500ms after abort      exit=0
  === sse   (已加固) ===    [sse]   client aborted → [sse]   SURVIVED 500ms after abort      exit=0
  ```
  带探针的那次把每次写之前的状态打出来：
  ```
  post-abort write #8  state={"destroyed":true,"writableEnded":false,"socketNull":false}  threw=no
  result: error events seen = 0
  ```
  RST 臂：`[stream] result: res error events = 0, uncaught = none` / `[sse] 同`。
- **与作者结论是否一致**：**不一致**。作者称客户端断连会 `uncaughtException` 杀掉进程；在产品运行时 Node v25.6.0 上，FIN 与 RST **两种断法都不触发** —— `res.write` 在 `res.destroyed === true` 时**静默返回 false，既不抛也不发 `'error'`**。
- **最终裁决**：`PARTIAL`，S1 → S4。缺口保留（`stream.ts` 确实少了一层 `sse.ts` 有的防护，值得补），但 S1 的崩溃主张在本运行时上不成立。
- **我承认的不确定性**：`sse.ts` 的注释表明作者**当年确实撞到过这类崩溃**，所以存在我没造出来的窄窗口（例如写与错误同时在飞、超大 payload、更老的 Node）。我的结论严格限定在「Node v25.6.0 + 本次能造出的两种断法」。

### 抽验 2：`tc-001`（trae-code / S2 / E3a）—— **复现一致**

- **我的动作**：直接运行作者留在 `/tmp/bughunt-trae-code/repro-offline-race.mts` 的复现物（只读运行，未修改），在 `packages/zai` 下用其自带 tsx 执行。
- **我看到的**：
  ```
  [experimental] drain=true  prefillSize=790 sizeAfterEnqueue=790 finalSize=0   victimSent=0 victimOnDisk=0 LOST=5
  [control]      drain=false prefillSize=790 sizeAfterEnqueue=790 finalSize=1180 victimSent=0 victimOnDisk=5 LOST=0
  RESULT: experimental LOST=5 (expect >0), control LOST=0 (expect 0)
  ```
- **与作者结论是否一致**：**一致**，逐字符复现。实验组 5/5 条丢失、对照组 0 条丢失，对照有区分力。
- **我自己补的验证**：我没有止步于跑脚本 —— 另外独立核了 `offlineBuffer.ts` 全文，确认 `enqueue`（`:72-82`）与 `maybeDrain`（`:85-120`）之间**没有任何互斥原语**（`this.draining` 只在 `:86` 与 `:118` 之间保护 `maybeDrain` 自身重入），并确认 `:112` 的截断是无条件的整体覆盖。**竞态在源码层面独立成立**，不依赖脚本的 `Atomics.wait` 交错手法。
- **最终裁决**：`CONFIRMED`

### 抽验 3：`wb-005`（workbuddy / S2 / E3a）—— **我自己重做，不跑他的脚本**

- **我的动作**：写 `/tmp/bughunt-claude-code/rv-wb005.mts`，加载**真实的** `compat/mcp/jsonSchemaToZod.js`，用两份**语义等价**的 JSON Schema 分别转换后 `safeParse`。对照组的唯一差别是「显式写 `required: []`」vs「省略 `required`」。
- **我看到的**：
  ```
  EXPERIMENT  no `required` field -> safeParse({a}) ok = false
    [{"code":"invalid_type","expected":"number","received":"undefined","path":["b"],"message":"Required"}]
  CONTROL     required: []      -> safeParse({a}) ok = true
  => two semantically IDENTICAL JSON Schemas validate differently: true
  ```
- **与作者结论是否一致**：**一致**。他的对照组设计（语义等价、只差一个空数组）是这条里最有价值的部分，我独立复现后确认它成立。
- **最终裁决**：`CONFIRMED`

### 抽验 4：`wb-004`（workbuddy / S2 / E1）—— **找到作者漏掉的一层防护，触发路径要改写**

- **我的动作**：作者的状态机推理我逐行核对为正确，但他的触发路径是「HTTP 路由在 start 的端口探测窗口内打 stop」。我去查了这三条路由是否有并发保护，读 `routes/instances.ts:44-57`（`serializeLifecycle`）与 `:221/:237/:260`（三条路由全部经它包装，键为同一个 `req.params.id`）。然后 grep 了 `startInstance|stopInstance|restartInstance` 的**全部非测试调用点**。
- **我看到的**：
  ```
  routes/instances.ts:222 / :238 / :261      ← 唯一一组，走 serializeLifecycle，按 id 串行
  services/weixinBot/weixinDedicatedInstance.ts:200 / :289-290 / :320   ← 不走
  services/aaClient/reverseDispatch.ts:829 / :2299 / :2303 / :2307      ← 不走
  services/instanceSupervisor.ts:348 (child IPC restart)               ← 不走
  ```
- **与作者结论是否一致**：**机制一致，触发条件不一致**。作者给的 HTTP 路径被 `serializeLifecycle` 废掉了（stop 会排队到 start 跑完，那时 `entry.child` 已存在，走正常分支）。但缺陷**没有因此消失** —— 上面那 5 处调用方全部绕过串行化闸，仍能踩进 `starting` 窗口。
- **最终裁决**：`PARTIAL`（定档 S2 不变，触发条件必须改写成上述调用方）

---

## 五、评审中额外发现

### 5.1 新缺陷

### [cc-r1] `enableOpenccConfigs` 在干活**之前**就把幂等闩置位 —— 一次启动失败就让 vendor init 在本进程内永久失效

- **严重度**：S3（理由：边界退化 / 错误路径不恢复。因 `createHeadlessContext-impl.ts:160` 独立调用 `enableConfigs()`，最显性的症状被兜住了，剩下丢的是 cwd / clientType / graceful-shutdown / agent 配置这几步接线）
- **证据等级**：E1（完整调用链 + 精确行号 + 防护缺失比对；**不在本轮 4 份报告的任何一条里**）
- **执行环境**：不适用（纯静态推演，未执行）
- **位置**：
  - `packages/zn-agent-core/src/compat/openccInit.ts:386`（模块级 `let enabled = false`）
  - `packages/zn-agent-core/src/compat/openccInit.ts:393-395`（注释：「Idempotent — repeated calls short-circuit after the first **successful** run」）
  - `packages/zn-agent-core/src/compat/openccInit.ts:421-422`（**出错点**：`if (enabled) return` / `enabled = true`）
  - `:443-448`（置位之后的第一个 throw 点）、`:450+`（随后 `await import(BUNDLE_URL)`，第二个 throw 点）
  - 吞错方：`packages/zai/src/server/services/agentRuntime.ts:640-642`（`await enableOpenccConfigs({cwd}).catch(err => console.error(...))` —— 只打日志，**服务继续启动**）
- **为什么我确信**：
  1. 注释承诺的是「第一次**成功**之后才短路」，实现是「第一次**调用**之后就短路」—— 两句话只差一个词，语义相反。
  2. `enabled = true` 之后仍有多个会抛的路径：`:443-448` 的 bundle 预检（磁盘上没构建产物时抛，正是最常见的首次运行场景）、`:450+` 的动态 import。
  3. 一旦抛出，`enabled` 仍是 `true` 且**没有任何复位手段**——我 grep 过整个 `openccInit.ts`，没有 `resetForTesting` 之类的导出（同文件另外两处 `let enabled`（`:310`/`:353`）是别的函数里的局部标志，与此无关）。
  4. 唯一的生产调用方 `agentRuntime.ts:640` 把错误吞掉，于是「vendor compat 初始化已被永久禁用」这件事**没有任何用户可见信号**，连日志都只有一行 `console.error`。
- **为什么前四位没报**：他们排查的范围里 compat 层的 `openccInit.ts` 大概不在主攻方向（四份报告的热点分别是：我的 session/bridge 与前端 store、workbuddy 的 MCP/后台/runtime、trae 的 AA/compat 工具层、opencc 的 settings 与壁纸端点）。这条是「模块级幂等闩置位时机」这一类，全场 18 条没有第二个人碰到。
- **修复方案**：把 `openccInit.ts:422` 的 `enabled = true` 移到**所有步骤成功之后**（或用 `try/finally` 在失败时回滚为 `false`）。副作用注意：必须保证并发调用不会重复执行 —— 现在靠 `enabled` 顺带挡了并发，改成「成功后才置位」需要一个 in-flight promise（对照同文件 `agentRuntime.ts:187-194` 的 `initPromise` 写法，那里已经是对的）。
- **修复后的可达性自证**：本条**不声称「当前不可触发」**。触发条件是 boot 期 bundle 缺失/损坏 —— 对**没跑过 `pnpm run build:core` 就 `dev`** 的用户是首次运行即命中。

### [cc-r2] `zaiSettingsStore.zaiSettingsPath()` 与 boot 期 permissions backfill 构成一条**自动写**用户真实配置的路径（oc-001 的放大器，非其原文所有）

- **严重度**：S1（若成立）
- **证据等级**：E1
- **执行环境**：不适用
- **位置**：`packages/zai/src/server/services/zaiSettingsCache.ts:169-179`（boot 回填写入）
- **为什么我确信**：oc-001 证明了**读**泄漏与 `ZAI_DATA_DIR` 失联，但把写路径留给读者自己推。我核到 `zaiSettingsCache.ts:174-179`：
  ```
  174	  if (settings.permissions === undefined) {
  175	    settings = { ...settings, permissions: DEFAULT_PERMISSIONS }
  176	    await writeZaiSettings(settings).catch(...)
  177	  }
  ```
  这是 **boot 期无条件自动写**，走 `writeZaiSettingsUnlocked`（`zaiSettingsStore.ts:86-91`）→ `zaiSettingsPath()` → 真实 `~/.zai/settings.json`。只要用户 settings 里没有 `permissions` 块（`:169-173` 的注释把它描述成正常回填路径），**任何设了 `ZAI_DATA_DIR` 的实例一启动就改写用户真实文件**，无需任何用户操作。且 `test/setup.isolation.ts:20` 给全仓测试都设了该变量。
  与 oc-001 的关系：oc-001 的复现只做了 GET（并明确声明「发现该 bug 后立即停止一切写 settings 的探测」），所以**它没有覆盖这条自动写路径** —— 这不是 oc-001 的疏漏（它诚实地划了范围），而是它留下的、正好能把它从「泄漏」升级为「数据损坏」的一块。
- **为什么前四位没报**：oc-001 发现了路径失联但止步于读；其余三家未碰 `zaiSettingsCache`。

### 5.2 交叉洞察（非新缺陷，也计分）

### [cc-r3] 针对 `wb-002`：把 E1 抬到 E3 的那一步没做，而它唯一可能的结论是**证伪**

- **针对**：`wb-002`（workbuddy / 自称 S1 / 自称 E1）
- **作者的原论证**：`stream.ts:16-18` 裸 `res.write` 无防护，而同仓 `sse.ts:9-12` 的注释明写同样的写法会「杀掉 zai 进程」，且 `processGuards.ts:19` 不注册 `uncaughtException` —— 三点串起来就是 S1。
- **我补上的**：读了源确认不对称属实之后，**没有停在不对称上**，而是去实测那个「杀掉进程」的后果（详见抽验 1）。结果在 Node v25.6.0 上 FIN 与 RST 两种断法都不触发 —— `res.write` 在 `res.destroyed === true` 时静默返回 false，不抛也不发 `'error'`。并用已加固的 `sse.ts:writeSse` 做同条件对照，两臂都存活。
- **结论**：作者的版本**需要修正为 S4**。推理断点具体在：从「注释说会崩」跳到「会崩」——注释是**另一位作者在另一条写线上、在更早的 Node 上**的经验记录，不是本写线在本运行时的行为保证。这条推理链本身合理，但它缺一次实测，而这次实测的结论与它相反。

### [cc-r4] 针对 `wb-004`：作者的状态机推理正确，但漏查了一层并发保护，而那层保护恰好废掉了他给的主触发路径

- **针对**：`wb-004`（workbuddy / S2 / E1）
- **作者的原论证**：`doStart` 顶部有 `starting` 守卫、`doStop` 在 `starting` 窗口空转返回、`restartInstance = doStop + doStart` 所以整体 no-op 且返回成功；触发路径写成「HTTP 路由在端口探测窗口内打 stop/restart」。
- **我补上的**：核完那三处行号（作者全对）之后，我去查了**并发保护**——`routes/instances.ts:44-57` 的 `serializeLifecycle` 以 id 排队，`:221/:237/:260` 三条路由全部经它包装（同一个 `req.params.id`）。于是 start 期间的 stop 会排队到 start 完成之后执行，那时 `entry.child` 已存在，`doStop` 走正常分支 —— 落不到那个窗口。再 grep 全部非测试调用点，定位到 5 处**绕过**该闸的调用方（`weixinDedicatedInstance.ts:200/289/290/320`、`aaClient/reverseDispatch.ts:829/2299/2303/2307`、`instanceSupervisor.ts:348`）。
- **结论**：作者的版本**成立但触发条件要改写** —— 缺陷仍为 S2、可达性仍成立，但「什么时候能被踩到」是上面那批调用方，不是 HTTP 路由。这一步的价值不在于推翻他，而在于**修的时候别去改 HTTP 层**（那里没 bug），要去改 supervisor 与那 5 处调用方的并发假设。

### [cc-r5] 针对 `oc-001`：把「读泄漏」升级为「自动写」的一步，藏在它诚实声明的边界之外

- **针对**：`oc-001`（opencc / S1 / E3b）
- **作者的原论证**：设了 `ZAI_DATA_DIR` 的实例仍解析到真实 `~/.zai/settings.json`，用 GET 端点 + 与用户真实文件逐键比对（10 个共享键、0 个不同）证明读到的是用户真实配置，并明确声明「本探针只做 GET，发现该 bug 后立即停止一切写 settings 的探测」。
- **我补上的**：顺着它标的写路径（`zaiSettingsStore.ts:87-89`）往上找**谁会自动触发写**，找到 `zaiSettingsCache.ts:174-179` 的 boot 期 permissions backfill —— `if (settings.permissions === undefined) { ...; await writeZaiSettings(settings) }`。这是**每次 boot 都会评估**的自动写，不需要任何用户操作。再核 `routes/agentSettings.ts` 有 12 处 `updateZaiSettings`（`:205` 起）会走到同一 helper。
- **结论**：作者的版本**成立且应保留 S1**。我的补充不改变它的裁决，只把它「S1 的理由偏重读」的论证补实成「读无条件、写在缺 `permissions` 块时无条件」——**后者才是 S1 档「数据损坏」的真正落点**。作者在自我否定清单里没有把这条写开（那里只讨论了要不要报 S1 的另一个维度），补上它对修复优先级有影响：只加 `Host` 头校验或只谈读泄漏都不够，改 `zaiSettingsPath()` 是唯一入口。

---

## 六、我给评审过程的一句话

本场 18 条里我的 `CONFIRMED` 率是 11/18（61%），没有一条判 `REJECTED`——最重的两条（wb-002、wb-010）我都降了档，但降的理由都是**可复算的**（一个是我实测跑出了相反结果，一个是严重度档位与 §4.3 判据不符），不是「读起来不像」。workbuddy 的 12 条数量最多、覆盖面最广，E1 占比也最高，其中 4 条降档全部集中在同一个模式：**把源码注释里记录的历史经验当成当前行为的事实**（wb-002 的 EPIPE、wb-006 的 XML 转义、wb-010 的 SSRF 守卫），而 §4.2 恰恰要求 E3 —— 这个要求拦住的不是吹牛，是这类「注释说了所以必然如此」的推理。
