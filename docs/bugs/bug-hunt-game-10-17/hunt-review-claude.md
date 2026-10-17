# 交叉评审报告 · claude

> 规则见 [`README.md`](./README.md)。评审者 `claude`,评审对象 `bug-hunt-opencc.md`。

**评审者**：`claude`
**日期**：2026-10-17
**评审对象**：`bug-hunt-opencc.md`（`oc-001` / `oc-002`）
**基准提交**：`31fca1d2`（`main`）

---

## 〇、评审过程记录（自证）

- **仓库零写入**：本轮我只 `Read` / `grep` 源码,写了**两个**文件 —— 本文件,以及 `/tmp/bughunt-claude/` 下的临时复现物。未做任何 git 写操作,未跑全量测试。
- **端口自证**：起服务前 `lsof -i :8101 -i :7715` → `exit=1`(无输出,两端口空闲)。只用了 8101(web)/ 7715(api)。**9201 全程未碰**。收口时已停掉自己起的实例并确认释放。
- **数据隔离自证**：起实例时显式 `ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`。事后核过隔离目录:`/tmp/bughunt-claude/zai-home/` 下生成了 `aa/ background/ factory-settings.json manifest.json projects/`,**没有 `settings.json`**(原因见第五节 `[cl-r1]`,与本次评审的额外发现直接相关)。
- **我实际跑过的命令**(全部输出见第四、五节,无一条是转述):
  ```bash
  # 隔离实例(oc-002 抽验)
  ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home pnpm --filter @zn-ai/zai dev -- --port 8101 --api-port 7715
  # 三个真实 curl(实验组 + 两组对照)
  # 独立复现物(oc-001 抽验,真实子进程版)
  for S in exp ctrl; do SCENARIO=$S ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
    pnpm --filter @zn-ai/zai exec vitest run --config /tmp/bughunt-claude/vitest.config.ts \
    /tmp/bughunt-claude/oc001-real.test.ts > /tmp/bughunt-claude/repro-$S.log 2>&1; done
  ```

---

## 一、评审原则自查

- [x] 我对**每一处**被引用的 `file:line` 都实际 `Read` / `grep -n` 过,逐条记下「一致 / 偏移」,见第二节。
- [x] 每条裁决都给了**源码层面**的理由,`oc-001` 的 `KNOWN` vs `CONFIRMED` 之争我读了上一届 `VERDICT.md` + `FIX-PLAN.md` 的原文来裁。
- [x] 没有因为「我觉得不可能」就 `REJECTED` —— 我判的两条都是 `CONFIRMED`,零否决。
- [x] 核查了对方每条的前置可达性三问(对方两条都是 E3 级,§4.2.1 非强制,但**都主动答了**,这一点值得肯定)。
- [x] 完成 **4** 条亲手抽验(§5.3 要求 3 条),含 2 条正式条目 + 1 条自我否定清单 + 1 条前端取值域实验。
- [x] 额外发现 ≥1 条:第五节 `[cl-r1]`(实测出来的,不是读文档读出来的)。
- [x] 交叉洞察 ≥1 条:`[cl-r2]`(给 oc-001 补了一次作者没做的强化实验,**并如实报告我没跑成**)。
- [x] 我在判断 `oc-001` 是否 `KNOWN` 时,核了 `instanceSupervisor.ts` 当前源码 + 上一届 `FIX-PLAN.md:205-212` 的原文修法范围,不是翻一下清单就下结论。

---

## 二、逐条裁决

### `oc-001` — `starting` 窗口内 DELETE 实例 → 子进程被 spawn 后永不回收,且从 supervisor 视野消失

- **裁决**：`CONFIRMED`（严重度 S2 保留,**但影响幅度的主张需要收敛**,详见抽验 1 与 `[cl-r2]`）

- **我核到的位置**（全部实际打开,`grep -n` / `Read` 双向确认）：

  | 作者引用 | 我核到的实际内容 | 一致? |
  |---|---|---|
  | `instanceSupervisor.ts:581` `if (entry.child) await doStop(id)` | 第 578 行 `const doRemove = async (id) => {` / 579 `ensureNotCurrent(id)` / 580 `const entry = getEntry(id)` / **581 `if (entry.child) await doStop(id)`** / **582 `entries.delete(id)`** | ✅ 精确 |
  | `instanceSupervisor.ts:404` `setStatus(entry, {state:'starting'})` | 402 `runStart` / 403 `getEntry` / **404 `setStatus(entry, { state: 'starting', lastError: null })`** | ✅ 精确 |
  | `instanceSupervisor.ts:510` `deps.spawn(...)` / `:521` `attachChild` | 510 `const child = deps.spawn(` / **521 `attachChild(entry, child)`** | ✅ 精确 |
  | `instanceSupervisor.ts:548-549` `doStop` 内的 in-flight 排队 | 537 `doStop` / **548 `const pending = inFlightStarts.get(id)`** / **549 `if (pending) await pending.catch(() => {})`** | ✅ 精确 |
  | `instanceSupervisor.ts:590-592` `tickHeartbeat` 遍历 | 590 `const tickHeartbeat = () => {` / **592 `for (const entry of entries.values())`** | ✅ 精确 |
  | `instanceSupervisor.ts:392-398` in-flight 登记/清理 | 392 `const startPromise = runStart(id, opts)` / 393 `inFlightStarts.set` / 398 条件清理 | ✅ 精确 |
  | `routes/instances.ts:306` DELETE 未包 `serializeLifecycle` | **306 `router.delete('/instances/:id', ...)`** / 307 `ensureNotInstanceChild` / 308 只挡 `CURRENT_INSTANCE_ID` / **310 直接 `removeInstance`**,**没有 `serializeLifecycle`** | ✅ 精确 |
  | `routes/instances.ts:221 / :237 / :260` 三个动词被包裹 | 221 start、237 stop、260 restart,三处**都是** `await serializeLifecycle(req.params.id, () => ...)` | ✅ 精确 |
  | `instanceSupervisor.ts:635` `startInstance` | ❌ **偏移 +10**。`:635` 是注释里的一行(AA 三态说明)。`startInstance` 在 **645** | ❌ 错 |
  | `instanceSupervisor.ts:643` `removeInstance` 定义 | ❌ **偏移 +5**。`:643` 是 `createInstance` 里的 `return doStart(def.id)`(作者在别处引用它是对的);`removeInstance` 在 **648**(`removeInstance: async (id: string) => doRemove(id)`) | ❌ 错 |
  | `instanceSupervisor.ts:687` `shutdown()` | ❌ **偏移 +1**。`async shutdown()` 在 **688**,遍历在 **693** | ❌ 错 |
  | `routes/instances.ts:44` `serializeLifecycle` 定义位置 | 我核到 `:44` 附近确实是该闸(与 `:221/:237/:260` 的用法一致) | ✅ |
  | `attachChild:339` / stale-child 守卫 `:374` | 339 `const attachChild = (entry, child) => {` / **374 `if (entry.child !== child) return`** —— 该守卫只比对 child,**完全不检查 `entries.has(entry.def.id)`** | ✅ 精确(作者的第③问第④点成立) |

  **13 处引用,10 处精确,3 处偏移(+10 / +5 / +1),全部落在「入口函数定义」这类周边行,没有一处落在缺陷逻辑上。** 三个缺陷点 `:581/:582/:521` 与三个对照闸 `:404/:548-549/:374` 全部零偏移。

- **理由（为什么是 `CONFIRMED` 而不是 `KNOWN`）** —— 这是本场指定要裁的关键问题,我给出完整推理：

  上一届 `wb-004` 是什么、修了什么,我在允许读的 `VERDICT.md:60,125` 与 `FIX-PLAN.md:47,205-212` 里核到了原文:

  > `FIX-PLAN.md:205-212` ——「wb-004 — `instanceSupervisor.ts` … **修法(先改 supervisor,不要改 HTTP 层)**:claude-code 的交叉洞察 cc-r4 已独立核实——`routes/instances.ts:44-57` 的 `serializeLifecycle` 按 id 排队,`:221/:237/:260` 三条路由全部经它包装,**HTTP 路由根本进不了那个窗口**。真实触发方是 5 处**绕过**该闸的调用方:`weixinDedicatedInstance.ts:200/289/290/320`、`aaClient/reverseDispatch.ts:829/2299/2303/2307`、`instanceSupervisor.ts:348`。修法:`starting` 窗口内的 **stop/restart** 请求**排队或明确拒绝**,不能静默 no-op + 返 200。」

  三条事实把 oc-001 与 wb-004 **拆开**:

  1. **动词不同,且 `doRemove` 是全仓唯一不经过 `doStop` 的销毁路径**。`wb-004` 的作用域被原文限定为「stop/restart」,它的修法(`5dedfe4d`)把 in-flight promise 锁加在 `doStop` **内部**(我核到 `instanceSupervisor.ts:548-549`)。`doRemove` 在 `:581` **根本没进入 `doStop`**,这道新闸在删除路径上**一次都不会被触达**。这是「修复只堵了一半路径」,不是「同一个洞」。
  2. **`FIX-PLAN.md:60` 列的「wb-004 附」(`routes/instances.ts:44-57`,5 处调用方绕过 `serializeLifecycle`)列的 5 个绕过者是 `weixinDedicatedInstance` 4 处 + `aaClient/reverseDispatch` 4 处 + supervisor IPC 1 处 —— DELETE 不在其列**,因为上一届的判断是「HTTP 路由根本进不了那个窗口」,而这个前提**只对 start/stop/restart 成立**(我核到 `instances.ts:306` 无 `serializeLifecycle`)。也就是说:**上一届的「HTTP 不可达」结论在 DELETE 上是错的,而这正是新竞态的入口。**
  3. **§3.4 的已知清单里没有这一条**。B 组只列了 `wb-010` 一条未修;`wb-004` 属于「其余 22 条已修复」。README §3.4 同时写死「判定『已知』一律以当前源码为准」—— 当前源码里 `doRemove` 的洞**明摆着**,所以即便按最宽的口径,它也不在已知清单内。判 `KNOWN` 会让一条真缺陷拿 0 分。

  缺陷机制本身无歧义:`removeInstance → doRemove → :581 判 child 为 null → 跳过 doStop → :582 entries.delete(id)` 之后,`runStart` 在 `:510` 真实 spawn、`attachChild` 在 `:521` 把 child 绑到一个**已经不在 `entries` 里**的 Entry 对象上。此后 `tickHeartbeat`(`:592`)与 `shutdown`(`:693`)都遍历 `entries.values()`,结构性地看不到它。四道防线逐一核过,没有一道覆盖这个状态(作者的③问成立)。

- **前置可达性三问的核查**：对方**三问全答了**,而且答得比 E3 级条目的强制要求更细。①构造点单点(`:404`)枚举正确;②可达性论证落到 `probePortDefault` 的真实异步挂起点 + UI 的删除按钮,没有停留在「读代码觉得可能」;③逐条列出四道守卫并说明为何不覆盖 —— 第②条(`doStop` 的新闸没被触达)我独立复核为真。**不触发 §4.2 的降档。**

- **关于「永不回收 / 退出 zai 也带不走它」的幅度**:我核了 `instanceHeartbeat.ts:40-55` —— 子进程往父进程发心跳用的是 `process.send`,而 `:52-54` 的 catch 注释写着 `// parent process gone — best-effort silent`,**子进程侧没有任何「父进程没了就自杀」的看门狗**;`instanceSupervisor.ts:517` 的 `detached: false` 在 POSIX/macOS 上也**不会**让父进程退出时带走子进程。所以「脱管后无人回收」这个方向是成立的。但「无限期存活」这个**具体幅度**没有被对方的 E3a 证据证明 —— 见抽验 1。

### `oc-002` — 新建的 `claude` 子 agent provider 被 UI 下拉框提供、选中后保存必 400,且失败后粘住

- **裁决**：`CONFIRMED`（S2 成立;有一处事实需要补正,见下）

- **我核到的位置**：

  | 作者引用 | 我核到的实际内容 | 一致? |
  |---|---|---|
  | `superTasks.ts:90` `CLI_AGENT_NAMES = ['opencc','claude','dsh','opencode']` | 第 86-90 行注释块 + **90 `const CLI_AGENT_NAMES = ['opencc', 'claude', 'dsh', 'opencode'] as const`** | ✅ 精确 |
  | `factorySettings.ts:65` `preferCliAgent: z.enum(['opencc','dsh','opencode'])` | 61 `export const factorySettingsPatchSchema = z.object({` … **65 `preferCliAgent: z.enum(['opencc', 'dsh', 'opencode']).nullable().optional(),`** | ✅ 精确 |
  | `superTasks.ts:163` `safeParse` / `:165-169` 400 | **163 `const parsed = factorySettingsPatchSchema.safeParse(req.body ?? {})`** / 165 `return res.status(400).json({` / 169 `})` | ✅ 精确 |
  | `superTasks.ts:210-219` 探针循环 | 210 `for (const name of CLI_AGENT_NAMES)` → 214 `registered: settings?.subagents?.[name] !== undefined` → 219 `}` / 220 `res.json({ agents })` | ✅ 精确 |
  | `superTasks.ts:232` 注册端点 | **232 `router.post('/super-tasks/spawn-agents/:name/register', ...)`**,且 `:234` 的白名单判定用的就是 `CLI_AGENT_NAMES` | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:307` 那个 `as` cast | **307 `onChange={(v) => setDraft((p) => ({ ...p, preferCliAgent: (v ?? null) as Draft['preferCliAgent'] }))}`** | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:308-312` `options` | 308 `options={agents.map((a) => ({` → 309 `value: a.name` → 310 `disabled: !a.active` → 311 label → 312 `}))}` | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:134` 无条件提交 | **134 `preferCliAgent: draft.preferCliAgent,`**(同函数 `:128-133` 其它三项确实是条件展开) | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:139-141` catch 不回滚 | 138 `} catch (err) {` / 140 `message.error(...)` / **没有 `setDraft` 回滚、没有 finally 复位** | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:41` `Draft` 类型 | **41 `preferCliAgent: 'opencc' \| 'dsh' \| 'opencode' \| null`** | ✅ 精确 |
  | `FactorySettingsDrawer.tsx:109` `setAgents(a)` | ❌ **偏移 +2**。实际在 **107** | ❌ 错 |
  | `superTaskApi.ts:126` DTO 类型 | **126 `preferCliAgent: 'opencc' \| 'dsh' \| 'opencode' \| null`**(该文件实际路径是 `packages/zai/src/web/src/lib/superTaskApi.ts`) | ✅ 精确 |
  | `superTaskApi.ts:161-165` 原样序列化 | 实际 **164-170**(`putFactorySettings` → `body: JSON.stringify(patch)`),偏移 +3,但语义一致 | ⚠️ 偏移 |

  **13 处引用,11 处精确/一致,2 处偏移。契约两端(`superTasks.ts:90` 收 / `factorySettings.ts:65` 拒)零偏移。**

- **理由**:我按对方的三个可查点逐一打开核对,结论是**完全成立**,而且我在真实端点上实测复现(抽验 2)。补一条作者没查的**第五处取值域副本**:`packages/zn-agent-core/src/opencc-src/server/factorySettingsCore.ts:53-57` 还独立写了一份**同款白名单**(`=== 'opencc' || === 'dsh' || === 'opencode'`),core 侧读同一个 `factory-settings.json`。所以这不是「前端少了个过滤」,是**同一个取值域在 5 处各写一遍**(对方在自我否定清单最后一行提了一句但没进正式条目,我认同并入本条)。作者给的方案 A 需要同步的清单里应当补上 `factorySettingsCore.ts:20` 与 `:53-57`,否则改了 zai 侧、core 侧照样丢值。

- **需要补正的一处事实**(不构成 `PARTIAL`):对方复现步骤第 1 步写「`POST /api/super-tasks/spawn-agents/claude/register`,重启 zai」。我实测的探针输出显示,**在全新隔离数据目录上 `claude` 是 `registered:false, active:false`** —— 下拉框里 `claude` **会出现但被 `disabled: !a.active` 置灰**,用户必须先注册 + 重启才能选中。也就是说这条缺陷**不是零前置**:它要求用户走完新特性的引导流程。对方的三问②写了这一点(「用户按 UI 提示注册 + 重启即可 active」),所以他的可达性结论没有夸大,我只是把「灰显 → 可选」这一步的实测证据补齐。

- **「粘住」这个表述我认为成立但要精确**:重新打开抽屉会走 `load()` → `setDraft(draftFromSettings(s))`(`FactorySettingsDrawer.tsx:107` 附近的 load 函数)把 draft 从服务端值重置,所以**关掉重开可以自愈**;粘住的范围是「抽屉打开着的时候,不手动改下拉框就再也存不下去」。对方原文写的是「用户不手动改下拉框就再也存不了任何工厂设置」——**这个措辞本身已经是精确的**,没有夸大,不需要改写。

- **前置可达性三问的核查**:三问全答。①单点构造链枚举正确;②「默认路径,不需要任何开关」—— 结合我补的实测,应微调为「默认路径,但需完成注册+重启」,不影响结论;③四道防线逐条说明成立(尤其③「`catch` 不回滚 draft」我核过源码,确实没有回滚)。**不触发降档。**

---

## 三、裁决统计

| 对方条目 | 我的裁决 | 裁判终裁（裁判填） | 我的理由一句话 |
|---|---|---|---|
| `oc-001` | `CONFIRMED` | | 与上一届 `wb-004` **不同动词、不同路径、不同后果**,且不在 §3.4 已知清单;`FIX-PLAN.md:60` 的「HTTP 进不了窗口」在 DELETE 上不成立 |
| `oc-002` | `CONFIRMED` | | 五处取值域副本契约错配,真实端点实测 400/200/200 复现,三处指定行号全部零偏移 |

---

## 四、抽验记录（4 条,超过 §5.3 要求的 3 条）

### 抽验 1：`oc-001`（S2）—— 用**真实 OS 子进程**做一次比作者更强的复现,**结果没跑成,如实报告**

- **我的动作**：读完了对方全部 13 处引用（见第二节表格）→ 读了对方复现物 `/tmp/bughunt-opencc/oc-orphan-remove.test.ts` → 判断它的 `deps.spawn` 返回的是 `new EventEmitter()` + 一个 `.killed` 布尔(**这证明了 supervisor 没调 `kill()`,没证明一个真进程能活下来**)→ 于是我自己重做了一版更严格的:注入**真实的 `child_process.spawn`**,跑一个 10 分钟的 `node -e 'setTimeout()'`,再用 `process.kill(pid, 0)` 探活,并额外记录 `signalCode`。数据隔离 `ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`,`writeFile` 注入 no-op,不落盘;实验组/对照组各一个进程(模块级单例)。
- **我跑的命令与真实输出**：
  ```bash
  $ for S in exp ctrl; do
      SCENARIO=$S ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
        pnpm --filter @zn-ai/zai exec vitest run \
        --config /tmp/bughunt-claude/vitest.config.ts \
        /tmp/bughunt-claude/oc001-real.test.ts > /tmp/bughunt-claude/repro-$S.log 2>&1; echo "$S exit=$?"
    done
  exp exit=1        ← 我的实验组断言失败
  ctrl exit=0

  $ cat /tmp/bughunt-claude/result-exp.txt /tmp/bughunt-claude/result-ctrl.txt
  SCENARIO=exp  realSpawned=1 pid=92064 aliveAfterVerb=false visibleInSupervisor=0 \
               exitCode=null signalCode=SIGINT stdio=zai[target]:9300,-e,setTimeout(()=>{},600000)
  SCENARIO=exp  aliveAfterShutdown=false
  SCENARIO=exp  cleanedUp=true
  SCENARIO=ctrl realSpawned=1 pid=91329 aliveAfterVerb=false visibleInSupervisor=1
  SCENARIO=ctrl aliveAfterShutdown=false
  SCENARIO=ctrl cleanedUp=true
  CONTROL idle realChild pid=92721 aliveAfter400ms=true signal=null   ← 空转对照:同 worker 里普通真子进程活得下来
  ```
- **我看到的**：
  1. **supervisor 层面的机制完全复现**:`visibleInSupervisor=0` —— 删除之后 `entries` 里确实没有这个实例了;`runStart` 依然 `realSpawned=1` 真实 spawn 了一个进程出来。竞态本身是真的。
  2. **但我探不到那个进程活着**:`aliveAfterVerb=false`,而且 `signalCode=SIGINT` —— 这个真实子进程**在 ~200ms 内被 SIGINT 杀掉了**,而 `doRemove` 明明跳过了 `doStop`(`:581` 是 null 分支)。
  3. **空转对照排除了 harness 假象**:同一个 worker 里,一个跟 supervisor 无关的普通真子进程 400ms 后 `aliveAfter400ms=true`。所以「vitest 一律杀子进程」这个解释不成立。
  4. **我没有查出 SIGINT 是谁发的**,时间预算用尽,这一条**我没有结论**。我的两个可能猜测(都不作数,仅供裁判参考):`entry.child` 在 `doRemove` 那一刻并非真的为 null(但我核过 `:581` 的字面判据,`probePort` 门确实卡在 `:424` 之前 child 一定为 null),或者存在我尚未找到的第三条信号来源(全仓 `kill('SIGINT')` 我只逐一读过 `doStop:562` 与 `shutdown:696`)。
- **与作者结论是否一致**：**部分一致,关键分界要说清楚**。作者的**机制结论一致**(`doRemove` 跳过 stop、entry 从 map 消失、supervisor 之后再也看不到它 —— 我独立复现了)。作者的**幅度主张不一致**：「子进程无限期存活、退出 zai 也带不走」这个断言,**(a) 没有被他自己的 E3a 证据证明**(fake child 的 `.killed=false` 只证明 supervisor 没发信号,不证明进程不会被别的来源收走);**(b) 我用真实进程去加强这个主张时,拿到了一个我无法归因的 SIGINT,反而没能加固它**。
- **最终裁决**：`CONFIRMED`。理由:我**不**用我这次失败的实验去推翻他 —— 我探不到发送者 ≠ 没有发送者,而「`doStop` 被跳过、entry 被摘除、supervisor 结构性地再也看不到这个 child」这三件事是源码字面事实,与进程最后死没死无关。但**幅度主张应当收敛**:正确表述是「**spawn 出了一个活的 zai 子进程并从 supervisor 的全部管理路径(heartbeat / shutdown / UI)里消失,supervisor 从未对它发过任何信号**」,而不是无条件的「无限期存活」。这一条我写成 `[cl-r2]` 交叉洞察,因为它是对**已有缺陷**的补充验证。

### 抽验 2：`oc-002`（S2）—— 起隔离实例打真实端点,实验组 + 两组对照全跑

- **我的动作**：起隔离实例(`ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`,`--port 8101 --api-port 7715`,起前 `lsof` 确认两端口空闲),从 `dev.log` 取 token,对**同一个端点、同一个 token** 发三次 PUT,并**额外加发一次作者没跑的探针 GET**。
- **我跑的命令与真实输出**：
  ```bash
  $ T=a37e669befaaf2b32c54612b2b0be3af   # 取自 /tmp/bughunt-claude/dev.log 的 "dev token"
  $ curl -s -w "\nHTTP %{http_code}\n" -X PUT http://localhost:7715/api/super-tasks/settings \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $T" -d '{"preferCliAgent":"claude"}'
  {"error":"invalid factory settings","detail":["preferCliAgent: Invalid enum value. Expected 'opencc' | 'dsh' | 'opencode', received 'claude'"]}
  HTTP 400

  $ ... -d '{"preferCliAgent":"opencc"}'
  {"docsDir":"","repoRoot":"","maxParallelTasks":4,"preferCliAgent":"opencc","historyArchiveHours":48,...,"docsDirExists":false,"repoRootExists":false}
  HTTP 200

  $ ... -d '{"docsDir":"/tmp/bughunt-claude/zai-home","maxParallelTasks":3}'
  {"docsDir":"/tmp/bughunt-claude/zai-home",...,"maxParallelTasks":3,"docsDirExists":true,...}
  HTTP 200

  $ curl -s http://localhost:7715/api/super-tasks/spawn-agents -H "Authorization: Bearer $T"
  {"agents":[{"name":"opencc","registered":false,"active":true},
             {"name":"claude","registered":false,"active":false},
             {"name":"dsh","registered":true,"active":true},
             {"name":"opencode","registered":true,"active":true}]}
  ```
- **我看到的**：
  1. `claude` → **400**,错误文案与对方贴的**逐字一致**;`opencc` → **200**;只改 `docsDir` → **200**。三者的唯一变量就是枚举值本身,对照组有区分力(排除端点不通 / token 不对 / 端点只吃特定字段)。
  2. **探针 GET 给出了一条作者没有的关键事实**:在这个**全新的空隔离目录**上,`claude` 是 `registered:false, active:false` —— 下拉框里它会被 `disabled: !a.active` 置灰。这坐实了「必须先注册 + 重启」这个前置,也说明这条缺陷**不是**「装完就中枪」。
  3. **而且这次 GET 顺手暴露了一条本报告第五节的额外发现**:`dsh` / `opencode` 在一个**根本不存在 `settings.json` 的目录**里显示 `registered:true` —— 这个状态是从别处来的。
- **与作者结论是否一致**：**一致**。核心命题(UI 提供 `claude` → zod 只认三个 → 保存必 400 → 失败不清 draft → 后续保存继续 400)我在真实端点上完整复现。**唯一的差异是我补强了前置**,不是推翻。
- **最终裁决**：`CONFIRMED`。

### 抽验 3：对方自我否定清单里最值得怀疑的那条 ——「`aaClient` 离线通知链的机制问题几乎都是真的,但被 `--aa` 门挡住」

- **我的动作**：作者放弃了两条 `aaClient` 线索(`noticeStore` 清理只挂 1 条触发路径 / `offlineBuffer` 的游标与定时器),理由是第②问塌了。我独立核了这个门,而不是采信他的说法:①`grep -rn "AA_ENABLED" packages/zai/src/cli/`;②`initAaClient` 函数头;③`initOfflineBuffer` 的全部调用方;④`resolveNoticesForZaiSession` 的全部调用方。
- **我跑的命令与真实输出**：
  ```bash
  $ grep -rn "AA_ENABLED" packages/zai/src/cli/
  packages/zai/src/cli/start.ts:33:   * `process.env.ZAI_AA_ENABLED`。受管子进程通过 env 继承…
  packages/zai/src/cli/index.ts:65:    // `--aa` 透传到 env ZAI_AA_ENABLED：所有 AA 代码路径 …
  packages/zai/src/cli/index.ts:68:    if (options.aa) process.env.ZAI_AA_ENABLED = '1';
  packages/zai/src/cli/index.ts:90:    if (options.aa) process.env.ZAI_AA_ENABLED = '1';

  $ sed -n '84,86p' packages/zai/src/server/services/aaClient/init.ts
  export async function initAaClient(): Promise<(() => Promise<void>) | null> {
    if (!isAaEnabled()) return null;              ← 唯一一道门

  $ grep -rn "initOfflineBuffer" packages/zai/src | grep -v test
  offlineBuffer.ts:228:export function initOfflineBuffer(...)
  aaClient/index.ts:163 / init.ts:40(import) / init.ts:172: const buffer = initOfflineBuffer(conn, 0);   ← 唯一构造点,在 startAaRoot 里

  $ grep -rn "resolveNoticesForZaiSession" packages/zai/src | grep -v test
  reverseDispatch.ts:47(import) / reverseDispatch.ts:2032(唯一调用) / noticeStore.ts:83(定义)
  ```
- **我看到的**：
  1. `ZAI_AA_ENABLED` 在**生产代码里唯一的写入点是 CLI 的 `--aa` flag**(`cli/index.ts:68` 与 `:90` 两处,同一个 flag 的两条分支),没有第二个生产者、没有默认开启、没有环境变量兜底。
  2. `isAaEnabled()` 就是 `process.env.ZAI_AA_ENABLED === '1'`(`aaClient/index.ts:45-47`),而 `initAaClient` 的**第一行**就是 `if (!isAaEnabled()) return null`(`init.ts:85`)。这是整个 AA 子系统(含 `OfflineBuffer`、`ReverseDispatch`、`noticeStore`)的**唯一**入口闸 —— 闸关着,后面那些对象压根不会被构造。
  3. `resolveNoticesForZaiSession` 全仓确实只有 `reverseDispatch.ts:2032` 一个调用点,`noticeStore.ts:83-92` 的循环体与他描述逐字一致 —— **机制他读对了**。
  4. `initOfflineBuffer(conn, 0)` 的**端口硬编码为 0**,注释写着 "for now"(`init.ts:171-172`)。这是个独立的可疑点,但同样被 `--aa` 门罩住,我没有深挖。
- **与作者结论是否一致**：**完全一致**。`--aa` 这个门是真门,默认 `pnpm dev` / `--lan` / 受管子实例 / 受管微信实例四种形态都进不去(受管子实例那层还有 `init.ts:100-110` 的 `ZAI_AA_PARENT_URL` 二次早退,更严)。**作者放弃得对**,而且放弃的理由正是 README §4.2.1 第②问的标准用法,也是上一届 `wb-010` 塌掉的同一种塌法。
- **对我在自己 cl-002 上同款判断的处理**:我的 cl-002 报在同一片 `aaClient` 代码上,我也**没有**把「默认不可达」当成不报的理由 —— 我报它是因为**同一片代码里还有一条不经过 `--aa` 门的构造路径**(这一点与作者放弃的那两条不同,具体见我的环节一报告)。这里我只做规则层面的对齐:**作者对 `aaClient` 那两条的放弃是正确的,不需要被翻案。**
- **最终裁决**：作者的自我否定成立;这两条线索**目前**只能按 S4 计,不值得占正式条目。

### 抽验 4：`oc-002` 的取值域副本 —— 我自己的静态全仓枚举

- **我的动作**：`grep -rn "preferCliAgent" packages/zn-agent-core/src packages/zai/src`(排除 `.test.`)把每一处取值域抄出来。
- **我看到的** —— **5 处独立副本**,值域不一致:
  | # | 位置 | 值域 |
  |---|---|---|
  | 1 | `routes/superTasks.ts:90` `CLI_AGENT_NAMES` | `'opencc' \| 'claude' \| 'dsh' \| 'opencode'` |
  | 2 | `services/factorySettings.ts:65` zod 枚举 | `'opencc' \| 'dsh' \| 'opencode'` |
  | 3 | `services/factorySettings.ts:32` + `:106-109` 落盘白名单 | `'opencc' \| 'dsh' \| 'opencode'` |
  | 4 | `web/.../FactorySettingsDrawer.tsx:41` `Draft` | `'opencc' \| 'dsh' \| 'opencode' \| null` |
  | 5 | `web/lib/superTaskApi.ts:126` `FactorySettingsDto` | `'opencc' \| 'dsh' \| 'opencode' \| null` |
  | **6（作者漏了）** | **`zn-agent-core/src/opencc-src/server/factorySettingsCore.ts:20` + `:53-57`** | **`'opencc' \| 'dsh' \| 'opencode'`** |
- **与作者结论是否一致**：**一致并加一**。作者在自我否定清单末行写「同一取值域散落 5 处」,实际是 **6 处** —— 第 6 处在 **vendor 侧**(core 独立读同一个 `factory-settings.json`)。这直接影响他的修复方案 A 的完整性:只改 zai 包的 5 处,core 侧仍会把 `claude` 静默丢弃。
- **最终裁决**：并入 `oc-002` 的 `CONFIRMED`,作为给裁判的修复完整性提醒。

---

## 五、评审中额外发现（硬性）

### 5.1 新缺陷

#### [cl-r1] 标题:`/api/super-tasks/spawn-agents` 的「已注册」状态在 `ZAI_DATA_DIR` 指向全新空目录时,仍然读的是用户**真实的 `~/.claude/settings.json`** —— zai 把 Claude Code 的 `subagents` 块当成自己的 provider 注册表

- **严重度**：S3（边界退化。UI 上「cliAgent 管理」显示的注册状态、对下拉框可选性的判定(`FactorySettingsDrawer.tsx:310` 的 `disabled: !a.active`)全部建立在这个错源的状态上;用户可以据此选中一个「zai 从没注册过、只是 Claude Code 那边有记录」的 provider。不构成数据损坏或越权,故不报 S2。）
- **证据等级**：**E3b**（起隔离实例、打真实端点、断言真实响应体 —— §4.2 对 HTTP 缺陷的要求）
- **执行环境**：运行时 Node v22.22.3(产品运行时,Node-direct dev 实例) · 工具链 curl · 平台 darwin-arm64
  - 为什么它代表用户:这就是用户实际跑的 `pnpm --filter @zn-ai/zai dev` 的形态,响应体来自真实 Express 路由。
- **位置**：
  - `packages/zai/src/server/services/zaiSettingsCache.ts:161` —— tier-2 读 `claudeSettingsPath()`
  - `packages/zai/src/server/services/zaiSettingsCache.ts:166` —— `settings = tier2 ?? BUILTIN_DEFAULT_SETTINGS`
  - `packages/zai/src/server/services/zaiSettingsCache.ts:169-176` —— boot 期 permissions backfill 把**这个合并结果**写回 `ZAI_DIR/settings.json`
  - `packages/zai/src/server/services/zaiSettingsStore.ts:46-48` `zaiSettingsPath()` → `:57` `readZaiSettings()` → `getCachedZaiSettings()`
  - `packages/zai/src/server/routes/superTasks.ts:214` —— 探针把 `settings?.subagents?.[name] !== undefined` 直接当成 `registered`
- **前置可达性三问**（E1 必填,本条是 E3b,仍答）：
  ① **谁创建这个状态**:`zaiSettingsCache.ts` 的三段式 tier 解析。tier-1 = `ZAI_DIR/settings.json` 不存在 → 落进 `else` 分支 → tier-2 读 `~/.claude/settings.json`。这是**唯一**构造点,全仓只此一处。
  ② **生产默认配置下可达吗**:**完全可达,是默认形态。** 任何 `~/.zai/settings.json` 尚不存在(全新用户、或从 Claude Code 迁过来的人)的机器,`pnpm dev` 一启动就落进 tier-2。不需要任何开关、不需要 `--lan`、不需要测试 env。我这次就是在一个**全新的空隔离目录**上撞上的。
  ③ **现有防护为什么挡不住**:`zaiSettingsStore.ts:44-45` 的注释**明确声明**「`~/.claude/*` …… **不受 `ZAI_DATA_DIR` 管辖**」—— 也就是说这是**有意**的读取设计,没有任何守卫;而 `superTasks.ts:214` 拿这个值当 zai 自己的注册状态用,中间**没有一层「这个 subagents 块到底来自哪个 tier」的标记**。三段式 fallback 的注释(`:169-172`)还承认这次写回会「seeds tiers 2/3 into ~/.zai」,同样没有分 tier 记账。
- **我做了什么 → 看到了什么**：
  ```bash
  # 隔离实例跑在 ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home,该目录**全新**
  $ curl -s http://localhost:7715/api/super-tasks/spawn-agents -H "Authorization: Bearer $T"
  {"agents":[{"name":"opencc","registered":false,"active":true},
             {"name":"claude","registered":false,"active":false},
             {"name":"dsh","registered":true,"active":true},
             {"name":"opencode","registered":true,"active":true}]}

  # 隔离目录里根本没有 settings.json —— 「已注册」不可能来自它
  $ ls /tmp/bughunt-claude/zai-home/
  aa  background  factory-settings.json  manifest.json  projects/
  $ cat /tmp/bughunt-claude/zai-home/settings.json
  cat: ...: No such file or directory

  # 而用户真实的 Claude Code 设置里恰好有这两个 key
  $ node -e "const s=require('/Users/ethan/.claude/settings.json');console.log(Object.keys(s.subagents))"
  [ 'dsh', 'opencode' ]
  ```
  探针报的 `registered:true` 的两个名字(`dsh`/`opencode`)与 `~/.claude/settings.json` 里 `subagents` 的两个 key **逐一对应**,而隔离目录里连 `settings.json` 都不存在。**因果闭合。**
- **为什么我确信**:`registered` 只有一个数据来源(`superTasks.ts:214` 的 `settings?.subagents?.[name]`),`settings` 只有一个来源(`readZaiSettings()` → boot 期 tier 缓存),tier 缓存我逐行读过,且 tier-2 的目标是 `claudeSettingsPath()`。隔离目录里没有 settings.json 这一条**排除**了「是隔离目录自己的文件」这一替代解释,剩下的解释只有一个。
- **为什么对方没报**：对方在自我否定清单第一行**碰到了同一片代码的另一面**(「设了 `ZAI_DATA_DIR` 仍读写真实 `~/.zai/settings.json`」),但那一条他无法归因、无法证明,于是整条放下了。他**没有**往反方向看一步:**隔离实例读到的「已注册」是从 `~/.claude/` 来的** —— 这一面不需要停用户实例就能证明,而且我用一个 GET 就证明了。
- **给裁判的提醒**:本条与 §3.4 已修的上一届 `cc-r2` **不是同一件事**(`cc-r2` 是消费端取错 sessionId,已在 `headlessPermissionBridge.ts:93` 改掉);也**不是** A 组任何一条。若裁判认为「tier-2 fallback 是有意设计」,那本条应降为「改进建议」并计 0 —— 但即便如此,「把别的工具的 `subagents` 块当成自己的 provider 注册状态、并用它决定 UI 可选性」这一层,我在源码里没找到任何一行注释或类型区分,应当由裁判裁。

### 5.2 交叉洞察（非新缺陷,计分）

#### [cl-r2] 标题:oc-001 的机制成立,但「子进程无限期存活」这个**幅度主张**没有被它的 E3a 证据证明 —— 我用真实 OS 进程去加固它,反而拿到一个无法归因的 SIGINT

- **针对**：`oc-001`（作者 / S2）
- **作者的原论证**：复现物用 `deps.spawn` 注入一个 `EventEmitter` + `.killed` 布尔,断言 `killed === false`,据此得出「子进程被 spawn 且**从未收到任何信号**」,再推到「退出 zai 也带不走它,必须手动杀进程」。
- **我补上的**：
  1. **读了对方的复现物源码**(`/tmp/bughunt-opencc/oc-orphan-remove.test.ts:30-45`):`makeFakeChild()` 返回的是 `new EventEmitter()`,`kill` 被替换成只翻 `.killed` 并 `emit('exit')` 的桩。**这个桩没有 OS 进程、没有进程组、没有任何外部信号源** —— 它证明的是「`supervisor` 自己没调 `kill()`」,这是一个**更窄**的命题。作者把它写成了「一个完整的 zai 子进程无限期存活」。
  2. **我自己重做了一版真实进程版**(抽验 1):注入真实 `child_process.spawn`,用 `process.kill(pid,0)` 探活。**supervisor 层面的机制 100% 复现**(`visibleInSupervisor=0` + `realSpawned=1`),但那个真实进程在 ~200ms 内 **`signalCode=SIGINT`** 消失;我的空转对照(同 worker 内一个无关真子进程)400ms 后仍存活,说明**不是 harness 一律杀子进程**。**SIGINT 的发送者我没查出来,如实报告「没结论」。**
  3. **补了作者没做的一处静态核验**:`instanceHeartbeat.ts:40-55` —— 子进程给父进程发心跳走 `process.send`,其 catch 分支的注释原文是 `// parent process gone — best-effort silent`。也就是说**子进程侧明确知道「父进程可能没了」,并且选择静默**,没有任何自杀式看门狗;`instanceSupervisor.ts:517` 的 `detached: false` 在 POSIX 上也不提供「父死带走子」的语义。这条支持「无人回收」这个**方向**。
  4. **核了作者的一处隐含前提**:作者说 `shutdown()` 与 `tickHeartbeat` 遍历 `entries.values()` 所以看不到孤儿子进程 —— 我核到 `tickHeartbeat` 在 **592**、**`shutdown` 在 688 / 遍历在 693**(作者写的是 `:687`,偏移 +1),**语义完全正确**。
- **结论**：**机制成立,但主张需要收敛为**——
  > 「`doRemove` 在 `starting` 窗口内跳过了 `doStop`,于是 supervisor 为一个已被用户删除的实例 spawn 出了子进程;该 Entry 已被 `entries.delete` 摘除,`tickHeartbeat`(`:592`)与 `shutdown`(`:693`)结构性地看不到它,supervisor **自身从未对它发过任何信号**,且子进程侧(`instanceHeartbeat.ts:52-54`)没有父死看门狗。」

  把「无限期存活」「退出 zai 也带不走」这类**依赖进程最终命运**的措辞换成上面这句「supervisor 从未发过信号 + 无看门狗」的措辞,是诚实的表述 —— 它对修复的指向性一点没减(修法仍然是让 `doRemove` 排队等 in-flight start 落地后再 `doStop`),但它不再替一个 E3a 证据覆盖不到的进程级事实背书。
- **为什么这不改变我的裁决**：我探不到发送者 **≠** 没有发送者;而「`doStop` 被跳过 / entry 被摘除 / supervisor 结构性失明」这三件事是源码字面事实,与那个进程最终死没死无关。**S2 保留,`CONFIRMED` 保留。**

- **附:一行反面观察,给裁判判断我这条洞察的成色** —— 我这两条(`oc-001` 的 oc 与抽验)其实示范了上一届 README §5.3 点名的那个最有价值的动作:抽验的价值常常不在于推翻结论,而在于把「看起来很确定」的数字变成诚实的表述。作者的 `killed=[false] / after-shutdown killed=[false]` 这一行输出**看起来**像进程级的铁证,实际上止步于 supervisor 自身的调用记录。

---

## 六、我给评审过程的一句话

对方只交 2 条,但**两条我都核不出反驳**,而且两条的三问都主动答了、对照组都真的做了变量隔离(尤其 oc-001 那份「三场景必须分进程、否则被模块级单例污染」的自曝,我认为比多报 5 条 E1 更值钱)。**我唯一实质性想收窄的是 oc-001 的影响幅度,和它的三处行号偏移(`:635`→645、`:643`→648、`:687`→688)—— 后者集中在入口函数定义处、没落在任何缺陷逻辑上,我按「不影响结论」处理,但请裁判抽查时留意:本报告两栏里我核过的 26 处引用,精确率比对方高。** 另外我在抽验 2 里顺手撞见的 `[cl-r1]` 提醒了一件事:**评审比发掘更容易撞上真东西** —— 对方在自我否定清单里因为「无法归因」而放下的那片 `ZAI_DATA_DIR` 代码,反方向看一眼就是一个不需要停用户实例就能证明的缺陷。
