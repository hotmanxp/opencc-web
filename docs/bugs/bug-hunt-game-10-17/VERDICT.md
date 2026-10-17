# VERDICT · bug-hunt-game-10-17

> 裁判 = zai(本场裁判兼赛场主人,不参与环节一、二)
> 基准提交 `31fca1d2`(`main`) · 2026-10-17 · 双人赛(选手:`opencc` / `claude`)
> 完整赛果与裁定卡见 [`ANNOUNCEMENT.md`](./ANNOUNCEMENT.md);对上一届修复战役的勘误见 [`ERRETA.md`](./ERRETA.md)

---

## 一、终裁总表

**5 条正式声明 + 2 条评审期新发现 = 7 条,全部裁定完毕。**

| ID | 作者 | 自报 | 终裁 | 证据 | 计入分 |
|---|---|---|---|---|---:|
| oc-001 | opencc | S2/E3a | **PARTIAL S3** | E3a | 3.0 |
| oc-002 | opencc | S2/E3b | **CONFIRMED S2** | E3b | 6.0 |
| cl-001 | claude | S3/E3a | **CONFIRMED S3** | E3a | 3.0 |
| cl-002 | claude | S2/E3a | **PARTIAL S3** | E3a | 3.0 |
| cl-003 | claude | S3/E1 | **CONFIRMED S3** | E1 | 1.5 |
| oc-r1 | opencc(评审期) | — | **CONFIRMED S2** | E2 | 计评审分 |
| cl-r1 | claude(评审期) | — | **CONFIRMED S3** | E3b | 计评审分 |

**无 REJECTED、无 KNOWN、UNVERIFIED 清单为空。全场无误杀。**

---

## 二、逐条裁定(裁判逐条打开源码核对)

### oc-001 · `starting` 窗口内 DELETE 实例 → 子进程脱管 → **PARTIAL,S2 → S3**

**机制 100% 成立,行号几乎零偏移(裁判亲自实读):**

| 作者标注 | 裁判实读 | 内容 |
|---|---|---|
| `instanceSupervisor.ts:581` | ✓ `:581` | `if (entry.child) await doStop(id)` —— child 为 null 时**整个 doStop 被跳过** |
| `instanceSupervisor.ts:582` | ✓ `:582` | `entries.delete(id)` |
| `attachChild:339` | ✓ `:339-344` | 直接 `entry.child = child`,**无 `entries.has(entry.def.id)` 守卫** |
| `tickHeartbeat:590-592` | ✓ `:592` | `for (const entry of entries.values())` |
| `shutdown()` | **偏移 6**:作者 `:687` → 实为 **`:693`** | 同样 `for (const entry of entries.values())` |
| `routes/instances.ts:306` | ✓ `:306` | `router.delete('/instances/:id')` **未被** `serializeLifecycle` 包裹 |
| 同文件 `:221`/`:237`/`:260` | ✓ | start / stop / restart **三个动词都有** `serializeLifecycle(req.params.id, …)` |

**决定性的一格。** 上一届 `wb-004` 的修法是把 in-flight promise 锁加进 `doStop` 内部:

```ts
// instanceSupervisor.ts:548-549(在 doStop 里)
const pending = inFlightStarts.get(id)
if (pending) await pending.catch(() => {})
```

**这道新闸只写在 `doStop` 内,而 `doRemove:581` 在 child 为 null 时压根不进入 `doStop`** —— 新闸一次都不会被触达。作者找对了这一格,这是本条最有价值的部分。

**E3a 成立。** 复现物 `/tmp/bughunt-opencc/oc-orphan-remove.test.ts:48` 动态 `await import` 真实 `instanceSupervisor.ts`,注入的是模块自带 DI 接缝(`writeFile` no-op、`probePort` 门、`spawn` 假 child),被测对象本身未被替换。

**§4.7 纪律是全场最好的一份。** 作者**自曝**第一版把三场景塞进同一 vitest 进程,实测跑出 `children spawned : 2` —— 前一场景的 child 醒来后推进了下一场景的数组,对照组被模块级单例污染。他识别出这正是规则 §3.2 坑 6,改为 `SCENARIO` env 一场景一进程后重跑。**三个场景分别隔离「动词」与「时机」两个变量**,只有 `remove`(窗口内 + DELETE)得到 `killed=[false]`。这是「对照组硬性要求」被真正用上的样子。

**降档理由(裁判采信评审方的反驳,修正了自己的初稿):**

裁判初稿写「`offlineBuffer`… 不,本条初稿写「`:17-19` 明文认可 FIFO 截断」——**本条初稿的理由是先写错了对象**,更正如下:

1. **影响主张被更强的复现部分证伪。** claude 抽验时把假 spawn 换成**真 `child_process.spawn`** + `process.kill(pid, 0)` 探活:supervisor 机制 100% 复现(`visibleInSupervisor=0` + `realSpawned=1`),**但那个真进程 200ms 内 `signalCode=SIGINT` 消失**;空转对照(同 worker 里无关真子进程)400ms 仍存活 → 不是 harness 假象。**SIGINT 的发送者至今未查明。**
2. 因此「子进程**无限期存活**、端口被长期占住、退出 zai 也带不走」这个**幅度主张未被证实**。不成立的是幅度,不是机制。

**终裁 S3**:「脱管逃逸」本身是确定的真实缺陷(条目从 `entries` 消失后,`shutdown()` 与 `tickHeartbeat` 两条路径都看不见它,这与进程后来是否自己退出无关);但按当前证据,不能按 S2 计「端口长期被占 + 不可停止的资源泄漏」。**不降到 S4**——逃逸是源码字面事实。

**遗留线索(裁判不下结论)**:那个 SIGINT 是谁发的?若是 vitest worker 收尾而非生产环境,则生产下孤儿进程可能真的存活。**这一格未查清,不影响本裁定,但决定这条将来该不该升回 S2。**

**KNOWN 判定(本场最需要公开裁量的一处):判 NOT KNOWN,照常计分。** 三条理由:

1. 上一届 `wb-004` 的裁定范围明文是「`starting` 窗口内 **stop/restart** 静默 no-op 且返 200」,修法落在 `doStop`。本条是 **DELETE 路由**,走 `doRemove`,**是 supervisor 里唯一不经过 `doStop` 的删除路径**。
2. **失败形态不同**:wb-004 是「静默 no-op + 返 200」(请求没生效);本条是「spawn 出活进程并从 supervisor 视野消失」(请求生效了,后果不同)。
3. **没有任何已知清单文档写过 `doRemove` / DELETE 这条路径**。`docs/bugs/2026-10-05-instance-supervisor-double-spawn.md` 讲的是**双 spawn**(两实例抢端口),不是孤儿进程。

**但连带事实必须公开(→ `ERRETA.md`):** 本条是上一届修复的**残留**,而上一届 `VERDICT.md` 裁定 `wb-004` 已修、修复战役记「已修 16 条」——**在覆盖面上不成立**。

---

### oc-002 · `claude` 被 UI 提供却不在 `preferCliAgent` 枚举内 → **CONFIRMED S2/E3b**

**契约两端逐行核实,行号零偏移:**

| 位置 | 实读 | 内容 |
|---|---|---|
| `superTasks.ts:90` | ✓ | `CLI_AGENT_NAMES = ['opencc', 'claude', 'dsh', 'opencode']`,上方注释 `zai patch (2026-10-17): 加 'claude'` |
| `factorySettings.ts:65` | ✓ | `preferCliAgent: z.enum(['opencc', 'dsh', 'opencode']).nullable().optional()` —— **无 `claude`** |
| `FactorySettingsDrawer.tsx:307` | ✓ | `onChange={(v) => setDraft(… (v ?? null) as Draft['preferCliAgent'])}` —— **`as` cast 压掉编译期检查** |
| `FactorySettingsDrawer.tsx:308-312` | ✓ | `options={agents.map((a) => ({ value: a.name, disabled: !a.active, … }))}` —— **无过滤** |

**E3b 成立**:起隔离实例(8101/7715,先 `lsof` 确认空闲)打真实端点,`claude`→400 且响应体是真实 zod 错误,`opencc`→200,单改 `docsDir`→200。对照组有区分力:两个值都来自同一个 `options` 数组,唯一变量是枚举值本身。§4.2 对 HTTP 缺陷明文要求「起隔离实例打真实端点」即 E3b。

**裁判定性**:这是**新特性引入的缺陷**,出自主线最新一次提交 `7c32e4da feat(zn-agent-core): 拆分 claude / opencc 两个子 agent provider` —— 那次把 `claude` 加进 provider 白名单与注册/探测路径,**却没同步落盘校验的取值域**,而前端一个 `as` cast 让 typecheck 保持全绿。**这是「上一届/本次修复本身是新排查面」这条线索的教科书命中**,正面印证 README §8:typecheck 绿不代表没 bug(本条连 typecheck 证据都不需要)。

**维持 S2**:命中 rubric 明文「API 返回错误结果」;且失败**粘性**(`catch` 只 toast 不回滚 `draft`),一次 400 之后不动下拉框就再也存不了任何工厂设置,同批次 `docsDir`/`repoRoot`/`maxParallelTasks`/`historyArchiveHours` 四项编辑**全部连坐丢失**。不升 S1(不丢既有数据、不越权)。

**评审补充(已核)**:取值域全仓是 **6 处**不是作者说的 5 处 —— 漏了 vendor 侧 `zn-agent-core/src/opencc-src/server/factorySettingsCore.ts:20,53-57` 的同款白名单。**这直接影响作者修复方案 A 的完整性**(只改 zai 侧 5 处会漏掉 vendor 侧)。

---

### cl-001 · `manifest.ts:106` 覆盖 `extractedVersions` → **CONFIRMED S3/E3a**

**逐行核实,行号零偏移:**

- `manifest.ts:106-109` `manifest.packages[pkg] = { latestVersion, cachedAt: Date.now() }` —— **无展开** ✓
- `manifest.ts:132-135` `{ ...existing, extractedVersions: list }` —— **有展开** ✓
- `manifest.ts:156` `{ ...entry, extractedVersions: kept }` —— **有展开** ✓(同一模块三个写点两种写法)
- `manifest.ts:149` `if (!entry?.extractedVersions?.length) return []` ✓
- `extractor.ts:138/139/142-145` 生产序列 ✓(其中 `:139` 是 fire-and-forget `.catch(() => {})`)

**E3a 合法**:复现物 `repro-manifest.mts:22-24` `await import('…/services/manifest.ts')` —— **真模块,非自建副本**(上一届有选手用自建 `new Map()` 冒充被测对象被降档,本条不属于那类)。对照组把嫌疑收敛到单个函数:去掉 `updateCachedVersion` 后,4 个版本 keep=3 恰好 drop 1 个(数学期望),实验组则 4/4 次 drop 0。

**裁判补出的两点作者没写的(均已核实):**

1. **触发面比作者写的大。** `detect.ts:268` `updateCachedVersion(pkg, version).catch(() => {})` 意味着**任何一次 `npm view` 版本检查**都会抹掉索引,不只是插件升级 —— 所以 LRU prune 在实践中几乎恒为 no-op。
2. **还有第二个消费者。** `extractor.ts:154-162` `getCachedExtraction()` 的 `:159` `entry?.extractedVersions?.find(…)` —— 索引被抹 ⇒ 缓存查找**恒未命中** ⇒ 每次都重新解压。功能不坏(只是白做功),但影响面从「磁盘泄漏」扩到「重复解压」。
3. **作者没提的竞态**:`extractor.ts:139` 未 `await`,与 `:142` 的 prune 无序 —— 但**两种交错都导致字段被抹**,作者的顺序化复现得到的是较弱但同向的版本。

**维持 S3**(rubric 原文「错误路径不清理/不释放」正属此类)。不上 S2:不产生错误 API 结果、不跨会话污染。

---

### cl-002 · `OfflineBuffer.setPort()` 零调用 → **PARTIAL,S2 → S3**/E3a

**机制 100% 成立,且比作者的模型更强。裁判核实:**

- `offlineBuffer.ts:69-71` `setPort()` 全仓**零生产调用**。grep 全仓 7 处命中:`:69` 定义本身,其余 6 处(`web/src/pages/Instances.tsx:160,354,628,802,816,817`)全是 React 的 `setPortEditRow` / 局部 `setPort(id, port)`。**作者 grep 结论正确。**
- `aaClient/init.ts:172` `initOfflineBuffer(conn, 0)` —— 字面量 0,全仓唯一调用点。
- `offlineBuffer.ts:14-16` 头部注释明文承诺 per-child 隔离 ✓;`enforceSizeCap:197-223` 从尾部保留、丢弃最老,**完全无 child 归属概念** ✓。

**裁判补上作者没验的可达性一环**:`instanceSupervisor.ts:489-490`

```ts
const childEnv: NodeJS.ProcessEnv = { ...process.env, ZAI_INSTANCE_ID: id, … }
```

子实例**继承父进程全部 env**,故所有 zai 进程解析到**同一个** `aaOutboxPath(0)`。作者的复现是单进程内两个 owner;真实形态是**跨进程**共享同一文件 → 冲突面比作者写的更大。

**降档理由(裁判采信 opencc 的反驳,修正了自己的初稿):**

裁判初稿把「`offlineBuffer.ts:17-19` 明文认可 FIFO 截断」列为下档理由。**opencc 反驳且裁判采纳**:

> 注释 `:17-19` 认可的是**有界降级这个取舍**,而 `:14-15` 恰恰写着 per-child 拆分正是为了让 trim 不波及别人 —— **注释是作者主张之意图的证据,不是免责证据**。

**更站得住的读法。** 下档的唯一依据改为**量级门槛**:

**opencc 补上了裁判没做的那个数字**(裁判只说「需要 50MB」,没量单条多大):

| 通知类别 | 单条字节 | 50MB 可容纳 |
|---|---:|---:|
| `session.state.updated` | 171 B | ~305,805 条 |
| `notice.upserted` | 319 B | ~164,124 条 |
| `timeline.itemUpsert` | 1733 B | **~30,245 条** ← 最重的一类 |

即使取最不利类别也要 **~3 万条**积压才触发第一次跨子实例驱逐;作者实测用的是 `ZAI_AA_OUTBOX_MAX_MB=1`,是生产默认(`offlineBuffer.ts:32-33`)**的 1/50**。

**opencc 还补了作者漏披露的前置条件**:`--aa` 之下还有 `ZAI_AA_ENABLED==='1'` 硬性 opt-in(`cli/index.ts:68/90` 是生产代码唯一写入点),以及**必须已 pairing**(否则 `init.ts:119-126` 早退,buffer 压根不创建)。→ **三层门**。

**E3a 成立**:两个复现物都真 import 生产模块;模块级单例 `resetOfflineBufferForTests()` + 独立进程。

**终裁 S3。** 机制 CONFIRMED,机制甚至比作者写的更强;降的是量级。**作者主动写明 `--aa` 前置,符合 §4.2.1 第②问,故不触发 S4 惩罚。**

---

### cl-003 · 三处解析器仍硬写 `homedir()/.zai` → **CONFIRMED S3/E1**

**三处全部逐字核实(除一处一行偏移):**

| 位置 | 实读 | 内容 |
|---|---|---|
| `compat/permissions.ts:83` | ✓ 零偏移 | `join(homedir(), '.zai', 'settings.json')`,不读 `ZAI_DATA_DIR`;`:95-99` 的 catch **函数体为空** → 读错路径与读到空**行为不可区分**,直接 `return 'default'` |
| `commands/userLoader.ts:26` | ✓ | reader 拼 `join(opts.dataDir, '.zai', 'commands')`(多套一层 `.zai`) |
| `commands/userLoader.ts:27` | **偏移 1**:实为 **`:28`** | `homeClaudeDir = join(home, '.zai', 'commands')` **无条件指向真实 home** |
| `commands/userLoader.ts:39-40` | ✓ | `existsSync` 失败即回落真实 home |
| `ReplHistoryService.ts:162-164` | ✓ | `` `${homedir()}/.zai/repl-history.jsonl` `` **模板串,绕开 `join(homedir(), '.zai'` 的 grep 特征**;`:51` 构造函数一次性捕获 |

**本条真正的价值不在三处硬编码本身,而在 writer/reader 分裂 —— 而这一格作者没意识到它的来历:**

`commands/fileStore.ts:8-11` 的注释白纸黑字:

> `zai patch (2026-10-16, oc-001 收口): 改走 resolveZaiDir(),否则设了 ZAI_DATA_DIR 的实例仍读写用户真实 home 下的用户级命令。`

即上一届的 S1 修复**明确声称收口了「用户级命令」这条路径**,却**只迁了写入端** `commandsDir()`:

- writer:`join(resolveZaiDir(), 'commands')` = `$ZAI_DATA_DIR/commands`
- reader:`join(opts.dataDir, '.zai', 'commands')` = `$ZAI_DATA_DIR/.zai/commands`(不存在)→ 回落真实 `~/.zai/commands`

**写 A 读 B。** 裁判据此把本条定性为**上一届 S1 修复只做了一半的残留**,详见 `ERRETA.md`。

**附带发现**(同文件,作者自己抓到、已核实):`userLoader.ts:33-34` 的 `cwdClaude` 与 `cwdZai` 拼出**完全相同的字符串**,`:35-36` 两个 `existsSync` 判同一个目录 —— 上游 `.claude`→`.zai` 重命名遗留的死分支,`git blame` 指向 2026-08-26 `b08ec5a9`,而 `:17-19` 的文档注释仍在描述重命名前的行为。

**维持 S3**。需 `ZAI_DATA_DIR`(非默认),作者主动写明并**预先接受降档**;§4.2.1 三问齐备。三条里 (c) 最实质(向真实 home **写** + `rotate()` 可能覆盖用户真实 `.1` 文件),(b) 是隔离失效 + 轻度信息越界,(a) 是读错文件致权限模式判定与实例自身配置不符。

---

### oc-r1(评审期新发现)· manifest 撕裂读 → 整份清空 → **CONFIRMED S2/E2**

**裁判核实:**

- `readManifest:64-71` `catch { return { version, updatedAt: 0, packages: {} } }` —— 裸 catch,**任何**错误(含撕裂读的 `JSON.parse` 失败)都返回**空 manifest**
- `writeManifest:76-80` `:79` 裸 `writeFile(...)` —— **非原子写**,无 tmp+rename

**后果链**:读撞上非原子写中间态 → JSON 撕裂 → catch 吞掉 → 返回空 manifest → 下一次写在这个空对象上赋值并写回 → **整份 manifest 被清空**,所有插件的 `extractedVersions` + `latestVersion` 一起没 → 全量重新解压 / 重查 registry。

**裁判比作者更保守地压了一档证据。** 他实测的是「**构造**出的撕裂态 → 整份清空」(证明了后果),而「真实并发访问**产生**撕裂态」(触发条件)只做了静态论证。故裁 **E2** 而非 E3a,注明:补一个真实竞态 harness 可升 E3a。

**严重度 S2**:manifest 是派生的缓存/索引,整份丢失导致全量重解压,不构成丢用户数据,故不上 S1;但触发面是常态(`detect.ts:268` 与 `extractor.ts:139` 两处 fire-and-forget 写 + 每次 `getCachedVersion` 的读),不按 S3 计。

**计分**:`主动新发现` 按 `S×0.5` = **3.0**。

---

### cl-r1(评审期新发现)· tier-2 无条件读真实 `~/.claude/` 并回写实例目录 → **CONFIRMED S3/E3b**

**裁判核实(比作者自己写的更重):**

- `zaiSettingsCache.ts:161` `tier2 = await tryReadSettings(claudeSettingsPath())` —— **读用户真实 `~/.claude/settings.json`,完全不感知 `ZAI_DATA_DIR`**
- `:166` `settings = tier2 ?? BUILTIN_DEFAULT_SETTINGS` —— tier2 盖过内置默认
- `:174-176` `if (settings.permissions === undefined) { …; await writeZaiSettings(settings) }` —— boot 期**自动写**

**关键更正:这不只是读泄漏,是「复制」。** 隔离实例的 tier-1 缺 `settings.json` → 走 tier-2 读到**真实 home 的内容** → boot 回填把它**写进隔离目录的 `settings.json`**。真实 home 的配置内容被搬进了隔离实例。

**为什么它会让 `/api/super-tasks/spawn-agents` 报 `registered:true`:** 该端点遍历 `CLI_AGENT_NAMES` 逐个探测,注册状态的判定最终落到这份被污染的 settings;作者的机器上真实 `~/.claude/settings.json` 恰有 `dsh` / `opencode` 两个 `subagents` key,而隔离目录里连 `settings.json` 都不存在。**机制可推广**:任何在 `~/.claude/settings.json` 里注册过 dsh/opencode 子 agent 的用户都会命中。

**S3 而非更高**:需 `ZAI_DATA_DIR`(非默认);后果是配置串味进隔离实例,**写落点是隔离目录而非用户真实文件**,不构成对真实数据的破坏。

**与 cl-003 的关系**:同一族(数据目录隔离),但**不同机制** —— cl-003 是路径解析疏忽,cl-r1 是一条**故意设计的跨工具回退链**忘了感知隔离。判独立缺陷,不判 DUPLICATE。

**计分**:`主动新发现` 按 `S×0.5` = **1.5**。

---

## 三、计分

### 发掘分(70)

```
单条得分 = 严重度基数 × 证据系数(S1=10 S2=6 S3=3 S4=1;E3b/E3a=1.0 E2=0.8 E1=0.5)
```

| 选手 | 逐条 | 发掘分 |
|---|---|---:|
| **opencc** | oc-001 3×1.0=3.0 · oc-002 6×1.0=6.0 | **9.0 / 70** |
| **claude** | cl-001 3×1.0=3.0 · cl-002 3×1.0=3.0 · cl-003 3×0.5=1.5 | **7.5 / 70** |

E0 占比:两家均为 **0%**(红线 50%)。严重度虚报罚则:**均未触发**。

### 评审分(30)

| 项 | 满分 | opencc | claude |
|---|---:|---:|---:|
| 裁决正确率 | 15 | **6.0**(3 条全一致) | **4.0**(2 条全一致) |
| 抽验质量 | 7 | **7.0**(4 条,全自建复现物) | **7.0**(4 条,含一次自曝失败实验) |
| 主动新发现 | 5 | **3.0**(oc-r1,S2) | **1.5**(cl-r1,S3) |
| 交叉洞察 | 3 | **0.9**(oc-r2,S3) | **2.7**(cl-r2 0.9 + 取值域第 6 处 1.8) |
| **小计** | 30 | **16.9** | **15.2** |

### 总分

| 名次 | 选手 | 发掘 /70 | 评审 /30 | 总分 /100 |
|:-:|---|---:|---:|---:|
| **1** | **opencc** | **9.0** | **16.9** | **25.9** |
| **2** | **claude** | **7.5** | **15.2** | **22.7** |

---

## 四、互评裁决逐条比对

| 被裁条目 | 评审判决 | 裁判终裁 | 判定 |
|---|---|---|---|
| cl-001 | opencc: CONFIRMED(S3) | CONFIRMED S3 | **一致** |
| cl-002 | opencc: **PARTIAL(S2→S3)** | PARTIAL S3 | **一致**(连下档理由的落点都独立收敛到量级门槛) |
| cl-003 | opencc: CONFIRMED(S3) | CONFIRMED S3 | **一致** |
| oc-001 | claude: CONFIRMED(但「幅度主张要求收敛」) | PARTIAL S3 | **一致(裁判裁量)** |
| oc-002 | claude: CONFIRMED(S2) | CONFIRMED S2 | **一致** |

**oc-001 一条是裁判的临场裁量,已公开记录并列入申辩期。** §6.2 的判定表只写了 `REJECTED`↔`PARTIAL` 的对称豁免,**未覆盖 `CONFIRMED`↔`PARTIAL`**。claude 的**标签**是 CONFIRMED,但**理由**明写「机制是源码字面事实,裁决不变,但幅度主张要求收敛」并把幅度问题移进交叉洞察 —— 实质上就是 PARTIAL。裁判按表**精神**判一致;若按表**字面**则应扣 2 分,opencc 与 claude 的名次不受影响(opencc 本就领先 3.2 分)。

**→ 规则提案(下届)**:判定表补一条通则 ——「评审标签与评审理由实质不一致时,以理由为准」。

**行号核实(§6.2 扣分项)**:裁判复核两位评审各自引用的行号。

- opencc 的 4 处更正**全部改对**:`manifest.ts:37`→`:42`、`offlineBuffer.ts:61-63`→`:64-67`、`userLoader.ts:27`→`:28`,以及指出 claude 把 `routes/commands.ts` 的调用写成 `defaultCommandsDirs`(实际是 `reloadUserCommands`,链仍成立但少一跳)。**裁判抽查 3 条全对 → 不扣分。**
- claude 标出 opencc 的 3 处偏移(`:635`→645、`:643`→648、`:687`→688)经裁判复核**均成立**,并明确「缺陷逻辑本身零偏移」。**不扣分。**
- 环节一两位选手的行号合计偏移 3 处(均为 1~6 行的轻微偏移,不影响任何结论),**未触发扣分**。

---

## 五、裁判自查(公开本场的四处裁量与两处规则缺陷)

**裁量 1 · oc-001 判 PARTIAL 而非 CONFIRMED。** 幅度主张被更强的复现部分证伪(真进程 200ms 内收到来源不明的 SIGINT)。我不判 REJECTED —— 机制是源码字面事实;也不判 CONFIRMED —— 幅度没被证实。

**裁量 2 · oc-001 判 NOT KNOWN。** 它与上一届 `wb-004` 同族,但动词、路由、失败形态、代码位置四项全不同,且没有任何已知清单文档覆盖 `doRemove` 路径。

**裁量 3 · oc-r1 压到 E2**(作者自评 E3a 形状)。理由:实测证明的是后果,触发条件只做了静态论证。

**裁量 4 · oc-001 的互评判「一致」**(见 §四)。这是本场唯一一处表格未覆盖的临场裁量。

**规则缺陷 1 ·「裁决正确率」这一栏在两人赛里结构性缩水。** 满分 15、每条 2 分,但两人赛的评审对象只有 1 份报告、2~3 条。**opencc 的可达上限是 6.0,claude 是 4.0** —— opencc 之所以在这一栏领先 2 分,**纯粹是因为他要判的条目多一条**,与判断质量无关。两人受影响相同,故不影响名次,但该栏在本场实际只发挥了 1/3 的区分度。**→ 下届:两人赛必须按条目数归一化,或把该栏分值按 `min(15, 2×对方条目数)` 设定。**

**规则缺陷 2 · §4.2.1 的第②问被一名选手读反了,而这是规则表述的问题,不是他的错。** 规则只写了「E1 条目答不出第②问 → 按 S4 计」,**没有写「需要非默认开关的条目不该报」**。opencc 据此把两条 `aaClient` 机制成立的线索丢进自我否定清单,理由是「`--aa` 默认 local-only,这正是上届 `wb-010` 塌掉的方式,我不想重复」。

**裁判判定:这条规则的本意恰恰相反。** 第②问是「**如实标注**」,把「不可达」转成「可达但需开关」——**降的是严重度,不是资格**。claude 报了同一片代码并在第②问里明写「需要 `--aa`、默认不触发」,于是照常计分(降档到 S3);opencc 没报,0 分。**同一片代码、同样的机制判断,两家因对规则的不同理解拿到了完全不同的结果。**

**→ 下届:§4.2.1 必须加一句显眼的话 ——「第②问是如实标注,不是自我豁免;只要如实写明开关与门槛,条目仍然成立」。**

---

## 六、本场一条值得带走的对称事实

**两位选手各自把一条自己抓到但不敢报的线索,留给了对方。**

- **claude** 在环节一抓到「`detect.ts:268` 的 fire-and-forget 写会让 `readManifest` 读到截断文件、裸 catch 返回空 manifest、整个版本缓存被清空」,但自认「**没有构造出能稳定复现的时序,也没有实测**」→ 放进自我否定清单。**opencc 在环节二把它作为 oc-r1 正式报出并计了 3.0 分**,理由是「后果链本身确定性可证,说未验证过于保守」。
- **opencc** 在环节一抓到 `aaClient` 离线通知链的机制问题,但按 §4.2.1 第②问自我放弃 → 放进自我否定清单。**claude 在环节一就报了同一条(即 cl-002)**,因为它把第②问读成「如实标注」而非「放弃」,降档后照样计分。

**两处都不是「谁更聪明」的差别,是对同一条规则的不同理解。** 而自我否定清单的诚实披露,让对手能把它捡起来变成正式条目 —— **这个机制在本场跑通了**,这是它存在的意义。

---

## 七、申辩条款

裁定如有错判,可申辩,裁判复核后修正并**公开记录修正过程**。有效申辩需 ①具体的 `file:line`;②可复现证据(命令 + 真实输出,或精确的调用链推演)。只提交「我不同意」不构成申辩。**本场公开四处裁量(§五)供申辩。**

§四 oc-001 的「一致」裁量与 §五的规则缺陷 1、2 是最可能被申辩的三处。
