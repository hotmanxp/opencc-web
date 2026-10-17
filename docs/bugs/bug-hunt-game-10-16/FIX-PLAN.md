# 修复计划 · bug-hunt-game-10-16 产出

> **来源**：[`VERDICT.md`](./VERDICT.md) 终裁的 24 条声明 + [`ANNOUNCEMENT.md`](./ANNOUNCEMENT.md) 的 5 条评审期新发现
> **去重后独立缺陷**：**28 个**(cc-006 与 wb-003 为同处)
> **基线提交**：`6f9ceaeb`（`main`）　**日期**：2026-10-16
> **本计划的所有 `file:line` 均由裁判亲自读源码核对过**，不是选手转述

---

## 零、前置动作(必做,否则后面会白干)

### 0.1 `docs/bugs/` 那 22 条已知清单已经部分过时

workbuddy 在评审期独立核实(workbuddy 的 wb-r4,我已复核):

| 已知清单声称 | 当前源码实际 |
|---|---|
| `prompt-close-aborts-all-sessions`:三个 registry 的 `abortAll` 无 sessionId 过滤,**未修** | **已修**:`askRegistry.ts:84-90`、`approveRegistry.ts:111`、`permissionRegistry.ts:102` 三处过滤均已落地,注释还写明了收窄意图 |
| `delete-session-resurrects`:DELETE 未 `abortSessionController` | **已修**:DELETE 路由现在会先 abort |
| `sse-subscriber-and-session-leak`:心跳无法感知连接已死 | 结论部分已过时——`2026-10-05-sse-subscriber-and-session-leak.md:55-57` 自己写着「实测不成立:在已销毁的 socket 上写,Node 静默 no-op,不抛」 |

**动作**:修任何东西之前,先把 `docs/bugs/README.md` 按当前源码逐条对账,已修的标注「已修 · 修复提交 X」,否则下一届选手会拿它当基线(本场就有选手据此认定某些行号「不可报」,而实际未修)。

### 0.2 本计划里 5 条是归档项,不修

| ID | 归档理由 |
|---|---|
| **cc-001** | 机制真(摘错 signal),但跨会话误杀需两个会话共用同一模型生成的 `toolUseId`,不可达;剩余的 listener 累积路径本来就是好的。潜伏缺陷,等真出现重复注册再加守卫 |
| **cc-006 ≡ wb-003** | 真缺陷但危害夸大:实测 5000 个 sid 全进程堆仅 10.8 MB。**保留一条数据留存记录**:删会话的用户以为清干净了,而 `runtime.delta` / `tool_result` 仍以完整物化形式留在内存 |
| **wb-002** | 崩溃主张已证伪(裁判实测 + 三位评审 + 仓库自带反证)。残留「`stream.ts` 缺 destroyed 检查」在本运行时下不产生任何可观测后果。可在批 4 顺手加一行,不算独立任务 |
| **wb-009** | 死路径成立(生产 `query` 不走 `getOrCreate`),但功能今天靠 AbortController 正常,只是慢泄漏 |
| **tc-rv-001** | 目标文件确实不存在(`dangling-shims/` 只有 `.ts`),但当前打包形态下 loader 的这四条重定向不可达,作者附了完整自证 |

> **归档的代价是明确的**:这 5 条不会有人主动修。记在这里的意义是——当 vendor 改成经 tsx 直载、当有人报「孤儿进程占端口」、当 `toolUseID` 真的重复时,能立刻知道这里有笔账。

---

## 一、总表:23 个待修缺陷

| ID | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| **wb-001** | **S1** | `agent.ts:2117` + `legacyTranscriptStore.ts:94/239` | 任意 `sessionId` → transcript 落盘**无上界**路径穿越 |
| **oc-001** | **S1** | `zaiSettingsStore.ts:35-37` | 设了 `ZAI_DATA_DIR` 仍读写真实 `~/.zai/settings.json` |
| **cc-r2** | **S1** | `zaiSettingsCache.ts:174-179` | 同一失联的**自动写**面:boot 期无条件回填并落盘 |
| cc-002 | S2 | `createOpenccRuntime-impl.ts:1153-1157` | 进程级 `__zaiBridgeCtx.sessionId` 并发串台 |
| cc-005 | S2 | `killTree.ts:31-35` | POSIX 只杀直接子进程,`sh -c` 复合命令留孤儿占端口 |
| wb-004 | S2 | `instanceSupervisor.ts:514/611` | `starting` 窗口内 stop/restart 静默 no-op 且返 200 |
| wb-005 | S2 | `jsonSchemaToZod.ts:27-33` | 无 `required` 时全部属性变必填,MCP 工具调用被误拒 |
| wb-007 | S2 | `DefaultBackgroundRuntime.ts:542/502` | running 子 agent 的 `send_message` 永久滞留 |
| wb-008 | S2 | `JsonTaskStore.ts:189-192` | stream `'error'` 回调里 throw → uncaughtException 杀进程 |
| tc-001 | S2 | `offlineBuffer.ts:112` | drain 整体截断,补发期间的通知永久销毁 |
| cc-r1 | S3 | `openccInit.ts:421-422` | 幂等闩先置位后干活,一次启动失败永久失效 |
| cc-003 | S3 | `useAgentStore.ts:1334` | 切会话不清 `pendingAsk`,卡片串会话并锁死输入 |
| cc-004 | S3 | `useAgentStore.ts:1624-1633` | `await` 后无条件回写,慢响应把会话拽回来 |
| oc-002 | S3 | `desktopWallpaper.ts:104-106` | 回吐带脚本 SVG,全服务唯一缺 `nosniff`/`CSP` 处 |
| oc-003 | S3 | `noticeStore.ts:43` + `reverseDispatch.ts:2023` | AA 审批中断后卡片无自动回收 |
| oc-004 | S3 | `desktopWallpaper.ts:72-80` | 并发清理竞态 → N 个上传全 404 且**返回 200 假成功** |
| tc-002 | S3 | `taskListStore.ts:289` | 生产 fallback 无视 `ZAI_DATA_DIR` |
| tc-003 | S3 | `config.ts:28-51` + `shared/types.ts` | Provider PUT 把内联 `apiKey` 静默剥掉 |
| wb-004 附 | S3 | `routes/instances.ts:44-57` | 5 处调用方绕过 `serializeLifecycle` |
| wb-006 | S3 | `taskFactoryBridge.ts:171` | XML 属性只转义 `<`,`title` 可注入属性 |
| wb-010 | S3 | `WebFetchTool/utils.ts:304-306` | 超时 fallback 裸 `fetch` 绕过 SSRF 守卫 |
| wb-011 | S3 | `agent.ts:1062` 队列车道 | 排队消息触发孤儿 turn,静默烧 token |
| wb-012 | S3 | `fs.ts:1494-1499` | 右键文件夹终端开在父目录 |
| wb-r1 | S3 | `sdkEventAdapter.ts:270` | turnIndex 防双增守卫恒失效,每 turn 双增 |

---

## 二、修复批次

> **排序依据不是严重度,是「值不值得现在修」**:① 影响面(多少用户、多少常规路径会踩到);② 后果(静默 > 报错;丢数据 > 显示错;越权 > 不优雅);③ 修复成本(同一修法能收掉几条)。

### 批 1 · 授权围栏(1 条 · S1 · 本场最该先修)

**wb-001** — `POST /api/agent/sessions` 接受客户端任意 `sessionId`

**成因(裁判亲读源码,注释自曝)**
```ts
// legacyTranscriptStore.ts:236-241 —— 注释写的是「Validate the shape (sess-... prefix)
// to avoid accepting arbitrary strings」,而实现只查了前缀
const sessionId = meta.sessionId?.startsWith('sess-') ? meta.sessionId : `sess-${meta.sessionId}`
```
`'sess-../../..'` **以 `sess-` 开头**,顺利通过;随后
```ts
// legacyTranscriptStore.ts:94-96
private filePathFor(sessionId, cwd) { return join(this.dirFor(cwd), `${sessionId}${JSONL_EXT}`) }
```
`join` 会规范化 `..`,于是穿越出 `dataDir`。实测 `'sess-' + '../'.repeat(20) + 'X'` 解析到 `/X.jsonl`(`EROFS` 证明已越过全部路径深度可及层)——**无上界,不是固定层数**。

**修法(双保险,两处都要改)**
1. `agent.ts:2117`:`requestedSessionId` 现有校验只有 `length > 0`,改为白名单正则 `/^sess-[A-Za-z0-9_-]{1,128}$/`(或至少拒绝含 `/` `\` `..` 的 id)。
   ⚠️ **注意 AA 兼容性**:`agent.ts:2112-2116` 的注释说明 AA 的 `session.create` 是**客户端分配 id** 再传给 connector,正则太紧会打断 AA 绑定。**上线前必须跑一次 AA 会话创建回归**。
2. `legacyTranscriptStore.ts:94`:`filePathFor` 加围栏断言——`const p = resolve(this.dirFor(cwd), \`${sessionId}${JSONL_EXT}\`); if (!p.startsWith(this.dirFor(cwd) + sep)) throw`。同文件的 `dirFor` 已经用了 `sanitizePath(cwd)`,**现成的范式就在旁边**。

**验收**:新增回归用例 `'sess-../../evil'`、`'sess-..%2F..'`、超长 id 三类输入,断言抛错且 `dataDir` 外无文件产生。

---

### 批 2 · 数据目录解析收敛(3 条 · S1×2 + S3 · **一次收口**)

**oc-001 + cc-r2 + tc-002 指向同一个治理项:各模块各写各的 `homedir()`,没有统一的 `resolveZaiDir()`。**

- `zaiSettingsStore.ts:35-37`:`join(homedir(), '.zai', 'settings.json')` —— 完全不看 `ZAI_DATA_DIR`
- `zaiSettingsCache.ts:174-179`:`if (settings.permissions === undefined) { ...; await writeZaiSettings(settings) }`,注释 `:171` 明写 "persist to **~/.zai/settings.json**" —— **boot 期无条件自动写**
- `taskListStore.ts:289`:`${process.env.HOME ?? '/tmp'}/.zai` —— 连 `ZAI_DATA_DIR` 都不看(模板字符串绕开了 `join(homedir()` 这个 grep 特征,所以 oc-001 自己列的 8 处清单漏了它)

**修法**
1. 新增/导出 `resolveZaiDir()`(zai 侧直接用 `paths.ts:23` 的 `ZAI_DIR`;core 侧需自己实现,因为 `zn-agent-core` 够不到 zai 的常量——**这是结构性约束,不是疏忽**)
2. 收口全部调用点。**清单是 11 处,不是 8 处**:oc-001 自报 8 处 + 复核补出的 `paths.ts:125`(`~/.zai/weixin/locks`)+ `zaiSettingsCache.ts:43`(tier-2 的 `~/.claude/settings.json`)+ `taskListStore.ts:289`
3. `zaiSettingsCache.ts:174` 的回填在写之前判一次路径来源;若解析结果不在 `ZAI_DATA_DIR` 内,跳过写入并 `console.warn`

**为什么这条值得单独一批**:oc-001 证明读泄漏、cc-r2 证明写会自动发生。**两条合并后,一个设了 `ZAI_DATA_DIR` 的实例启动即改写用户真实配置**(对任何 settings.json 缺 `permissions` 块的用户——注释把它描述成「正常回填路径」,说明这是常态而非边角)。

**验收**:哨兵实验(重定向 `HOME` 到临时目录并植入哨兵值 + 设 `ZAI_DATA_DIR`)+ 起真实例,断言 GET 返回内置默认而非哨兵值、PUT 落盘在 `$ZAI_DATA_DIR` 下、boot 后 `$ZAI_DATA_DIR` 出现 settings.json 而假 HOME 的 mtime 不变。

---

### 批 3 · 跨会话状态写入端(1 条 S2 + 1 项治理)

**cc-002** — `globalThis.__zaiBridgeCtx.sessionId` 并发串台

**成因(裁判复核补上的关键一格)**:调用现场 `getCurrentSessionId()` **已经返回正确的 `sess-AAA`**,而进程全局同时是 `sess-BBB`。**这不是「缺少能力」,是「漏了一行守卫」**——修复成本比作者估计的低得多。

- `headlessPermissionBridge.ts:64-69`:只读全局,**无 ALS 兜底**
- 对照 `AskUserQuestionTool.ts:28`:`getCurrentSessionId() ?? bridge.sessionId` —— 同一个全局,一个消费者有兜底一个没有

**修法(两条一起改,缺一不可)**
1. `headlessPermissionBridge.ts:64`:`(globalThis as any).__zaiBridgeCtx?.sessionId` → `getCurrentSessionId() ?? bridge.sessionId`,与 `AskUserQuestionTool` 对齐
2. **wb-r2 补充的治理项**:`__zaiCurrentSessionId` 是**第二个**承载 sessionId 的进程级全局。`subagentControl.ts:73-94` 的注释**已经写明**它是进程级单例、会读到别人的 sessionId,并因此改用了 ALS——但 `SpawnAgentTool.ts:639`、`CliAgentTool.ts:639`(`readZaiCurrentSessionIdBridge`)、`subagentReport.ts:26` **仍在只用全局**。后果:子 agent 完成的 `<task-notification>` 按 `parentSessionId` 路由,并发窗口下会投进错误会话。

> **修复约束(来自 opencc 的 insight-001,已独立复核成立)**:`abortAll(reason, sid)` 是 2026-10-05 刚补的**第三道**防线。cc-002 从**登记时**就把 sid 写错(过滤器成为共犯),cc-001(归档)从**删除时**绕过 sid。**只修写入端是必须的;修完别以为第三道防线就够了。**

**验收**:真 ALS + 真 `PermissionRegistry`,双 query 并发,断言 `registry.sessionId` 与 ALS 一致;并发下 A 的断连不得影响 B 的 entry。

---

### 批 4 · 进程与子进程(2 条 · S2)

**cc-005 — `killTree.ts:31-35`**
```ts
// 非 win32 分支:只发给 sh 本身,无 detached、无进程组
child.kill(opts.force ? 'SIGKILL' : 'SIGTERM')
```
文件头注释已经把原因写清楚了:**Windows 上有 `taskkill /T /F` 递归杀树,非 win32 分支什么都没有。**

**修法**:`ReplSession.ts:148` 的 `spawn('sh', [...])` 加 `detached: true`(让 sh 成为进程组组长),`killChildTree` 的 POSIX 分支改为 `process.kill(-child.pid, signal)`。
⚠️ **副作用必查**:`detached: true` 会脱离控制终端,子进程**不再因终端关闭而收到 SIGHUP**。`runtimeLifecycle.ts:99` 已有 `kill(-pid)` 与 SIGHUP 兜底,**必须确认那条兜底路径覆盖了本场景**,否则会引入新的孤儿。

> 注:作者举例的 `sh -c "cd api && npm run dev"` 在 macOS **不 fork**(末条命令走 exec 优化),孤儿来自 `sh` exec 成 npm 后 npm 自己 spawn 的子进程。但 `kill(-pgid)` 依然覆盖(组组长是 npm,子进程仍在同组)——**修法成立,只是动机论证错了**。

**wb-008 — `JsonTaskStore.ts:189-192`**
```ts
stream.on('error', (err) => {
  if (err.code === 'ENOENT') stream.destroy()
  else throw err          // ← 沿 emit 栈逃逸为进程级异常
})
```
`processGuards.ts:19-20` **明确不注册 `uncaughtException`** 兜底,所以这一行能直接杀掉整个 server。实测:把 `events/boom.log` 造成目录(EISDIR)→ `exit=13`。

**修法**:`else throw err` → `else stream.destroy(err)`,让错误通过 `for await (const line of rl)` 的正常 rejection 路径抛给调用方。
⚠️ 副作用:改后调用方会收到异常,需确认所有 `readEvents` 调用点都处理了 rejection。

**搭车项(wb-002 的残留)**:给 `stream.ts:16-18` 的 `send()` 加 `if (res.destroyed) return`。**这不是修崩溃**(崩溃主张已证伪),是让 `stream.ts` 与 `sse.ts` 的形状对齐,并消掉「断开后继续做无效 `JSON.stringify` + write」的浪费。一行,顺带做。

---

### 批 5 · 契约与 schema(3 条 · S2 + S3×2)

**wb-005 — `jsonSchemaToZod.ts:27-33`**
```ts
let obj = z.object(shape).passthrough()
if (Array.isArray(s.required)) {
  const req = new Set(s.required)
  for (const k of Object.keys(shape)) if (!req.has(k)) shape[k] = shape[k].optional()
  obj = z.object(shape).passthrough()
}
return obj          // ← 没有 required 时,所有属性都是必填
```
违反 JSON Schema 语义:**`required` 缺失 = 全部可选**,而实现是全部必填。消费方 `MCPToolAdapter.ts:46` 直接 `safeParse`,模型省略可选参数即调用失败。

**修法**:补 `else` 分支,把所有属性 `.optional()`。实测对照:两份语义等价的 schema,仅差空 `required` 字段,输出相反——这就是判据。

**tc-003 — `config.ts:28-51`**
```ts
const parsed = schema.safeParse(req.body)      // z.object 默认 strip,未声明键被丢
file.content.providerProfiles = parsed.data.profiles
```
`ProviderProfileSchema` 声明了 `apiKeyEnv` 却没有 `apiKey`,而 `modelCaller.ts:262` 的 `apiKey: profile.apiKey ?? envKey ?? fallbackKey` 运行时承重 → **一次保存即静默丢凭证**。

**修法必须改三层,只改一层会 typecheck 失败**
1. `shared/types.ts:221-255` 的 `ProviderProfile` 补 `apiKey?: string`(**现在前端 `existing?.apiKey` 根本过不了类型检查**)
2. `config.ts` 的 `ProviderProfileSchema` 补 `apiKey: z.string().optional()`
3. `Config.tsx:136-155` 的 `nextProfile` 保留 `apiKey`

⚠️ **不要改成 `.passthrough()`**:`config.ts:52-57` 明写「不 `.strict()`,**故意** strip 未知键,让落盘 profile 保持干净」。改成 passthrough 会把 `authToken` 之类历史脏键一并放行,与设计意图相反。**正解是「加运行时字段时同步 schema」,不是「关掉 strip」。**

**wb-006 — `taskFactoryBridge.ts:171`**:title 只转义 `<` 不转义 `"` → 属性可闭合。修复是把 `&`/`<`/`>`/`"`/`'` 全转义。

> **危害收窄(必须写进工单)**:这不是跨信任边界注入——`task-command` 只进调度器 LLM 的 prompt 文本,**无任何代码解析器**(`agent.queue.test.ts:770` 白纸黑字:"no parser for it yet"),且标题由用户本人输入。属自我提示注入。修一行是划算的(防御纵深),但**不要按 S2 排期**。

---

### 批 6 · 生命周期 / 队列 / 资源(6 条 · S2×2 + S3×4)

**wb-004 — `instanceSupervisor.ts`**
- `:514`:`if (entry.status.state === 'starting') return snapshotOf(entry)`(早退不动状态)
- `:611`:`restartInstance = await doStop(id); return doStart(id, opts)` —— 两步各自被同一守卫挡回,净效果 no-op
- `instances.ts:261` 照常 `res.json({ instance })` → **返回成功**

**修法(先改 supervisor,不要改 HTTP 层)**:claude-code 的交叉洞察 cc-r4 已独立核实——`routes/instances.ts:44-57` 的 `serializeLifecycle` 按 id 排队,`:221/:237/:260` 三条路由全部经它包装,**HTTP 路由根本进不了那个窗口**。真实触发方是 5 处**绕过**该闸的调用方:`weixinDedicatedInstance.ts:200/289/290/320`、`aaClient/reverseDispatch.ts:829/2299/2303/2307`、`instanceSupervisor.ts:348`。修法:`starting` 窗口内的 stop/restart 请求**排队或明确拒绝**,不能静默 no-op + 返 200。

**wb-007 — `DefaultBackgroundRuntime.ts`**
- `taskInbox` 全文件仅 4 处,唯一 delete 在 `runOne` 开头(`:550`)
- `runOne` 只由 `scheduleNext`(`:502`)从 queue 取**新 id** 调用
→ 已 running 的任务永不消费 `send_message`,接口返回 `{ok:true}` 但消息永久滞留;`interrupt_agent`(`subagentControl.ts:169` → `bg.cancel` → `controller.abort`)落终态后 `sendMessageToTask` 恒返 `ok:false`——**工具描述与语义相反**

**修法**:二选一——① 允许 running 任务在 turn 边界消费 inbox;② 把 `send_message` 对 running 任务的返回从 `ok:true` 改成显式拒绝。**当前行为两头不占:骗调用方说成功,实际丢弃。**

**wb-011 — 残留项**:复活路径已被 `isSessionDeleted` 双层守卫挡住(`sessionFacade-impl.ts:278/291`、`sessionStorage.ts:1783`),**只剩一次无用 LLM 调用烧 token**。修法:`agent.ts:1062` 的 `void runNextInQueue(sid)` 前加一次 `isSessionDeleted` 判短路。
> 与已知 #11 的关系:该条目文档自己就把「`runNextInQueue` 需加守卫」列为**第二道防线待办**,本条是它的未完成尾巴,**不是重报**。

**oc-003 — `noticeStore.ts`**:AA 中断后卡片无自动回收(靠用户误点才回收,因为 `resolveNotice` 在 `reverseDispatch.ts:2054` 于 `forwardToChild` 之前执行)。修法:给 notice 加 TTL 或在 `handleInterrupt`(`:2023-2026`)里按 `zaiSid` 清理。

**oc-004 — `desktopWallpaper.ts:72-80`**:清理是 `void readdir(dir)` fire-and-forget,与写入无互斥 → N 个并发上传全部 404 且**响应是 200 假成功**,前端会把坏 URL 存进 localStorage,此后每次刷新都是坏图而 UI 显示「壁纸已更新」。

**修法**:清理放进与写入**共用的一把互斥**(与仓库既有的 `atomicWrite` 串行化思路一致),或只删 `stat.mtimeMs` 比本次写入更旧的文件。
⚠️ **当前没有任何测试覆盖这条清理路径**,改完必须补一条「并发 N 次 PUT 后 N 个 URL 全部 200」的回归。

**wb-010 — `WebFetchTool/utils.ts:304-306`**:timeout fallback 是裸 `fetch(url, {signal, redirect:'manual'})`,**无 lookup 注入**,而主路径 `:286` 带 `lookup: ssrfGuardedLookup`。
**修法**:fallback 分支补上同一套守卫。
⚠️ **影响面收窄**:`WebFetchTool.ts:117-120` 的 `isEnabled()` 要求 `OPENCC_WEBTOOL_ENABLE`,全仓仅 3 处提及,**zai 从不设置,该工具默认不在工具池**。这是「防御纵深」而非「当前在漏」,可排在批 6 末位。

---

### 批 7 · 前端状态与 UI(4 条 · S3)

**cc-003 + cc-004 同在 `useAgentStore.ts`,一起改**
- cc-004(`:1624-1633`):`await` 之后用**函数参数** `sessionId` 覆写 `setCurrentSession` 已写入的值,窗口内无 stale 守卫 → 慢响应把用户刚切走的会话拽回来(URL 与界面分叉)
  **修法**:`if (sessionId !== cur && cur !== null) return`。⚠️ **不能写成 `cur !== sessionId`**——冷启动时 `loadSessions:1311` 先 `set({sessionId})` 再 `loadTranscript`,那样会误杀正常首屏加载。
- cc-003(`:1334`):`setCurrentSession` 清了 8 个键,**独缺 `pendingAsk`** → A 的阻塞卡片渲染进 B 并锁死 B 的输入框(`AgentInputBox.tsx:282-283` 的 `sendBlocked`)
  **修法**:`setCurrentSession` / `createNewSession`(`:1413-1425`) / `clearMessages`(`:1252-1276`)三处都补 `pendingAsk: null`。
  ⚠️ **复核发现一条可能免竞态的路径,修前请先确认**:`clearMessages` 顺手把 `status` 置 `'idle'`,这一步直接解除 `isBusy` 门禁,用户不必按 Esc 即可切走(触发点是 `/clear`,`AgentInputBox.tsx:597/1132` 均无 `isBusy` 前置)。**未核实服务端是否接受流式期间的 `/clear`**——若接受,cc-003 从「竞态」升为「确定触发」,S2 成立,修法不变但优先级提高。

**wb-012 — `fs.ts:1494-1499`**:目录条目的 `path` 由 `name` 拼成(`:396`),**结构上不可能带尾斜杠**,而服务端靠 `rel.endsWith('/')` 判断是不是目录 → 恒 false → 终端开在父目录。修法:前端把已有的 `kind` prop 传给服务端(`FsContextMenu.tsx:17` 持有但未传),服务端按 `kind` 而非字符串形状判断。

**oc-002 — `desktopWallpaper.ts:104-106`**:回吐带脚本 SVG,无 `nosniff`/`CSP`。修法:与 `fs.ts:1394-1395` 对齐加两道头。
> 复核确认:这两道头在**整个 server 只有 `fs.ts` 一处**(无 helmet),所以壁纸端点是全服务唯一同类缺口。危害收窄:UI 走 CSS `background`,浏览器不执行其中 SVG 脚本,触发需用户**直接导航**该 URL。

---

### 批 8 · 数据完整性与初始化(3 条 · S2 + S3×2)

**tc-001 — `offlineBuffer.ts:112`**(本批唯一 S2,优先做)
```ts
for (const line of lines) { ...; this.conn.sendNotification(...) }
// All entries consumed — clear the file. ... the next tick re-reads
// and re-enqueues.                          ← 与下一行行为直接矛盾
await writeFile(path, '', 'utf-8')
```
**注释声称的行为与代码行为相反**——「下次 tick 会重读并重新入队」不会发生,因为文件已被清空。

实测两条路径都会丢:① 并发 enqueue(作者原论证)② **补发中途掉线 → 重新入队 → 自身截断**(复核补出,不依赖外部并发,10 条只送达 2 条、落盘 0 字节)。

**修法(先修语义,比加锁更根本)**:只删除**已成功发送的行前缀**,而不是整体清空;或用「读 → 发 → 按行删除」的行级事务。再考虑与 `enqueue` 加互斥。
⚠️ 影响面:`initAaClient` 受 `isAaEnabled()` 把关,**只有 `--aa` 启动的实例**有这个 buffer。

**wb-r1 — `sdkEventAdapter.ts:270`**
```ts
meta.turnIndex += 1                                  // :159
meta.lastStreamedMessageStartCounter = meta.eventCounter   // :160
// ...
if (meta.lastStreamedMessageStartCounter !== meta.eventCounter) { meta.turnIndex += 1 }  // :270
```
守卫意图是「stream_event 已为本 turn bump 过,wrapper 不要再 bump」,判定方法是计数器相等。但 `eventCounter` **每条 SDKMessage 都自增**(`createOpenccRuntime-impl.ts:1267-1273`),而 `message_start` 与终态 `assistant` wrapper 之间**必然夹着 content_block_delta** → 两个值永不相等 → **守卫是死代码,正常流式路径每 turn 双增**。注释自己写着后果是 "create empty bubbles between streamed and synthesized blocks"。

**修法**:把 `lastStreamedMessageStartCounter` 的语义改成「本 turn 是否已 bump」的布尔标志,而不是存计数器快照。

**cc-r1 — `openccInit.ts:421-422`**
```ts
if (enabled) return
enabled = true        // ← 先置闩
// ... :438-448 的 bundle 预检会 throw,且全文件无任何复位手段
```
注释 `:393-395` 承诺的是「第一次**成功**之后才短路」,实现是「第一次**调用**之后就短路」——**两句话只差一个词,语义相反**。一次启动失败(bundle 缺失/损坏,即首次运行未 `build:core` 的场景)就让 vendor init 在本进程内**永久失效**,而唯一的生产调用方 `agentRuntime.ts:640` 把错误吞掉(`console.error` 后服务继续启动),**没有任何用户可见信号**。

**修法**:把 `enabled = true` 移到所有步骤成功之后,或 `try/finally` 失败回滚。
⚠️ **副作用必查**:现在 `enabled` 顺带挡了并发调用。改成「成功后才置位」需要引入 in-flight promise——**照抄 `agentRuntime.ts:187-194` 的 `initPromise` 写法,那里已经是对的**。

---

## 三、建议执行顺序

```
第 1 批(立即)  批 1 授权围栏            1 条 S1,越权写 + 无上界穿越,本场最严重
              批 2 数据目录收敛        2 条 S1 + 1 条 S3,一次收口 11 处
   └─ 这两批都是「用户无从察觉且不可逆」,且都有 E3a/E3b 实证支撑

第 2 批        批 8 的 tc-001(通知静默销毁,唯一 S2 且修法明确)
              批 4 进程与子进程        2 条 S2,孤儿进程 + 进程崩溃

第 3 批        批 3 跨会话状态          1 条 S2 + __zaiCurrentSessionId 三处消费者
   └─ 与批 2 独立,但同属「状态所有权」治理

第 4 批        批 5 契约与 schema       1 条 S2 + 2 条 S3(其中 wb-006 危害收窄)
              批 6 生命周期/队列/资源   2 条 S2 + 4 条 S3

第 5 批        批 7 前端与 UI           4 条 S3,自愈或体验层,搭车做
              批 8 的 wb-r1 + cc-r1    2 条 S3
```

---

## 四、验收纪律

1. **每条修复按 RED→GREEN**:先写一个在修复前**失败**、修复后**通过**的用例或复现脚本,再改代码。复现脚本入库 `docs/bugs/bug-hunt-game-10-16/repros/`,按选手分子目录。
2. **验证环境必须注明运行时**:本场已证明 Bun 与 Node 在同一处修复上表现不同(上一届 oc-002);本仓库的产品运行时是 **Node v22.22.3**(`dev` 走 tsx + bun-protocol loader),`dev:bun` 是可选快速路径,**不能代表用户**。
3. **涉及 `~/.zai/` 的验证必须隔离**:`ZAI_DATA_DIR=/tmp/xxx/zai-home`,否则批 2 的修复本身就可能写坏用户数据。
4. **起服务必须换端口**:`lsof -i :<port>` 确认后用 8101/7715 之类,**禁止碰 9201**。
5. **core 改动后必须 `pnpm run build:core`** 再验证,否则测的是旧产物。

---

## 五、两条不该丢的观察

### 1. 本场 23 条待修里,13 条落在两个簇

**「跨会话状态」(cc-002、cc-003、cc-004、wb-011)与「状态注册表生命周期」(cc-006/wb-003、oc-003、wb-007、wb-004)**。

这与上一届 opencc 的核心发现**同构**:上一届 29 个缺陷里 10 个收敛到「mods 状态按名存在多个注册表,而移除路径只清了其中几个」。本场在另一个代码库得到同一答案——`abortAll(reason, sid)` 是 2026-10-05 刚补的第三道防线,而 cc-002 从**写入端**把 sid 写错、cc-001(归档)从**删除端**绕过 sid。

**两个仓库、两届比赛、同一类设计缺陷。** 这不像巧合,而是「多个各自独立的状态容器 + 单一的清理/过滤点」这个模式在 agent 运行时代码里的系统性复发性。

> **建议把「跨会话状态的写入端与失效端必须同源」当成一条架构级约束去处理,而不是继续一条条修。** 具体形态:任何跨会话/跨任务的状态,它的**写入方**与**失效方**必须在同一个抽象里,不允许一个走进程级全局、另一个走 ALS。

### 2. 这次比赛找到的不是 23 个孤立的 bug,而是 3 个重复出现的设计缺口

| 缺口 | 本场实例 | 上届实例 |
|---|---|---|
| **注释不是防线** | `sse.ts:9-12` 的 EPIPE 注释被本仓库实测否证 3 次,wb-002 仍据此推出 S1;`safePath.ts:10-17` 的「只读故已缓解」在 `fs.ts` 加入写删后失效(已知条目 #16);`taskListStore.ts:289` 的注释声称的注入从未发生(tc-002) | oc-006、wb-004 |
| **同一威胁多条车道,只修一条** | `sse.ts` 加了 EPIPE 防护而 `stream.ts` 没加(though 两边都无效);`/fs/raw` 加了 nosniff/CSP 而壁纸端点没加(oc-002);`ssrfGuardedLookup` 挂在主路径而 fallback 裸 fetch(wb-010) | wb-r01 的 renderTap 缓存不在任何清理路径 |
| **前缀检查冒充完整校验** | `sessionId.startsWith('sess-')` 当作「validate the shape」(wb-001);`writableEnded` 当作连接存活检查(实测 destroyed 时它仍为 false) | — |

> **这三条都不是「再加一个检查」能解决的。** 建议作为代码评审的固定检查项:① 注释里的安全/行为前提,必须有对应测试或类型约束;② 修一个威胁时,用 `grep` 列出全部同威胁写点再动手;③ 任何「校验」都要问「它挡住的输入形状是不是真的被挡住了」。
