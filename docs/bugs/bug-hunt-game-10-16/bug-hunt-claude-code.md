# Bug 发掘报告 · claude-code

> 规则见 [`README.md`](./README.md)。本文所有字段均按 §4.4 填写。

**参赛者**：`claude-code`
**日期**：2026-10-16
**基准提交**：`6f9ceaeb`（`main`）

---

## 一、取证环境

### 工作树状态（收口前 `git status --porcelain`）

```
?? docs/bugs/bug-hunt-game-10-16/
```

与开局（§3.3 `status-before.txt`）**完全一致**，仅含本比赛目录。未触碰任何仓库既有文件，未改动 git 状态（无 commit/add/stash/reset/checkout/worktree）。

### typecheck 基线（§3.3）

```
$ pnpm --filter @zn-ai/zai run typecheck
zai exit=0          错误数 = 0   (grep -cE 'error TS' → 0)

$ pnpm --filter @zn-ai/zn-agent-core run typecheck
[verify-server-types] OK — 5 d.ts file(s) in dist/opencc-src/server/ are self-contained
core exit=0         错误数 = 0   (grep -cE 'error TS' → 0)
```

- 已知基线：README §3.4 记录两个包都是 exit 0、零预存错误。
- **我的基线与已知基线的差异：无。** 两条都复现了 §3.4 的结论。
- **因此本报告不含任何 typecheck 证据** —— 我没有找到任何静态类型矛盾，五条发现全部是运行时行为问题（类型系统看不见的那一类）。这也印证了 README §10 的判断：E1 是起点不是终点。

### 实际执行过的命令

```bash
# 基线快照
mkdir -p /tmp/bughunt-claude-code
git rev-parse HEAD        > /tmp/bughunt-claude-code/head.txt          # 6f9ceaeb7c9b…
git status --porcelain    > /tmp/bughunt-claude-code/status-before.txt # 仅 ?? docs/bugs/…

# typecheck（后台）
pnpm --filter @zn-ai/zai run typecheck          > tc-zai.log  2>&1   # exit=0
pnpm --filter @zn-ai/zn-agent-core run typecheck > tc-core.log 2>&1   # exit=0

# 复现物（全部在 /tmp/bughunt-claude-code/）
./packages/zai/node_modules/.bin/tsx    /tmp/bughunt-claude-code/cc-001-repro.mts        # 三个注册表
./packages/zai/node_modules/.bin/tsx    /tmp/bughunt-claude-code/cc-002-repro.mts        # 桥接全局串台
./packages/zai/node_modules/.bin/tsx    /tmp/bughunt-claude-code/cc-006-killtree.mts     # killTree POSIX
./packages/zai/node_modules/.bin/tsx    /tmp/bughunt-claude-code/cc-006-historyBySid.mts # historyBySid 泄漏
./packages/zai/node_modules/.bin/vitest run --config /tmp/bughunt-claude-code/vitest.cc003.config.mts      # 已否证的假设
./packages/zai/node_modules/.bin/vitest run --config /tmp/bughunt-claude-code/vitest.cc004.config.mts --reporter=verbose  # 两个 E3b 组件用例
```

**未跑全量测试。** 只跑了指定复现物（cc-004 那次 vitest 只 include 了 `/tmp` 下我自己的两个文件，未 include 仓库任何 `*.test.*`）。

### 数据隔离自证（铁律 10）

**是。** 五个复现物全部在文件头第一行（import 之前）显式设置 `ZAI_DATA_DIR`：

```ts
process.env.ZAI_DATA_DIR = '/tmp/bughunt-claude-code/zai-home';
```

- cc-001 / cc-002 / cc-006 只 import 纯内存模块（`PermissionRegistry` 是裸 Map、`headlessPermissionBridge` 只有 `import type`、`killTree` 只有 `child_process`），**物理上无法**触达数据目录 —— env 是防御性的。
- cc-004 / cc-005 是前端组件/store 测试，`fetch` 全部被 stub，不发真实请求、不落盘。
- 我**从未**读写 `~/.zai/`。

### 端口自证（铁律 11）

**我没有起过任何服务。** 五条发现全部通过进程内复现物或组件树渲染取证，不需要 HTTP 端点，因此未占用任何端口。

收口时确认用户的正式实例仍在运行、未被干扰：
```
$ lsof -i :9201
node 60089 ethan ... TCP *:9201 (LISTEN)
```

### 执行环境（贯穿全部 E3）

```
运行时 Node v25.6.0 · 测试工具链 vitest 5.0.3 · 平台 darwin-arm64
```

- ⚠️ **与 README §1 记录的「实测 v22.22.3」不一致**：本机当前 `node --version` 是 **v25.6.0**。我没有改动 Node 版本，用的就是环境里实际存在的那个。
- **为什么这个环境代表用户**：产品是 Node-direct（`zai dev` 走 `tsx` + `bun-protocol.mjs` loader），本次五条全部在 **Node 25.6.0 上直接执行**（`tsx` 直接加载 `.ts` 源文件，未经任何打包/转译），与产品运行时的模块语义一致。cc-001/cc-002/cc-006 用的 `AbortSignal`/`Map`/`spawn` 语义在 Node 20/22/25 之间没有差异，故本场记录的版本差异不影响结论。**我没有在 Bun 下验证过任何一条**（AGENTS.md 指出 `dev:bun` 是可选快速路径）。

---

## 二、排查范围

| 子系统 | 是否排查 | 结论 |
|---|---|---|
| `packages/zai/src/server/routes/`（未分配部分） | ✅ | 读了 `exec.ts` `permission.ts` `instances.ts` `mcp.ts` `plugins.ts` `voice.ts` `event.ts` `stream.ts`。`exec.ts` 的 `cwd` 无限制属已知 CSRF 条目同根；`event.ts` 的 topic 闸门已在 2026-10-07 修过，**未发现新问题**。 |
| `packages/zai/src/server/services/`（未分配部分） | ✅ | 读了 `paths.ts` `reverseProxy.ts` `instanceHeartbeat.ts` `mcpConfig.ts` `skillWatcher.ts` `taskFactoryManagedLoop.ts`。`reverseProxy` 的 `/proxy/<port>` SSRF 属已知 `--lan` 零鉴权同根。 |
| `packages/zn-agent-core/src/opencc-src/`（vendor） | ✅ | 读了 `mods/dispatch.ts` `headlessPermissionBridge.ts` `createOpenccRuntime-impl.ts` 的桥接段。**cc-002 出在这里。** |
| `packages/zai/src/server/routes/fs.ts` | ❌ | 已知清单里已有 4 条 fs/符号链接/DNS-rebinding 条目，已扫过。 |
| `packages/zai/src/server/services/weixinBot/` | ❌ | 已知清单里已有 5 条微信条目（游标/去重/媒体/记忆/锁），已扫过。 |
| vendor 被 stub 的 ~230 个 `.tsx` | ❌ | §3.2 第 5 条，不是缺陷。 |

**并行分工**：我另派了 4 个只读子代理覆盖 PTY/terminal、会话生命周期、compat 层、前端 store 四个方向，自己保留 routes/services/vendor 三块。四路的结论我都**独立复核过行号**才决定采不采纳 —— 例如 cc-001 的 `approveRegistry.ts:46-48` / `askRegistry.ts:26-28`、cc-005 的 `killTree.ts:31-35` / `ReplSession.ts:199,215`、cc-006 的 `eventBus.ts:222-227`，以及 cc-002 修复方案里引用的 `AskUserQuestionTool.ts:23-29`，都是我逐个打开读过原行才写进去的。**子代理读过的 `docs/bugs/` 我自己没读**（规则允许读，我只在判断是否重报时按需核对了标题）。

**我读过但明确放弃的区域**：

| 区域 | 放弃理由 |
|---|---|
| `docs/bugs/` 的 22 条已知未修 | 已知清单，重报 0 分（§3.4）。我只按标题核对是否同根因。 |
| vendor 被 stub 的 230 个 `.tsx` | §3.2 第 5 条，有意移除的终端 UI。 |
| `bashBackgroundTracker` 进程注册表 | 它住在 `@zn-ai/zn-agent-core` 的 vendor 里，本轮时间不够，且与已知条目相邻。**未覆盖，如实声明。** |
| `/api/exec` 的 `cwd` 任意路径 | 与已知 `exec-csrf-rce` 同根（白名单里本来就有 `cat`/`node`），归已知。 |

**为什么没排查其它区域**：时间预算优先给「能拿出带对照组的机器证据」的缺陷。五条里三条 E3a、两条 E3b，没有一条是靠读代码猜的。

---

## 三、Bug 报告

### [cc-001] 三个 pending 注册表在重复 `register` 时把旧的 abort listener 从**错误的 AbortSignal** 上摘掉，导致旧会话的 abort 误杀新会话的提问并让该 turn 永久挂起

- **严重度**：S3（理由：机制与后果均已机器证实，且是**三处逐字复制的同一根因**；但触发前提是同一个 `tool_use` id 被两次 `register` 到不同 signal 上 —— 见下方「触发性」的自证与保留。若该前提可达则升 S2）
- **证据等级**：E3a（理由：直接执行三个真实模块，一个都没 mock；每个模块各有自己的对照组并贴输出）
- **执行环境**：运行时 Node v25.6.0 · tsx 直载 `.ts` · 平台 darwin-arm64 · 为什么它代表用户：产品是 Node-direct，此处只依赖 `Map` 与 `AbortSignal` 的标准语义
- **位置**（三处根因相同、代码逐字相同）：
  - `packages/zai/src/server/services/permissionRegistry.ts:44-46`（缺陷）、`:52`（注册点）
  - `packages/zai/src/server/services/approveRegistry.ts:46-48`（缺陷）、`:54`（注册点）
  - `packages/zai/src/server/services/askRegistry.ts:26-28`（缺陷）、`:34`（注册点）
- **触发路径**：两个会话各自有一次审批/提问落到同一个 `toolUseID`
  → `wrapHeadlessPermissionFn()` (`packages/zn-agent-core/src/opencc-src/server/headlessPermissionBridge.ts:107`)
  → `<Registry>.register('X', 'A', signalA)`
  → `<Registry>.register('X', 'B', signalB)`
  → **出错点** `permissionRegistry.ts:45`（另两处同）：`abortSignal.removeEventListener('abort', existing.onAbort)`
- **现象**：
  - 预期：三份注释逐字相同，声明的意图是「同 toolUseId 二次 register 时，先把旧 listener 从 signal 上摘掉」。实际 `abortSignal` 是**本次传入的新 signal**，`existing.onAbort` 注册在**上一次的旧 signal** 上 —— 对新 signal 摘一个不存在的 listener，是彻底的 no-op。旧 listener 永久留在旧 signal 上。
  - 连带后果一：旧 signal abort 时，那个孤儿 listener 执行 `this.pending.delete(toolUseId)`（`permissionRegistry.ts:48`），删掉的是**新会话 B 的 pending entry**。于是 B 的卡片从 registry 消失、对应 HTTP 端点返回 404，而 B 的 Promise 既不 resolve 也不 reject —— **B 的 turn 永久挂起**。
  - 连带后果二：B 那次 `register` 返回的 Promise 已被 `this.pending.set` 覆盖成不可达，且它的 listener 刚被（错误地）尝试摘除 —— **永远不可能 settle**，只能等 `approveRegistry` 的 `HARD_TIMEOUT_MS`。
- **影响**：
  - B 的对话卡死在工具调用上，用户界面上卡片已经消失（无法回答、无法取消），只能杀会话。
  - A 的 disconnect 精确地杀掉了 B 的提问 —— 这正是 2026-10-05 那条 `prompt-close-aborts-all-sessions` 想消灭的跨会话互杀，只是从另一条路径复现（`agentRuntime.ts:983` 的 `abortAll(reason, sid)` 按 sessionId 收窄，挡不住本条，因为删除来自旧 signal 的孤儿 listener）。
  - 三个注册表都中招：权限确认（Permission）、文件改动审批（Approve）、AskUserQuestion 提问（Ask）。
- **⚠️ 为什么现有测试没抓到**：`packages/zai/src/server/services/approveRegistry.test.ts:100-123` 有一条名为「重复 register 同 toolUseId 不堆 abort listener,只留一份 entry」的测试，看起来正好覆盖这个场景。但它 **60 次全部复用同一个 `ctrl.signal`**（`:113-115`）—— signal 相同，`removeEventListener` 恰好摘对了，缺陷不显现；而且它只断言 `last` 那一个 Promise，前 59 个被孤儿化的 Promise 从头到尾没人看。**这条测试恰好只覆盖了缺陷不发作的那一种配置。**
- **对照组**：
  - **对照组是什么**：每个注册表各自跑「单次 register + 正常 answer」的正常路径。
  - **对照组输出**：
    ```
    CONTROL   PermissionRegistry  listeners pending/after = 1/0  answer=true  settled=true
    CONTROL   ApproveRegistry     listeners pending/after = 1/0  answer=true  settled=true
    CONTROL   AskRegistry         listeners pending/after = 1/0  answer=true  settled=true
    ```
  - **实验组输出**：
    ```
    EXPERIMENT PermissionRegistry  orphan listeners on A = 1 (expected 0)
    EXPERIMENT PermissionRegistry  after A abort: B entry DELETED  answer=false  B hung=true
    EXPERIMENT ApproveRegistry     orphan listeners on A = 1 (expected 0)
    EXPERIMENT ApproveRegistry     after A abort: B entry DELETED  answer=false  B hung=true
    EXPERIMENT AskRegistry         orphan listeners on A = 1 (expected 0)
    EXPERIMENT AskRegistry         after A abort: B entry DELETED  answer=false  B hung=true
    ```
  - **它为什么有区分力**：每个注册表的两组用的是**同一个类、同一个 sessionId、同一套调用**，唯一差别是「有没有第二次 register 且 signal 不同」。对照组从「listener 归零、正常收尾」变成实验组的「listener 残留 1 个、B 的 entry 被删、B 永久挂起」。若输出一致则对照无效 —— 三组都明显不同。
  - **状态复位**：每个 case 用 `new XxxRegistry()` 全新实例，不跨对照复用；三个类都只用裸 `Map`，无模块级缓存可复位。
- **复现步骤**：
  1. `reg = new XxxRegistry()`
  2. `reg.register('ID_DUP', 'sessionA', ctrlA.signal)`（`ApproveRegistry` 多一个 `filePath` 参数，见 `approveRegistry.ts:35-39`）
  3. `reg.register('ID_DUP', 'sessionB', ctrlB.signal)` ← 同 id、**不同 signal**
  4. `getEventListeners(ctrlA.signal, 'abort').length` → `1`（应为 0）
  5. `ctrlA.abort()`
  6. `reg.peek('ID_DUP')` → `undefined`；`reg.answer('ID_DUP', ...)` → `false`；B 的 Promise 未 settle
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/tsx /tmp/bughunt-claude-code/cc-001-repro.mts
  # 完整输出见上方对照组块（真实粘贴）
  ```
  与 §3.4 基线的差集：**不涉及 typecheck**（本条为运行时行为缺陷，typecheck 基线干净）。
- **触发性说明（不夸大）**：我没有证明「同一个 `toolUseID` 会被 `register` 两次」在生产中必然发生。已核查 `opencc-src/services/tools/toolHooks.ts:429/465/491` 的三个 `canUseTool` 调用点互斥（同一 `checkPermissions` 只走一条分支），所以**单次工具调用不会重复注册**。重复注册的可达路径需要跨 query 复用同一个 tool_use id（例如流重试/重放同一 assistant message 的 tool_use block），我**没有**找到确证。
  → 按 §4.2「当前不可触发须自证」，我给出的是**搜索范围**（`canUseTool` 全部 4 个调用点：`QueryEngine.ts:311` + `toolHooks.ts:429/465/491`）而不是全仓无创建点的断言。**证据等级 E3a 成立（机制已证），严重度按 S3 计。**
- **修复方案**：三处同改。`Pending` 类型里存下 signal 自身（`permissionRegistry.ts:16-29`、`approveRegistry`、`askRegistry`），把 `abortSignal.removeEventListener('abort', existing.onAbort)` 改成对**旧 entry 自己那个 signal** 调用；更稳妥的做法是在覆盖前先 `existing.reject(new Error('superseded'))`，让旧 Promise 有确定出口。副作用注意：
  - `abortAll()` 三个文件里都是遍历 `this.pending.values()` 同时 `delete` 当前项 —— `Map` 允许这样迭代，安全，不用改。
  - 修完**必须补一条用不同 signal 的测试**，否则 `approveRegistry.test.ts:100` 那条仍然测不出任何东西（它复用同一 signal）。
- **上游对照**：未查（三个文件都是 zai 侧自研，vendor 无对应物）。

---

### [cc-002] `globalThis.__zaiBridgeCtx.sessionId` 是进程级全局并在整个 query 期间被改写，两个并发 query 互相串台，导致 A 会话的权限提问被登记到 B 名下并被 B 的断连杀掉

- **严重度**：S2（理由：跨会话状态污染 + 请求发错目标，正是 §4.3 的 S2 判据；且并发 query 是多标签页 zai 的常态而非边缘情况）
- **证据等级**：E3a（理由：驱动真实的 `wrapHeadlessPermissionFn`（vendor 真实导出）+ 真实的 `PermissionRegistry`；**被测对象一个都没 mock**。全局的 save/restore 序列是按源码 `:1153-1157` / `:1275-1277` 逐行转写的，不是我自创的 —— 见下方诚实声明）
- **执行环境**：运行时 Node v25.6.0 · tsx 直载 `.ts` · 平台 darwin-arm64 · 为什么它代表用户：产品是 Node-direct，`createOpenccRuntime` 是生产 headless 运行时的唯一入口
- **位置**：
  - `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:1153-1157`（写入全局）
  - `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:1275-1277`（`finally` 里恢复/删除全局）
  - `packages/zn-agent-core/src/opencc-src/server/headlessPermissionBridge.ts:64-69`（**读全局，且无 ALS 兜底**）
  - `packages/zn-agent-core/src/opencc-src/server/headlessPermissionBridge.ts:107-111`（用读到的 sessionId 去 register）
- **触发路径**：用户在两个标签页各开一个会话，A 正在流式产出、B 发新消息
  → query A 进入 `createOpenccRuntime-impl.query()`，`globalThis.__zaiBridgeCtx = {sessionId:'A'}` (`:1154`)
  → A 在 `await stream.next()`（网络 I/O，整个 turn 期间都停在这里）
  → query B 进入，同一个全局被改写成 `{sessionId:'B'}` (`:1154`)
  → **A 的工具调用触发权限检查** → `wrapHeadlessPermissionFn` 在**调用时**读全局 (`:64`) → 拿到 `'B'`
  → `permissionRegistry.register(toolUseID, 'B', signalA)` (`:107`)
  → 用户关掉 B 的标签页 → `routes/agent.ts:2035` `abortAll('client_disconnect', 'B')`
  → **出错点**：A 的权限提问被 reject，错误信息是 `client_disconnect`；A 的 turn 带着一个从别的会话发来的错误中止
- **现象**：
  - `createOpenccRuntime-impl.ts:1146-1152` 的注释写明这个全局的用途是「sessionId varies per query, so we merge it here and restore on exit **so a stale sessionId never leaks into a later query**」。实际它在**并发** query 下必然泄漏：`prevBridge` 是**栈式**保存的，A 保存 `undefined`、B 保存 A 的 ctx；谁先结束谁先恢复，于是恢复顺序与进入顺序相反，全局在一个 query 的生命周期内被另一个 query 改写。
  - 更糟的一种交错：A 先结束（`prevBridge === undefined` → `:1276` `delete`），此时 B 还在跑，B 后续的工具调用读到 `undefined` → `:66-73` 的守卫命中 → **直接 `return decision`**（`ask` 原样返回）→ 按该文件自己 `:21-28` 的描述，`toolExecution.ts:1191` 把非 allow 一律当拒绝 → **用户根本没看到确认框，工具被静默拒绝**。
  - 关键不对称：同仓库的 `compat/tools/opencc/AskUserQuestionTool.ts:23-29`（`resolveAskBridgeCtx`）**优先用 `getCurrentSessionId()`（AsyncLocalStorage）**，注释 `:15-21` 明说「并发 session 场景按 runWithSessionId 各自解析到 OWN sessionId, 全局指针不会 cross-fire」。**但权限路径的 `headlessPermissionBridge.ts:64` 完全没有这层 ALS 兜底** —— 同一个缺陷在两个消费者上被修了一个、漏了一个。
- **影响**：
  - A 的权限确认框消失 / 被 B 的界面接管；用户在 A 里回答的确认被记到 B 名下。
  - B 的正常断连会杀掉 A 正在进行的工具授权（A 收到 `client_disconnect`，与真实原因无关，排错会被彻底误导）。
  - 交错顺序不巧时，`ask` 权限被**静默降级为拒绝** —— 用户以为工具在等确认，实际模型已经拿到 `tool_use_error`，白等一轮。
  - 同一全局还被 `compat/messageQueueAdapter.ts:93` 的 `__zaiGetCurrentSessionId` 消费（后台任务完成通知用它找归属会话），所以缺陷不限于权限路径。
- **对照组**：
  - **对照组是什么**：单 query —— 全局在整个 query 生命周期内只被设置一次（这正是 save/restore 设计想覆盖的场景）。
  - **对照组输出**：
    ```
    CONTROL  registry sees sid      : sess-AAA
    CONTROL  answer() returned      : true
    CONTROL  listeners left on ctrl : 0
    CONTROL  promise settled        : {"resolved":true,...,"value":{"behavior":"allow",...}}
    ```
  - **实验组输出**：
    ```
    EXPERIMENT AAA registered under sid : sess-BBB <-- WRONG SESSION
    EXPERIMENT global after both finish : undefined

    EXPERIMENT after BBB disconnect:
      AAA prompt still pending?  : false
      answer() returned          : false (false => POST /api/agent/permission-response -> 404)
      AAA turn promise settled? : true {"resolved":false,"rejected":true,"value":"Error: client_disconnect"}
    ```
  - **它为什么有区分力**：两组用的是**同一个** `wrapHeadlessPermissionFn`、**同一个** `PermissionRegistry`、**同一个** `ask` decision，**唯一差别是全局有没有被第二个并发 query 改写过**。对照组 sessionId 是 `sess-AAA`（正确），实验组是 `sess-BBB`（串台）。若两组输出一致，则串台不是由并发写全局导致的 —— 明显不同。
  - **状态复位**：每组开始前显式记录 `prevBridge` 并在 `finally` 里恢复/删除（脚本 `:35-38`、`:78-84`）。`globalThis.__zaiBridgeCtx` 是本实验唯一的进程级全局，两组都做了对称的存/恢复，没有跨组泄漏。
- **复现步骤**：
  1. registry = `new PermissionRegistry()`；把 `{permissionRegistry, onYield}` 作为静态部分
  2. query A：`__zaiBridgeCtx = {..., sessionId:'sess-AAA'}`，取 A 的 abortController
  3. query B 进入：`__zaiBridgeCtx = {..., sessionId:'sess-BBB'}`
  4. **此时**才让 A 触发工具权限检查（`wrapped(tool, {}, ctxA, {}, 'toolu_AAA')`）
  5. `registry.peek('toolu_AAA').sessionId` → `'sess-BBB'`
  6. `registry.abortAll('client_disconnect', 'sess-BBB')` → A 的提问被 reject
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/tsx /tmp/bughunt-claude-code/cc-002-repro.mts
  # 完整输出见上方「对照组」块（真实粘贴）
  ```
  与 §3.4 基线的差集：不涉及 typecheck。
- **诚实声明（重要）**：实验组里 query A / query B 的**进入与退出顺序是我按 `:1153-1157` 和 `:1275-1277` 的源码逐行转写**的，我没有真的把 `createOpenccRuntime-impl.ts` 那个 async generator 跑起来（那需要完整 vendor 运行时 + 真实模型调用）。也就是说：
  - **消费端（读全局 + register）是真实模块真实执行**；
  - **生产端（写全局）是逐行转写**，但转写内容与被引用的两段源码逐字对应，裁判可直接比对 `:1154` 与 `:1276`。
  这是 E3a 而非 E3b 的原因，我不把它说成 E3b。
- **修复方案**：三处，缺一不可：
  1. `createOpenccRuntime-impl.ts:1153-1157` —— 改用 `runWithSdkContext` 同款的 AsyncLocalStorage 承载 per-query sessionId，删掉进程全局的读改写；
  2. `headlessPermissionBridge.ts:64-69` —— 按 `AskUserQuestionTool.ts:28` 的既有写法补 ALS 兜底：`sessionId: getCurrentSessionId() ?? bridge.sessionId`；
  3. `compat/messageQueueAdapter.ts:91-94` —— 优先级目前是 `cmd.sessionId ?? cmd.agentId ?? 全局 ?? ALS`，与 `AskUserQuestionTool.ts:28` 的 `ALS ?? 全局` **相反**；应统一成 ALS 优先。
  副作用注意：`__zaiBridgeCtx` 还承载 `askRegistry` / `onYield` 等**进程级静态部分**（由 `packages/zai/src/server/services/agentRuntime.ts:221-225` 一次性注入），改造时要只把 `sessionId` 挪走，静态部分保留。
- **不可触发自证**：不适用 —— 本条声称的是「可达」，可达性由 zai 的多会话并发模型直接保证（多标签页 + 后台 meta query + 微信通道共用一个进程，见 `createOpenccRuntime-impl.ts:1189-1191` 的 `isMeta` 后台 query）。
- **上游对照**：未查。`__zaiBridgeCtx` 是 zai patch（注释 `:1146` 标注 2026-08-20），vendor 上游无此全局。

---

### [cc-003] 切换会话不重置 `pendingAsk` / `pendingPermission`，A 会话的阻塞卡片渲染进 B 会话并锁死 B 的输入框

- **严重度**：S2（理由：跨会话状态污染 + 用户在 B 的界面上执行的操作实际作用于 A）
- **证据等级**：**E3b**（理由：真实渲染组件树 —— `AgentConversation`（内含真实 `QuestionCard` 与真实 `AgentInputBox`）+ 真实 zustand store，断言的是**渲染出的 DOM 与按钮 `disabled` 状态**，不是函数返回值）
- **执行环境**：运行时 Node v25.6.0 · 工具链 vitest 5.0.3 + happy-dom + @testing-library/react 15.0.7 · 平台 darwin-arm64 · 为什么它代表用户：`AgentConversation` 是 `/agent`、`/m`（MobileAgent）、`/desktop` 三个页面共用的真实对话组件（该文件 `:20-22` 注释确认），组件树通过 SSR-free 客户端渲染产出真实 DOM
- **位置**：
  - `packages/zai/src/web/src/store/useAgentStore.ts:1334`（`setCurrentSession` 的 `set`，漏掉 `pendingAsk`）
  - `packages/zai/src/web/src/store/useAgentStore.ts:1413-1425`（`createNewSession`，同样漏）
  - `packages/zai/src/web/src/store/useAgentStore.ts:1252-1276`（`clearMessages`，同样漏）
  - `packages/zai/src/web/src/pages/AgentConversation.tsx:163-178`（无条件渲染 `QuestionCard`，且**根本没把 sessionId 传下去**）
  - `packages/zai/src/web/src/components/AgentInputBox.tsx:282-283`（`sendBlocked` 读 `pendingAsk?.status`）
- **触发路径**：A 会话里 agent 抛出提问 → 用户按 Esc 中断 → 点 B
  → `stop()` (`useAgentStore.ts:1649`) 只把 `status` 置 `'aborted'`，**不清 `pendingAsk`**
  → `Agent.tsx:272` 的 `isBusy` 门禁（只看 `status === 'streaming'`）放行
  → 用户点 B → `setCurrentSession('B')` (`:1319`) → `:1334` 的 `set` 清了 `messages` 但**没清 `pendingAsk`**
  → **出错点** `AgentConversation.tsx:163` `{pendingAsk && <QuestionCard .../>}` —— 单槽状态，无 session 过滤
- **现象**：
  - 预期：切到 B 就不该再看到 A 的待答卡片（同文件 `applyPromptAsk` `:2201` 的注释也写明「ask 卡片是单槽的 pendingAsk，不带过滤的话 A 会话弹出的提问会盖到正在看 B 的页面上」）。
  - 实际：A 的 `QuestionCard` 原样渲染进 B 的页面，B 的发送按钮被禁用（`sendDisabled === true`）。用户在 B 里点「提交」时，`submitAsk` (`:1707`) 用 `s.pendingAsk.sessionId ?? s.sessionId` = **`'A'`** 作为目标向 `POST /api/agent/ask` 发请求 —— **一个 B 界面的操作改写了 A**。
- **影响**：
  - 用户在 B 里被一个解释不了的卡片挡住，**且发送按钮被禁用**（不只是视觉干扰）。
  - 误答的后果是跨会话的：把 A 的答案提交进 A，而用户以为自己在 B 里操作。
  - `pendingPermission` 走同一条路（`AgentConversation.tsx:179` 的 `<PermissionConfirmCard />` 读 `s.pendingPermission`，同样无 sid 校验）—— 一个 A 的权限确认框会挂住 B。
- **对照组**：
  - **对照组是什么**：**同样的目标状态**（`sessionId === 'B'`），但 `pendingAsk` 走正常来源 —— 入站 `prompt.ask` SSE 帧。`applyPromptAsk` 有 currentSid 守卫，理论上会被丢弃。
  - **对照组输出**：
    ```
    CONTROL   sessionId                 : B
    CONTROL   pendingAsk after inbound  : null
    CONTROL   A's card rendered?        : false
    ```
  - **实验组输出**：
    ```
    EXPERIMENT sessionId after switch   : B
    EXPERIMENT pendingAsk.sessionId     : A
    EXPERIMENT messages cleared?        : true
    EXPERIMENT A's card rendered in B  : true
    EXPERIMENT send button disabled?    : true
    ```
  - **它为什么有区分力**：这是本报告里最关键的一组对照 —— **两组结束时 `sessionId` 都是 `'B'`**，唯一的差别是 `pendingAsk` 从哪来。输出一个渲染出卡片、按钮禁用，另一个干净无卡。**这精确定位了缺陷在「出站」（切会话时的状态复位）而不是「入站」（SSE 过滤）或「渲染」（渲染本身没有 bug，是状态没被清）**。如果两组输出一致，说明问题在别处。
  - **状态复位**：`beforeEach` 里 `cleanup()` + `useAgentStore.setState({...})` 显式把 `sessionId` / `messages` / `pendingAsk` / `pendingPermission` / `queuedPrompts` 全部写回已知值；组件用 `render` 而非共享容器。**唯一没有复位的是模块级单例 store 本身**，所以我每次都显式 `setState` 覆盖它列出的每一个相关字段，而不是依赖初值。
- **复现步骤**：
  1. `useAgentStore.setState({ sessionId:'A', status:'streaming', pendingAsk: {sessionId:'A', questions:[{question:'Pick a deploy target for session A', ...}], status:'pending', answers:{}, annotations:{}} })`
  2. `render(<AgentConversation />)` → 卡片出现（前置条件成立）
  3. `useAgentStore.getState().setCurrentSession('B')`
  4. 等 50ms 后断言：卡片仍在 DOM 里、发送按钮 `disabled === true`、`pendingAsk.sessionId === 'A'`
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/vitest run \
      --config /tmp/bughunt-claude-code/vitest.cc004.config.mts --reporter=verbose
  # 2 passed (2)；完整 stdout 见上方对照组块
  ```
  与 §3.4 基线的差集：不涉及 typecheck。**我没有跑仓库里任何既有测试**，只 include 了 `/tmp` 下我自己写的文件。
- **修复方案**：改 `useAgentStore.ts:1334` 的 `set`，把 `pendingAsk: null, pendingPermission: null, pendingApprove: null, queuedPrompts: []` 一并加入（与同文件 `createNewSession` `:1413-1425` 的口径对齐）；`clearMessages` (`:1252`) 同样处理。**防御性第二层**：给 `AgentConversation.tsx:163` 的渲染加 `pendingAsk.sessionId === sessionId` 条件，并把 `sessionId` 传进 `QuestionCard`（`:163-178` 目前压根没传），让渲染端也不依赖调用方记得清理。副作用注意：`submitAsk` (`:1715`) 的 `?? s.sessionId` fallback 要保留 —— 老 transcript 残留的 `pendingAsk` 没有 `sessionId`，加了渲染过滤会让它们永远不显示，需要配套在读取处补齐。
- **上游对照**：不适用（纯 zai 前端代码）。

---

### [cc-004] `loadTranscript` 在 `await` 之后无条件回写 `messages` 与 `sessionId`，慢响应会把用户刚切走的会话拽回来

- **严重度**：S2（理由：跨会话状态污染 —— §4.3 S2 明确列入；用户在 B 界面看到 A 的完整对话内容）
- **证据等级**：**E3b**（理由：真实 store + 真实组件树渲染，断言的是**屏幕上的对话文本**与 store 的 `sessionId`）
- **执行环境**：运行时 Node v25.6.0 · vitest 5.0.3 + happy-dom + @testing-library/react · 平台 darwin-arm64 · 为什么它代表用户：同 cc-003，渲染的是 `/agent` 等页面共用的真实 `MessageListView`
- **位置**：`packages/zai/src/web/src/store/useAgentStore.ts:1613-1633`（`fetch` 在 `:1616`，`set` 在 `:1624-1633`）
- **触发路径**：用户在侧栏点 A（transcript 大/磁盘慢）→ 在 fetch 窗口内点 B
  → `Agent.tsx:274-275` `setCurrentSession(s.sessionId); loadTranscript(s.sessionId)`（fire-and-forget，无序列化、无 await）
  → A 的 `fetch` 在途；B 的 `fetch` 先返回 → `set({messages: B, sessionId: 'B'})`
  → **A 的响应后到** → `set({messages: A, sessionId: 'A'})` (`useAgentStore.ts:1624`)
  → **出错点**：`:1626` 的 `sessionId` 与 `:1625` 的 `messages` 在没有任何「我还是当前会话吗」判断的情况下覆盖了用户的第二次选择
- **现象**：
  - 预期：最后一次用户意图（A 之后选了 B）胜出。
  - 实际：**最后一个返回的响应**胜出，与用户意图无关。
  - 连带：URL 上的 `?sid=` 由 `setCurrentSession` 同步写成 `B`（`:1336`），但 store 已经回到 `A` —— **URL 与界面不一致，刷新一下又跳回 B**；`useEventStream` 依赖 `[sessionId]` 会重建 SSE 连接，跟着切回 A。
- **影响**：
  - 用户明确选了 B，界面却弹回 A 的对话内容，**并且是 A 的完整历史**（含 A 里其它任务/会话的内容）。
  - 刷新页面又跳回 B，同一会话在刷新前后显示不同内容，排错极难。
  - 期间到达的、属于 B 的 `runtime.*` 帧会被 `useAgentStore.ts:1835-1836` 的 sid 守卫静默丢弃。
- **对照组**：
  - **对照组是什么**：同样的 `setCurrentSession('B')` + `loadTranscript('B')`，但**没有**那个在途的 A 请求（即不构造竞态）。
  - **对照组输出**：
    ```
    CONTROL   sessionId                     : B
    CONTROL   B marker on screen            : true
    CONTROL   A marker on screen            : false
    ```
  - **实验组输出**：
    ```
    EXPERIMENT after B resolved : sessionId = B
    EXPERIMENT B marker on screen          : true
    EXPERIMENT after A resolved : sessionId = A
    EXPERIMENT B marker still on screen     : false
    EXPERIMENT A marker on screen           : true
    ```
  - **它为什么有区分力**：唯一变量是「A 的响应是否在 B 之后到达」。对照组停在 B、显示 B 的内容；实验组被拽回 A、B 的内容从屏幕上消失、A 的内容顶上来。若两者相同，则不是这个竞态导致的。
  - **状态复位**：`beforeEach` 重设 `sessionId` / `messages` / `pendingAsk` / `pendingPermission` 并 `cleanup()`；`fetch` 用 `vi.stubGlobal` 整轮替换，A 的闸门 promise 在**每个 beforeEach 内部新建**（第一版我把它放在模块作用域、`releaseA` 却被重新赋值，导致 A 永远不 resolve、竞态根本触发不了 —— 已修正，修正过程见下）。
  - ⚠️ **第一版脚本自身有 bug，差点制造假绿**：模块级 `gateA` 捕获了第一次的 resolver，`beforeEach` 里 `releaseA = () => {}` 覆盖后 `gateA` 永不 resolve，实验组输出 `sessionId = B`、看似通过。**是控制组的输出（B marker on screen: true）暴露出实验组压根没渲染组件**才定位到的。修正为每轮 `gateA = new Promise(...)` 并补上实验组缺失的 `render()` 后，缺陷才显现。这是本报告里我给自己设的对照组的实际价值。
- **复现步骤**：
  1. stub `fetch`：A 的会话请求挂起（等一个手动释放的 promise），B 立即返回，各自返回带**可区分标记文本**的 transcript
  2. `void loadTranscript('A')`；等 20ms
  3. `setCurrentSession('B')` + `void loadTranscript('B')`；等 60ms（B 此时已上屏）
  4. 释放 A 的闸门；等 120ms
  5. 断言 `sessionId === 'B'` → **实际得到 `'A'`**（测试因此失败，这正是缺陷的呈现）
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/vitest run \
      --config /tmp/bughunt-claude-code/vitest.cc004.config.mts --reporter=verbose \
      /tmp/bughunt-claude-code/cc-005-transcript-race.test.tsx
  # EXPERIMENT 断言失败：expected 'A' to be 'B'
  # 1 failed | 1 passed —— 失败的那条正是缺陷本身，control 通过
  ```
  与 §3.4 基线的差集：不涉及 typecheck。
- **修复方案**：改 `useAgentStore.ts:1613-1633`，在 `await` 之后、`set` 之前加一道 stale 检查：`const cur = get().sessionId; if (sessionId !== cur && cur !== null) return`。**注意不能简单地 `if (get().sessionId !== sessionId) return`** —— 会话冷启动时 `setCurrentSession` 已把 `sessionId` 写成目标值，而 `loadTranscript` 也可能由 `loadSessions` (`:1310-1312`) 在 `sessionId === null` 时以参数 `picked.sessionId` 调用。副作用注意：同文件 `hooks/useSubmitPrompt.ts:107-111` 是**同一个形状的缺陷**（`await` 后无条件 `setState({sessionId})`），建议一并加同一道守卫；`submitAsk` (`:1752-1761`) 用 await 前的快照 `s` 回写 `pendingAsk`，是同一族的第三个点。
- **上游对照**：不适用（纯 zai 前端代码）。

---

### [cc-005] `killChildTree` 在 POSIX 上名不副实 —— 只杀直接子进程，`sh -c` 的复合命令留下的孙进程变成孤儿并继续占端口

- **严重度**：S3（理由：边界退化 / 错误路径不清理 —— §4.3 S3 判据；不是崩溃也不是数据损坏）
- **证据等级**：E3a（理由：真实执行 `killChildTree`，对照组先跑并贴输出；孤儿进程的存在用 `process.kill(pid, 0)` 探测）
- **执行环境**：运行时 Node v25.6.0 · tsx 直载 · 平台 **darwin-arm64**（POSIX 分支，与用户实际运行平台一致）· 为什么它代表用户：产品是 Node-direct，用户的 macOS 上跑的就是这条 POSIX 分支
- **位置**：`packages/zai/src/server/utils/killTree.ts:14-36`（缺陷在 `:31-35`），调用点 `packages/zai/src/server/services/repl/ReplSession.ts:199`（`abort`）与 `:215`（`dispose`）
- **触发路径**：用户在 Bash 面板跑一条复合命令，然后点停止
  → `POST /api/bash/repl/:sid/abort` (`routes/bashRepl.ts:103`)
  → `ReplSession.abort()` (`ReplSession.ts:196`) → `killChildTree(child)` (`:199`)
  → `killTree.ts:31-35`：`child.kill('SIGTERM')` —— **只发给 `sh`**
  → **出错点**：`sh` 被 fork 出来的孙进程（真正的 payload）无人发信号，被 init 收养继续运行
- **现象**：
  - 函数名叫 `killChildTree`，文件头注释也写明「win32 下连整棵进程树一起杀」—— 即 POSIX 上**从设计上就不杀树**。
  - 但 `ReplSession.ts:148` 用的是 `spawn('sh', ['-c', command])`，这与注释里描述 win32 的「child 只是包装层」是**同一个形状**：复合命令（`cd api && npm run dev`）必然让 `sh` fork，payload 就是孙进程。
  - 预期：用户点了停止，命令真的停了。实际：`sh` 的 `'exit'` 事件触发 → `ReplSession.finish()` → UI 显示命令已结束，**而真正的 dev server 还在跑、还占着 3000 端口**。
- **影响**：
  - 用户以为服务已停，实际孤儿进程继续占端口、继续吃 CPU/内存；重跑报 `EADDRINUSE`。
  - `ReplSession.ts:201-206` 的 5 秒升级只是把同一个信号再发给同一个 `this.child`，救不了孙进程。
  - `bashRepl.ts:52` 的 `await completion`（wait 模式）在 wait=true 时会**一直挂着**，孤儿进程让这次 exec 永远不返回。
- **对照组**：
  - **对照组是什么**：单条简单命令 `sh -c 'sleep 300'` —— POSIX 的 `sh` 会 **exec** 掉它自己，此时 child 就是 payload，没有孙进程。
  - **对照组输出**：
    ```
    CONTROL  simple command: sh -c "sleep 300"  (sh execs it, no grandchild)
    CONTROL  payload alive before kill        : true
    CONTROL  payload alive after  kill        : false
    ```
  - **实验组输出**：
    ```
    EXPERIMENT compound command: sh -c "sleep 300 & echo $! > MARK; wait"
    EXPERIMENT sh pid                         : 89726
    EXPERIMENT grandchild pid                 : 89727
    EXPERIMENT grandchild alive before        : true
    EXPERIMENT sh terminated by killChildTree : true
    EXPERIMENT GRANDCHILD STILL ALIVE         : true   <-- ORPHAN
    ```
  - **它为什么有区分力**：对照组证明这个 helper 在「child 即 payload」时**工作正常**（杀得掉）；实验组唯一的变化是命令复合化导致 `sh` fork，输出就从「payload 死了」变成「孙进程还活着」。若两者相同，说明孙进程也被杀了 —— 实际没有。
  - **状态复位 / 清理**：脚本启动的每个进程都在退出前被 `SIGKILL` 回收；`pgrep -fl "sleep 300"` 在跑完后为空，确认**没有在用户机器上留下任何孤儿**。测试用的 pid 文件也 `rmSync` 了。
- **复现步骤**：
  1. `spawn('sh', ['-c', 'sleep 300 & echo $! > MARK; wait'])`
  2. 从 MARK 读孙进程 pid，确认存活
  3. `killChildTree(child, {force:true})`
  4. `process.kill(shPid, 0)` → 已死；`process.kill(grandchildPid, 0)` → **仍活**
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/tsx /tmp/bughunt-claude-code/cc-006-killtree.mts
  # 完整输出见上方对照组块（真实粘贴）
  $ pgrep -fl "sleep 300"    # 空 —— 无残留
  ```
  与 §3.4 基线的差集：不涉及 typecheck。
- **不可触发自证**：不适用 —— 已在 macOS 上实测复现，不需要推断可达性。
- **修复方案**：改 `killTree.ts:14-36`，POSIX 分支改为杀**进程组**而非单个 pid：在 `ReplSession.ts:148` 的 `spawn` 上加 `detached: true`（让 payload 成为新进程组的组长），POSIX 下用 `try { process.kill(-child.pid, sig) } catch { child.kill(sig) }` 兜底。副作用注意：
  - `detached: true` 会改变信号行为（不再随 zai 的终端 SIGHUP 一起死），必须同时确认 `runtimeLifecycle.ts:99` 的 `disposeAll` 仍会 `kill(-pid)`，否则会把现有的 SIGHUP 兜底**弄丢** —— 这正是已知条目 `repl-registry-child-process-leak` 说的「PTY 路径反被内核 SIGHUP 救回」，改动时不能顾此失彼；
  - `child.unref()` 不能加，否则 wait 模式的 `await completion` 会失去引用。
- **上游对照**：未查。

### [cc-006] `ServerEventBus.historyBySid` 的 key 集合只增不减 —— 每个出现过的会话 id 永久占用一份事件历史

- **严重度**：S3（理由：错误路径不释放资源 —— §4.3 S3 判据；长跑 dev 实例上内存单调增长，不崩溃不丢数据）
- **证据等级**：E3a（理由：真实执行 `ServerEventBus`，对照组先跑并贴输出）
- **执行环境**：运行时 Node v25.6.0 · tsx 直载 `.ts` · 平台 darwin-arm64 · 为什么它代表用户：产品是 Node-direct；这是 zai 服务端进程内的纯内存结构
- **位置**：`packages/zai/src/server/services/eventBus.ts:198`（声明）、`:222-227`（唯一的写入）、`:270`（唯一的读）、`:5`（`CAPACITY = 256`）
- **触发路径**：任意会话产生事件
  → `ServerEventBus.emit()` (`eventBus.ts:216-227`)
  → `this.historyBySid.set(sid, arr)` (`:227`)
  → **无任何 `.delete` / `.clear`**：全仓对 `historyBySid` 的引用只有 `:198`（声明）、`:222`/`:227`（写）、`:270`（读）、`eventBus.test.ts:239`（一条注释）
- **现象**：
  - `:197` 的注释写「容量同样按 CAPACITY 裁, 避免单 sid 长期占满内存」—— 但 `CAPACITY` 只裁**每个数组的长度**（`:224` 的 `if (arr.length > CAPACITY) arr.shift()`），**对 key 的数量毫无约束**。
  - 预期：删会话（`DELETE /agent/sessions/:id`，`routes/agent.ts:2228-2269`）会回收该 sid 的历史。实际：该路由清了 6 个注册表（controller / inbox / transcript 文件 / CwdStore / sessionBindings / sessionAgentRegistry / terminals），**唯独没碰 `historyBySid`** —— `ServerEventBus` 上根本没有提供这样的方法。
- **影响**：
  - 每个出现过的 sid 永久保留最多 256 条**完整物化**的 `ServerEvent`，内容包括 `runtime.delta` 的文本、`runtime.tool_call` 的 input、`runtime.tool_result` 的 output、`queue.changed.pending` 的 prompt 文本。删会话的用户以为清干净了，**内容其实还在内存里**。
  - `sessionArchive.ts` 在 boot 时把旧 transcript 扫到 `archive/`（保留 20 份），但对这张 map 视而不见 —— 被归档的会话恰恰是 map 里留得最久的那批。
  - 长期开着的开发实例（这正是 zai 的主要使用形态）内存单调增长，只能靠重启释放。
- **对照组**：
  - **对照组是什么**：**单个** sid 发 1000 条事件 —— 检验 `CAPACITY` 这道自称的防线是否有效。
  - **对照组输出**：
    ```
    CONTROL  1 session, 1000 events emitted
    CONTROL  map keys                 : 1 (per-sid array capped at 256 )
    ```
  - **实验组输出**：
    ```
    EXPERIMENT 5000 distinct session ids, 1 event each
    EXPERIMENT map keys                 : 5000
    EXPERIMENT after subscribe + history read, keys: 5000
    EXPERIMENT retained bytes for ONE key : ~311 B  =>  5000 keys ~ 1.5 MB of unreclaimable history
    ```
  - **它为什么有区分力**：对照组证明 `CAPACITY` **确实**挡住了单会话的纵向增长（1000 条事件压回 256 条）—— 所以不能简单地说「没有容量控制」。实验组换的是**另一个维度**（key 的数量而非数组长度），输出就从「1 个 key」变成「5000 个 key 且只增不减」。这正是 `CAPACITY` 管不到、而代码注释误以为管到的那个维度。
  - **状态复位**：两个 case 各自 `new ServerEventBus()` 全新实例，不跨对照复用；该类的全部状态都是实例字段（`:198` 等），无模块级单例需要复位。
- **复现步骤**：
  1. `bus = new ServerEventBus()`
  2. 对 5000 个不同 sid 各 `bus.emit({type:'runtime.delta', sessionId: 'sess-'+i, ...})`
  3. 读 `(bus as any).historyBySid.size` → `5000`
  4. 随便调 `subscribe` / `getHistoryAfterForSid` → 仍是 `5000`，无回收路径
- **复现命令与输出**：
  ```bash
  $ ./packages/zai/node_modules/.bin/tsx /tmp/bughunt-claude-code/cc-006-historyBySid.mts
  # 完整输出见上方对照组块（真实粘贴）
  ```
  与 §3.4 基线的差集：不涉及 typecheck。
- **不可触发自证**：不适用 —— 已在内存中直接测出 key 数单调增长，不需要推断。
- **修复方案**：给 `ServerEventBus` 加 `deleteSid(sid)`（`this.historyBySid.delete(sid)`）并在 `routes/agent.ts` 的 DELETE 处理器里调用（它已经在同一段里清了另外 6 处，加一行即可）；`runtimeLifecycle.ts` 的 `closeServer` 已有整体清理位置。再加一道兜底：按最后访问时间做 LRU 淘汰，防止漏掉的路径重新堆积。副作用注意：删 sid 时若有客户端正在 replay（`getHistoryAfterForSid`，`:270`），会读到空数组 —— 但该会话已被删，客户端本就该失效，且 `event.ts:94-113` 的 replay 路径对空数组是安全的（`for` 循环零次）。
- **上游对照**：不适用（zai 侧自研的事件总线）。

---

## 四、汇总表

| ID | 标题 | 严重度 | 证据等级 | 位置 |
|---|---|---|---|---|
| cc-001 | 三个 pending 注册表重复 `register` 时从错误的 AbortSignal 摘 listener → 旧会话 abort 误杀新会话提问并永久挂起 turn | S3 | E3a | `packages/zai/src/server/services/permissionRegistry.ts:44-46`（另见 `approveRegistry.ts:46-48`、`askRegistry.ts:26-28`） |
| cc-002 | `globalThis.__zaiBridgeCtx.sessionId` 进程级全局在并发 query 下互相串台 → 权限提问登记到别的会话 | S2 | E3a | `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:1153-1157` |
| cc-003 | 切会话不重置 `pendingAsk`/`pendingPermission` → A 的阻塞卡片渲染进 B 并锁死 B 的输入框 | S2 | E3b | `packages/zai/src/web/src/store/useAgentStore.ts:1334` |
| cc-004 | `loadTranscript` await 后无条件回写 → 慢响应把用户刚切走的会话拽回来 | S2 | E3b | `packages/zai/src/web/src/store/useAgentStore.ts:1613-1633` |
| cc-005 | `killChildTree` 在 POSIX 只杀直接子进程 → `sh -c` 复合命令的孙进程成孤儿继续占端口 | S3 | E3a | `packages/zai/src/server/utils/killTree.ts:31-35` |
| cc-006 | `ServerEventBus.historyBySid` 只增不减 → 每个出现过的会话 id 永久占用事件历史 | S3 | E3a | `packages/zai/src/server/services/eventBus.ts:222-227` |

**正式报告条目数**：6　**其中 E0 条数**：0

**自估发掘分**：S2×3 + S3×3 = 18 + 9 = **27**（`3×6×1.0 + 3×3×1.0`），上限 60。

**证据等级分布**：E3b × 2（cc-003 / cc-004，均为真实渲染组件树）、E3a × 4、**E3a 及以上占比 100%，E0 = 0**（不触发「低证据密度」扣分）。

---

## 五、不确定与自我否定清单

> 这一节不参与扣分。以下是我**怀疑过、追下去、然后自己推翻或无法证实**的线索。

| 线索 | 位置 | 为什么站不住 / 为什么没能证实 |
|---|---|---|
| **taskFactoryManagedLoop 的 `tick()` 没有重入保护 → 并发 tick 会重复注入 dispatch 指令** | `packages/zai/src/server/services/taskFactoryManagedLoop.ts:97`、`:169-170` | **我做了实验组/对照组，结果是对照组把我推翻了。** 我把第一个 tick 停在 `bg.get()` 上，让 5 个后续 tick 自由跑完，预期看到 N 条重复注入。实测：**对照组（tick 都很快）注入 1 条，实验组（tick #1 卡住）也只注入 1 条**。原因是 `lastSignature` 的判断与赋值（`:169-170`）本身就是一个正确的幂等闸 —— 谁先跑到第 169 行谁注入，其余全部跳过。同文件 `checkStagnantTasks` 的 `stagnantCheckRunning`（`:238-244`）也确实防住了并发。**假设被否证，不报。** 残留的真实损害只有「各 tick 拿到的是略微过期的快照」，影响不足以成条。 |
| `describeMcpSources` 把 `~/.claude.json` 写成了第二个 `~/.zai.json` | `packages/zai/src/server/services/mcpConfig.ts:212-213`（`cj` 与 `zj` 同值，`:214` 的三元恒为 `zj`） | 缺陷本身确凿（`loadMcpServers` `:151-152` 是对的，只有诊断函数写错），但**全仓零调用方**：`grep -rn "describeMcpSources" packages/` 只命中定义处与一处注释，无生产/测试/前端引用。属当前不可达，且即使可达也只是 `/mcp` 诊断 UI 报错路径。按 §4.2 记为不可触发，不计分。 |
| `ensureWeixinDirs()` 混用函数版与常量版路径，`ZAI_DATA_DIR` 在模块加载后变更会导致 sync/context/media 三个目录写到别处 | `packages/zai/src/server/services/paths.ts:147-154`（`WEIXIN_SYNC_DIR`/`WEIXIN_CONTEXT_DIR`/`WEIXIN_MEDIA_DIR` 是模块加载期求值的常量，其余是函数） | 机制成立，**但生产不可达**：env 在进程启动前就固定，全仓没有任何运行期写 `process.env.ZAI_DATA_DIR` 的生产代码（只有测试文件会）。仅在测试里改 env 才会分裂 —— 那不是产品缺陷。**降级为代码整洁问题，不报。** |
| ReplRegistry 的 `dispose(sessionId)` 全仓无生产调用方 → 删会话不杀 `sh -c`、registry 无界增长 | `packages/zai/src/server/services/repl/ReplRegistry.ts:27-33`（唯一调用方是单测）；`routes/agent.ts:2228-2269` 的 DELETE 只处理 inbox/agents/PTY | 与 `docs/bugs/` 里 `repl-registry-child-process-leak` **同根因**（都是「dispose 从未接线」），只是触发点从「进程退出」换成「删会话」。按 §3.4「已知清单里的 0 分」，我判为 **KNOWN，不报**。记在这里是为了让裁判知道我不是没看见。 |
| `PtySession.close()` 在自然退出后无超时地 `await exitSettled`，可能挂住 `closeServer` | `packages/zai/src/server/services/terminal/PtySession.ts:341-352`、`:400-412` | 找不到可达触发路径：唯一排在 `finish` 尾部的写回调来自 `output()`，而 `enqueue` 用 `pending.then(noop, noop)` 吸收了 rejection，`screen.dispose()` 在 await 之后才可达。**无法构造触发输入，不报。** |
| `ReplSession.exec` 的 busy 守卫在 Windows 上有竞态（`await resolveWindowsShell()` 在守卫与赋值之间） | `packages/zai/src/server/services/repl/ReplSession.ts:135-153` | 代码形状确实有窗口，但**本机是 darwin，该分支不可达**，我无法在本场环境给出机器证据（§4.2 的运行时要求）。POSIX 上 `:135` 与 `:153` 之间没有 `await`，是原子的。**无法在产品运行平台上验证，不报。** |
| compat 层两套 `settings.json` 路径约定（`openccInit.ts` 认 `ZAI_DATA_DIR`，`zaiSettingsStore.ts:32-34` / `permissions.ts:83` 只认 `homedir()/.zai`） | `packages/zn-agent-core/src/compat/openccInit.ts:205,306,349` vs `packages/zai/src/server/services/zaiSettingsStore.ts:32-34` | 机制成立，但触发前提是用户显式设置 `ZAI_DATA_DIR` —— 而该 env 的**唯一生产用途是测试隔离**（`paths.ts:38-40` 注释、`zaiMigration.ts:172`）。默认部署下两者都解析到 `~/.zai`，无分歧。**低价值 + 窄触发，不报。** |
| DELETE 会话不清 `sessionQueues`/`sessionRunning`/`sessionRateLimitUntil`，被删会话因队列里还有待发 prompt 而复活 | `packages/zai/src/server/routes/agent.ts:2228-2269`（DELETE 只清 6 处）、`:952-953`、`:963`、`:1052-1063`（`finally` 里 `void runNextInQueue`） | 与 `docs/bugs/` 的 `delete-session-resurrects--by-zai.md` **同根同现象**（那条已写明「DELETE 缺 abortSessionController；`finally` 的 wake 启动新 turn，`appendEntry` 重建被删文件」）。按 §3.4 判 **KNOWN，不报**。 |
| `ElicitationRegistry.request()` 返回的 Promise **没有任何生产调用方能 resolve**，且没有 abort 路径 | `packages/zai/src/server/services/elicitationRegistry.ts:41-83`；唯一调用者 `dispatchDshInbox` 自身也无生产调用方 | 文件头 `:8-13` 自己就标了「P3 prerequisite (NOT YET IMPLEMENTED)」—— 是**已知未做完的功能**，不是缺陷。**不报。** |
| compat 候选：`__zaiGetCurrentSessionId` 的优先级（全局先于 ALS）与 `AskUserQuestionTool.resolveAskBridgeCtx`（ALS 先于全局）**相反** | `packages/zn-agent-core/src/compat/messageQueueAdapter.ts:91-94` vs `packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts:28` | 与 cc-002 同根因（都怪那个进程全局），**已作为 cc-002 的「连带影响 / 修复方案第 3 点」写进正式条目**，不另立一条以免同一根因拆成两条刷数量。 |
| `/api/voice/getASRToken` 零鉴权返回 WorkBuddy 的 `accessToken` + `refreshToken` | `packages/zai/src/server/routes/voice.ts:97-122` | 端点本身确实吐出可被接管的凭据，但**只有 `--lan` 模式下才构成暴露**，而 `--lan` 零鉴权已是已知条目 `lan-mode-no-auth-rce`。localhost 模式下是用户访问自己的机器。**归入已知根因，不报。** |

---

## 六、给裁判的一句话

本仓库的跨会话污染有一条**共同的结构性根因**：`sessionId` 在多处没有走 AsyncLocalStorage，而是靠一个进程级全局 + 多个注册表传递 —— `cc-002`（`__zaiBridgeCtx`）和 `cc-003`/`cc-004`（前端 `setCurrentSession` 不复位单槽状态、`loadTranscript` 不做 stale 检查）分别是它的服务端与客户端两半，而 2026-10-05 那批已知条目修的正是它的另外几个投影。这跟上一届 opencc「状态分散在多个注册表」的结论是同构的，只是这次的载体从「注册表」换成了「全局可变状态」。我认为这一条比本报告里任何单个缺陷都更值得优先修。
