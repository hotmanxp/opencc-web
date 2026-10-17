# Bug 发掘报告 · opencc

> 规则见 [`README.md`](./README.md)。参赛者 `opencc`，ID 前缀 `oc-`。

**参赛者**：`opencc`
**日期**：2026-10-17
**基准提交**：`31fca1d2`（`main`）

---

## 一、取证环境

- 工作树状态（收口前 `git status --porcelain` 输出）：
  ```
  ?? docs/bugs/bug-hunt-game-10-17/
  ```
  与规则 §1 的判定口径一致：**只有本场赛制目录**。我全程未对仓库既有文件做过任何写操作，收口时复查仍只有这一项。

- typecheck 基线结果（§3.3）：
  ```
  zai  exit = 0   错误数 = 0
  core exit = 0   错误数 = 0
  ```
  - 与 README §3.4 声明的差异：**无**。两个包都 exit 0、零预存错误，与裁判实测一致。
  - 因此我**没有**任何 typecheck 证据可用 —— 本报告两条都是运行时行为缺陷，与类型系统无关（正如 §8 所说，typecheck 绿不代表没 bug）。

- 我实际执行过的命令：
  ```bash
  # §3.3 基线
  mkdir -p /tmp/bughunt-opencc
  git rev-parse HEAD > /tmp/bughunt-opencc/head.txt
  git status --porcelain > /tmp/bughunt-opencc/status-before.txt
  pnpm --filter @zn-ai/zai run typecheck         > /tmp/bughunt-opencc/tc-zai.log  2>&1
  pnpm --filter @zn-ai/zn-agent-core run typecheck > /tmp/bughunt-opencc/tc-core.log 2>&1
  # → zai exit=0（4 行日志，0 条 error TS）／core exit=0（5 行日志，0 条 error TS）

  # 上一届 16 条修复的全貌
  git log --oneline 6f9ceaeb..HEAD | cat          # 11 个 commit
  git diff 6f9ceaeb..HEAD --stat | cat             # 99 files, +8780 / -215
  git show 5dedfe4d / 31fca1d2 / 29d86914 / e00cfe11 / d66d09f5 / 7c32e4da / 2a9e31d6

  # oc-001 复现物（三个场景各起独立进程，见下文「对照组」）
  for S in remove stop norace; do
    SCENARIO=$S ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home \
      pnpm --filter @zn-ai/zai exec vitest run \
      --config /tmp/bughunt-opencc/vitest.repro.config.ts \
      /tmp/bughunt-opencc/oc-orphan-remove.test.ts \
      > /tmp/bughunt-opencc/repro-oc001-$S.log 2>&1
  done

  # oc-002 复现物：起隔离实例打真实端点
  cd packages/zai && ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home \
    pnpm run dev -- --port 8101 --api-port 7715 > /tmp/bughunt-opencc/dev.log 2>&1 &
  curl -X PUT http://localhost:7715/api/super-tasks/settings -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $TOKEN" -d '{"preferCliAgent":"claude"}'
  ```

- **数据隔离自证**（铁律 10）：
  ```bash
  # 每一个会触碰数据目录的复现物都显式设置，且脚本头部也注明
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home
  ```
  **我实测了隔离是否真的生效**，而不是只贴这行 export：
  - oc-001 的复现物只 `import` `instanceSupervisor.ts`，并额外把 `dataDir` dep 显式指向 `/tmp/bughunt-opencc/zai-home`；`writeFile` 是注入的 no-op，不落盘。
  - oc-002 起了真实实例后，我用真实写入做了验证：**我用 curl 写入的工厂设置落在隔离目录，真实用户目录里根本没有这个文件。**
    ```
    $ cat /tmp/bughunt-opencc/zai-home/factory-settings.json
    { "docsDir": "/tmp/bughunt-opencc/zai-home", "repoRoot": "", "maxParallelTasks": 4,
      "preferCliAgent": "opencc", "historyArchiveHours": 48, ... }

    $ ls -la ~/.zai/factory-settings.json
    (absent — good)
    ```
    这条路径的隔离**确实生效**。
  - **但我要如实报告一处没能自证的地方**：`find ~/.zai -newermt '-10 minutes'` 列出了 10 个近 10 分钟内被修改的真实文件（`background/tasks/*.json`、`weixin/sync/*.buf`、`projects/.../*.jsonl`、`projects/.../memory/*.md`）。**我无法把它们归因到我的隔离实例**：用户的 9201 正式实例正在运行、它本来就会写这些路径，而 `memory/*.md` 那两条来自我当前这条 agent 会话自身。我没有做逐文件的写者取证（需要停用户实例，我没做也不该做）。**结论是：工厂设置这条我实测过的路径隔离生效；`~/.zai` 整体是否零触碰，我没有证明，也不声称。**

- **端口自证**（铁律 11）：
  ```bash
  $ lsof -i :8101 -i :7715      # 起服务前：空，无输出 → 两个端口都空闲
  $ lsof -i :8101               # 收口后：空，端口已释放
  $ lsof -i :9201
  COMMAND  PID   USER  FD  TYPE  DEVICE  SIZE/OFF NODE NAME
  node    1812  ethan  19u IPv4  ...      TCP 192.168.101.69:... (ESTABLISHED)
  node    1812  ethan  57u IPv4  ...      TCP *:... (LISTEN)
  ```
  我只用了 **8101（web）/ 7715（api）**，从未 kill、从未占用 9201。用户的实例是 **PID 1812**，自始至终在监听。全程未使用 tmux / 浏览器自动化。

---

## 二、排查范围

| 子系统 | 是否排查 | 结论 |
|---|---|---|
| `packages/zai/src/server/routes/` | ✅ 重点 | `instances.ts` 的生命周期闸、`superTasks.ts` 的 CLI agent 契约 → **oc-001 / oc-002** |
| `packages/zai/src/server/services/` | ✅ 重点 | `instanceSupervisor.ts` 全文件逐行、`factorySettings.ts`、`aaClient/{offlineBuffer,noticeStore,reverseDispatch}.ts`、`taskFactoryBridge.ts` |
| `packages/zai/src/web/`（前端组件 / store / hooks） | ✅ 局部 | `superTasks/FactorySettingsDrawer.tsx` → **oc-002**；`useAgentStore.ts`、`FsContextMenu.tsx` 扫读未出 |
| `packages/zn-agent-core/src/compat/` | ✅ 重点 | `subagents/{opencc,claude-code}/`、`tools/opencc/*`、`openccInit.ts`、`runtime/{sdkEventAdapter,legacyTranscriptStore}.ts`、`background/*` |
| `packages/zn-agent-core/src/opencc-src/`（vendor） | ⚠️ 抽查 | `server/headlessPermissionBridge.ts`（per-chain ALS 修复）读过；其余未系统扫 |
| 上一届修复新落地的代码（`6f9ceaeb..HEAD`） | ✅ **主战场** | 11 个 commit 全读 diff + 读当前 HEAD 源码。oc-001 出自 `5dedfe4d`，oc-002 出自 `7c32e4da` |

**我读过但明确放弃的区域**：

| 区域 | 放弃理由 |
|---|---|
| §3.4 A / B / C 三组已知清单（7 + 1 + 5 条） | 重报 0 分。**注意我没有只信文档说法** —— 例如 A 组的 `vendor-write-symlink-bypass` 我回源码确认过机制仍在，但清单条目本身我没报 |
| vendor 被 stub 的 ~230 个 `.tsx` | 组件体已被替换为 `return null`（§3.2 第 5 条），不是缺陷 |
| `packages/zai/test/` 下的既有测试文件 | 只作为**复现物脚手架**读（`instanceSupervisor.startingWindow.test.ts` 给了我 harness），未把「测试写得不好」当 bug |
| 上一届 `bug-hunt-game-10-16/` 的 `bug-hunt-*.md` / `hunt-review-*.md` | 铁律 6：禁止阅读。我只读了该目录外的 `VERDICT.md` / `FIX-PLAN.md` 用于避坑 |
| `deepseek-harness/` 等工作区其它仓库 | 不属于本场比赛对象 |

**为什么没排查其它区域**：60 分钟预算 + 「宁可少交也要每条经得起复验」。我把时间全部压在**上一届刚落地、没人扫过的新代码**上（§8 明确指出这是最值钱的一片），并对每一条都做了实测而非停在 E1。

---

## 三、Bug 报告

### [oc-001] 标题：`starting` 窗口内 DELETE 实例 → 子进程被 spawn 后**永不回收**，且从 supervisor 视野里消失

- **严重度**：S2（理由：一个完整的 zai 子进程 + 它绑定的端口在 supervisor 里彻底脱管后**无限期存活**。后果不是崩溃也不是数据损坏，而是：① 端口被占住，用户重启该实例时 `assertPortAvailable` 失败；② 该子实例继续在用户的 workspace 上跑（它是一个完整的 AI agent 服务端），用户在 UI 上却再也看不到它、也无法停止它；③ 退出 zai 也带不走它。这既是资源泄漏又是跨会话状态脱管，够 S2。我**没有**报 S1 —— 它不丢用户数据、不崩溃、也不越权。）

- **证据等级**：**E3a**（理由：附可跑的最小复现物 `/tmp/bughunt-opencc/oc-orphan-remove.test.ts`，**真实 import 并执行了被测模块 `initInstanceSupervisor()` 本身**，注入 fake `spawn` / `probePort` 门，仅把「起一个真进程」换成「记录 fake child 是否被 kill」；未用 `vi.mock` 替换被测对象。被测的是 supervisor 模块自身行为，不涉 React 树，故为 E3a 而非 E3b。）

- **执行环境**：运行时 Node v22.22.3（产品运行时，`tsx` + `bun-protocol.mjs` loader） · 工具链 vitest 5.0.3 · 平台 darwin-arm64
  - 为什么这个环境代表用户：产品就是 Node-direct（`packages/zai/src/cli/index.ts` 的 dev 入口）。本条只依赖 `instanceSupervisor.ts` 的纯逻辑 + `EventEmitter` 语义，与运行时无关；在 Bun 下结论只会更宽松（`entry.child` 为 null 与运行时无关），不会翻转为假绿。

- **位置**：
  - **缺陷点**：`packages/zai/src/server/services/instanceSupervisor.ts:581`（`doRemove` 里 `if (entry.child) await doStop(id)`）
  - **配套缺口**：`packages/zai/src/server/services/instanceSupervisor.ts:582`（`entries.delete(id)`）
  - **闸门缺口**：`packages/zai/src/server/routes/instances.ts:306-310`（DELETE 未被 `serializeLifecycle` 包裹，对比同文件 `:221` / `:237` / `:260` 三个 start/stop/restart 都被包裹了）
  - **回收盲区**：`packages/zai/src/server/services/instanceSupervisor.ts:687`（`shutdown()` 遍历 `entries.values()`）、`:590-592`（`tickHeartbeat` 同样遍历 `entries.values()`）

- **触发路径**：
  用户在实例列表点「启动」→ `startInstance('i1')` (`instanceSupervisor.ts:635`) → `doStart` (`:387`) → `runStart` (`:402`) → `setStatus({state:'starting'})` (`:404`) → **在此刻 `entry.child === null`**
  → 同时用户在 UI 点「删除」→ `DELETE /api/instances/i1` (`routes/instances.ts:306`) → `removeInstance('i1')` (`:643` 定义) → `doRemove` (`:578`) → **`:581` 判 `entry.child` 为 null → 整个 `doStop` 被跳过** → `:582` `entries.delete('i1')` 删除定义
  → 端口探测完成，`runStart` 恢复执行 → `deps.spawn(...)` (`:510`) → **出错点**：`attachChild(entry, child)` (`:521`) 把一个**活着的子进程**绑到一个**已不在 `entries` 里的 Entry 对象**上
  → 此后 `shutdown()` (`:687`) 与 `tickHeartbeat` (`:592`) 都遍历 `entries.values()`，**永远看不到它**。

- **现象**：预期 —— 用户删除实例，该实例的子进程应当被终止、端口应当释放；实际 —— 返回 200、UI 上实例消失、但子进程被 spawn 且**从未收到任何信号**，`getSnapshots()` 里也查不到它。

- **影响**：泄漏的 zai 子进程长期占用一个端口并在其 workspace 上持续提供服务；用户后续重启/复用该端口会因 `assertPortAvailable` 失败而报错，且没有任何 UI 入口能停掉它；用户退出 zai 时 `shutdown()` 也带不走它，必须手动杀进程。这正是上一届核心发现「状态分散在多个注册表，移除路径只清了其中几个」的同构问题在 `entries` 之外的又一个变体。

- **对照组**（见 README §4.7）：
  - **对照组是什么**：同一条复现物、同一个 `starting` 窗口、同一套 fake deps，只改**动词**或**时机**。我拆成**三个独立进程**跑 —— 这是必须的：`initInstanceSupervisor` 装的是**模块级单例**，`spawned` 数组也在模块级。第一次我把三个场景塞进同一个 vitest 进程，实测跑出 `children spawned : 2` —— 前一个场景仍停在 probe 里的循环醒来后把 child 推进了**下一个**场景的数组，对照组被污染（这正是 §3.2 坑 6）。因此改为 `SCENARIO` 环境变量，每场景一个进程。
  - **对照组输出**（三个进程，全部 `exit=0`）：
    ```
    SCENARIO=remove  spawned=1 killed=[false] visibleAfterDelete=0 visibleNow=0
    SCENARIO=remove  after-shutdown killed=[false]
    SCENARIO=stop    spawned=1 killed=[true]  stillVisible=1
    SCENARIO=norace  spawned=1 killed=[true]
    ```
  - **它为什么有区分力**：
    - `stop` 是**同窗口同时机只换动词** → child 被 kill（`killed=[true]`）。证明窗口本身是真的、探针门有效，且 `doStop` 走 `:549` 的 `inFlightStarts` 排队路径能正确处理。
    - `norace` 是**同动词只挪出窗口** → child 被 kill（`killed=[true]`）。证明 `doRemove` 本身不漏，只是 `:581` 那个 `entry.child` 判据在窗口内失效。
    - 只有 `remove`（窗口内 + 这个动词）得到 `killed=[false]`。**两个对照组分别隔离掉「动词」和「时机」两个变量，只剩组合是触发条件。**
  - **状态复位**：每场景独立进程 + `spawned` 数组在该进程内初始化；数据目录显式指向 `/tmp/bughunt-opencc/zai-home`；`writeFile` 注入 no-op 不落盘。

- **复现步骤**：
  1. 准备一个**已存在**的定义 `i1`（注意：不能用 `createInstance`，因为 `instanceSupervisor.ts:643` 里它 `await doStart`，天然无法与删除竞态 —— 这也是该 bug 容易被漏判的原因）。
  2. 调 `startInstance('i1')` **但不 await**，让 `probePort` 把窗口撑开（此时 `state==='starting'`、`entry.child===null`）。
  3. 窗口内调 `removeInstance('i1')` —— 它会立即返回（因为 `:581` 跳过了 `doStop`，不需要等 in-flight start）。
  4. 放开端口探测门，等 `startPromise` 结束。
  5. 观察：`spawned.length===1` 且 `spawned[0].killed===false`，`getSnapshots()` 里已无 `i1`。
  6. 再调 `shutdown()` —— child 依旧 `killed=false`。

- **复现命令与输出**：
  ```bash
  $ for S in remove stop norace; do
      SCENARIO=$S ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home \
        pnpm --filter @zn-ai/zai exec vitest run \
        --config /tmp/bughunt-opencc/vitest.repro.config.ts \
        /tmp/bughunt-opencc/oc-orphan-remove.test.ts \
        > /tmp/bughunt-opencc/repro-oc001-$S.log 2>&1; echo "$S exit=$?"
    done
  remove exit=0
  stop exit=0
  norace exit=0

  $ cat /tmp/bughunt-opencc/result-remove.txt /tmp/bughunt-opencc/result-stop.txt /tmp/bughunt-opencc/result-norace.txt
  SCENARIO=remove spawned=1 killed=[false] visibleAfterDelete=0 visibleNow=0
  SCENARIO=remove after-shutdown killed=[false]
  SCENARIO=stop   spawned=1 killed=[true]  stillVisible=1
  SCENARIO=norace spawned=1 killed=[true]

  $ grep -E "Tests " /tmp/bughunt-opencc/repro-oc001-remove.log
        Tests  1 passed (1)
  ```
  复现物：`/tmp/bughunt-opencc/oc-orphan-remove.test.ts`，配置：`/tmp/bughunt-opencc/vitest.repro.config.ts`（把 `include` 指向 `/tmp` 以保证仓库工作树零写入）。**与 §3.4 typecheck 基线的差集：无 —— 本条不含 typecheck 证据。**

- **不可触发自证**：不适用（本条已实测复现）。但可达性正面说明如下（按 §4.2.1，虽然 E3a 非强制，仍回答）：
  - **① 谁创建这个状态**：制造「`entry.child === null` 且 `status.state === 'starting'`」这个状态的**唯一**构造点是 `instanceSupervisor.ts:404` 的 `setStatus(entry, { state: 'starting', ... })` + `:521` 之前 `entry.child` 尚未被 `attachChild`（`:339`）赋值这段窗口。全仓只有 `runStart` 一处把状态置为 `starting`。
  - **② 生产默认配置下可达吗**：**可达，无需任何非默认开关。** 窗口的物理来源是 `runStart:424` 的 `await deps.probePort(INSTANCE_BASE_PORT)` —— 生产实现 `probePortDefault`（`:182`）最多循环 100 次 `await listen()`，加上 `assertPortAvailable`（`cli/ports.ts:106`）的存活探测 + bind + close，都是真实的异步挂起点。`routes/instances.ts:306` 的 DELETE 没有 `ensureNotInstanceChild` 之外的任何拦截（只挡 `CURRENT_INSTANCE_ID`），`weixinDedicatedInstance`、`aaClient/reverseDispatch`、supervisor 自身的 IPC restart 都是**绕过 HTTP 层**的直接调用方——这与上一届 `startingWindow.test.ts` 头部注释里写的「真正踩得到的是绕过该闸的调用方」是同一批入口。UI 上 `Instances.tsx:474` 有删除按钮。
  - **③ 现有防护为什么挡不住**：我逐条核过 —— ① `doStart:389` 的 `if (state==='starting') return` 只挡**重入 start**，不挡 delete；② `doStop:548-549` 新加的 `inFlightStarts` 排队**只写在 `doStop` 内部**，`doRemove` 在 `:581` 压根没进入 `doStop`，所以这道新闸**根本没被触达**；③ `routes/instances.ts:44` 的 `serializeLifecycle` 只包了 `:221/:237/:260`，**DELETE 在 `:306` 不在其列**；④ `attachChild:374` 的 stale-child 守卫只比对 `entry.child`，**不检查该 Entry 是否还在 `entries` 里**。四道防线没有一道覆盖「entry 已从 map 移除但仍有 in-flight start」这个状态。

- **修复方案**：
  1. **主修**（治本，最小改动）：`doRemove` (`:578`) 改成先排队再决定，与 `doStop` 对齐：
     ```ts
     const doRemove = async (id: string) => {
       ensureNotCurrent(id)
       const pending = inFlightStarts.get(id)
       if (pending) await pending.catch(() => {})
       const entry = getEntry(id)
       if (entry.child) await doStop(id)
       entries.delete(id)
       ...
     }
     ```
     等 in-flight start 落地后再走 `doStop`，child 一定会被 kill。
  2. **加固**（防御纵深）：`attachChild` (`:339`) 开头加一条断言 —— 若 `!entries.has(entry.def.id)` 则立即杀掉刚 spawn 的 child 并抛出，避免任何未来调用方再次制造孤儿。
  3. **顺带**：`routes/instances.ts:306` 的 DELETE 也应包进 `serializeLifecycle`（与其余三个动词对齐）。
  - 副作用注意：改动 1 会让「窗口内删除」最多等到 start 结束（一次端口探测），比现在「立即返回但留下孤儿」慢一点，但语义正确。

- **上游对照**：未查（不影响计分）。

---

### [oc-002] 标题：新建的 `claude` 子 agent provider 被 UI 下拉框提供、选中后保存必 400，且失败后**粘住**，连带整个工厂设置存不下去

- **严重度**：S2（理由：API 对合法 UI 输入返回 400 —— 命中 §4.3「API 返回错误结果 / 权限判定错误」一档。且失败是**粘性**的，用户不手动改下拉框就再也存不了任何工厂设置，并连带丢掉同一次保存里的 `docsDir` / `repoRoot` / `maxParallelTasks` / `historyArchiveHours` 四项编辑。）

- **证据等级**：**E3b**（理由：起了隔离实例，打**真实 HTTP 端点**，断言**真实响应体与状态码** —— §4.2 对 HTTP 缺陷明确要求「起隔离实例打真实端点」即 E3b。前端那段（下拉框为什么会出现 `claude`）是 E1 级的静态论证，但我没有把它单独当缺陷报，而是作为同一条根因的触发条件。）

- **执行环境**：运行时 Node v22.22.3（产品运行时，Node-direct dev 实例） · 工具链 vitest 5.0.3 / curl · 平台 darwin-arm64
  - 为什么这个环境代表用户：这就是用户实际跑 `pnpm --filter @zn-ai/zai dev` 的形态（`packages/zai/src/cli/index.ts` 的 Node-direct 路径），且 `dev.log` 自报 `[zai] dev token: …` / `API server on http://localhost:7715` / `Web server on http://localhost:8101`，前端 Vite 与后端 API 都是真实启动的。

- **位置**：
  - **契约两端的错配**：`packages/zai/src/server/routes/superTasks.ts:90`（`CLI_AGENT_NAMES = ['opencc', 'claude', 'dsh', 'opencode']`，含 `claude`） **vs** `packages/zai/src/server/services/factorySettings.ts:65`（`preferCliAgent: z.enum(['opencc', 'dsh', 'opencode'])`，**不含** `claude`）
  - **缺陷点（把 UI 值原样发出去的 cast）**：`packages/zai/src/web/src/components/superTasks/FactorySettingsDrawer.tsx:307`
  - **缺陷点（无条件提交 + 失败不清 state）**：`packages/zai/src/web/src/components/superTasks/FactorySettingsDrawer.tsx:134` 与 `:139-141`
  - **拒绝点**：`packages/zai/src/server/routes/superTasks.ts:163-169`（`safeParse` 失败 → `res.status(400)`）

- **触发路径**：
  用户在 super-tasks 面板点「注册 claude」→ `POST /api/super-tasks/spawn-agents/claude/register`（`superTasks.ts:232`，写 `subagents.claude.enabled=true`，返回 `restartRequired`）→ 重启 zai → 打开工厂设置抽屉 → `GET` 探针列表（`superTasks.ts:210-219`，遍历 `CLI_AGENT_NAMES`，`claude` 因已注册而 `active:true`）→ `FactorySettingsDrawer.tsx:109` `setAgents(a)`
  → 下拉框 `options={agents.map(a => ({ value: a.name, disabled: !a.active, ... }))}`（`:308-312`）**把 `claude` 列成了一个可选值**
  → 用户选中 → `onChange` 用 **`(v ?? null) as Draft['preferCliAgent']`**（`:307`）把 `'claude'` 硬 cast 进一个**只声明了 `'opencc' | 'dsh' | 'opencode' | null`** 的类型（`:41`）—— 这个 cast 关掉了本该拦下它的编译期检查
  → 点保存 → `:134` `preferCliAgent: draft.preferCliAgent` **无条件**提交（注意同函数 `:126-129` 的其它三项都做了条件展开）→ `superTaskApi.ts:161-165` 原样序列化
  → **出错点**：`superTasks.ts:163` `factorySettingsPatchSchema.safeParse` 失败 → `:165-169` 返回 **400**

- **现象**：预期 —— 下拉框只提供 schema 接受的值，选中即能保存；实际 —— UI 提供 `claude`、zod 只认三个值，选中保存必得 400；`catch`（`:139-141`）只弹一个 toast，**既不 `setSettings(dto)` 回滚、也不清 `draft.preferCliAgent`**，于是下拉框继续显示 `claude`，**此后每一次保存都重复 400**，用户被卡死。

- **影响**：走的是 `7c32e4da feat: 拆分 claude / opencc 两个子 agent provider` 这条新特性**主推的正常流程**（注册 → 重启 → 选用），结果最后一步 400。用户在 UI 上无法完成任何一次工厂设置保存，且因为 `preferCliAgent` 无条件提交，一次 400 会让同批次的 `docsDir` / `repoRoot` / `maxParallelTasks` / `historyArchiveHours` 四项编辑**全部丢失**。

- **对照组**：
  - **对照组是什么**：同一个运行中的实例、同一个端点、同一个 auth token，**只改 `preferCliAgent` 的取值**。再补一条「改另一个字段」来证明端点本身可达且鉴权通过。
  - **对照组输出**：
    ```
    === EXPERIMENT: PUT preferCliAgent=claude (a value the UI Select offers) ===
    HTTP 400
    {"error":"invalid factory settings","detail":["preferCliAgent: Invalid enum value. Expected 'opencc' | 'dsh' | 'opencode', received 'claude'"]}

    === CONTROL: PUT preferCliAgent=opencc (a value the UI Select offers AND the schema accepts) ===
    HTTP 200
    {"docsDir":"","repoRoot":"","maxParallelTasks":4,"preferCliAgent":"opencc","historyArchiveHours":48,...}

    === CONTROL 2: PUT docsDir only (proves the endpoint itself is reachable/authed) ===
    HTTP 200
    {"docsDir":"/tmp/bughunt-opencc/zai-home",...,"docsDirExists":true,...}
    ```
  - **它为什么有区分力**：`opencc` 与 `claude` **都**在下拉框里（`options` 来自同一个 `agents` 数组），但一个 200 一个 400，唯一变量就是**枚举值本身** —— 这排除了「端点不通 / token 不对 / 端点只接受特定字段」三种替代解释。CONTROL 2 进一步证明端点与鉴权都正常。
  - **状态复位**：实验跑在**独立进程 + 独立端口 + 隔离数据目录**上（与 9201 的用户实例完全无关），收口时已停掉并确认 8101 释放。实验组写入的值落在 `/tmp/bughunt-opencc/zai-home/factory-settings.json`，未污染任何真实数据。

- **复现步骤**：
  1. `POST /api/super-tasks/spawn-agents/claude/register`，重启 zai。
  2. 打开工厂设置抽屉 → 「首选 CLI Agent」下拉框 → 选 `claude`。
  3. 点保存 → 观察到 400 与 `Invalid enum value … received 'claude'`。
  4. **不改动下拉框，再点一次保存** → 仍然 400（证明粘性）。
  5. 同时改动 `docsDir` 等其它字段一起保存 → 那几项也一并丢失。

- **复现命令与输出**：
  ```bash
  $ cd /Users/ethan/code/opencc-web/packages/zai && \
    ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home pnpm run dev -- --port 8101 --api-port 7715 \
    > /tmp/bughunt-opencc/dev.log 2>&1 &
  # dev.log:
  #   [zai] dev token: 4c53fe767b6ccf29e6530002e42942c3
  #   [zai] API server on http://localhost:7715
  #   [zai] Web server on http://localhost:8101

  $ curl -s -w "HTTP %{http_code}\n" -X PUT http://localhost:7715/api/super-tasks/settings \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
      -d '{"preferCliAgent":"claude"}'
  HTTP 400
  {"error":"invalid factory settings","detail":["preferCliAgent: Invalid enum value. Expected 'opencc' | 'dsh' | 'opencode', received 'claude'"]}

  $ curl -s -w "HTTP %{http_code}\n" -X PUT http://localhost:7715/api/super-tasks/settings \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
      -d '{"preferCliAgent":"opencc"}'
  HTTP 200
  {"docsDir":"","repoRoot":"","maxParallelTasks":4,"preferCliAgent":"opencc","historyArchiveHours":48,...}
  ```
  **与 §3.4 typecheck 基线的差集：无 —— 本条不含 typecheck 证据。**（值得指出：`:307` 那个 `as Draft['preferCliAgent']` 正是**把编译期能抓到的错误压下去**的手法；若当初不 cast，typecheck 就会红。这也从反面印证了 §8「typecheck 绿不代表没 bug」。）

- **不可触发自证**：不适用（已实测）。按 §4.2.1 补充可达性：
  - **① 谁创建这个状态**：`claude` 进入下拉框的唯一来源是 `superTasks.ts:90` 的 `CLI_AGENT_NAMES` 常量 → `:210-219` 探针循环把每个 name 吐进 `agents` 数组 → `FactorySettingsDrawer.tsx:109` 存进 state → `:308-312` 无过滤地映射成 options。`:307` 的 cast 是让 `'claude'` 能进入 `Draft` 的唯一关口。
  - **② 生产默认配置下可达吗**：**完全可达，是默认路径，不需要任何开关。** `claude` 是 `7c32e4da` 专门加进 `CLI_AGENT_NAMES` 的新 provider，用户按 UI 提示注册 + 重启即可 `active:true`（注册入口 `superTasks.ts:232` 对 4 个 name 一视同仁）。不需要 env、不需要 `--lan`、不需要任何只在测试里设的值。
  - **③ 现有防护为什么挡不住**：① `Draft` 的 TS 联合类型本该拦下，但 `:307` 用 `as` cast **主动绕过了它**；② 服务端 `z.enum` 确实拦住了（所以数据没被写坏），但它只把请求打回 400，**没有告诉前端「这个值根本不该出现在下拉框里」**；③ 前端没有任何「哪些 agent name 可被选用」的过滤或按 `activeNames` 求交集的逻辑；④ `catch` 块（`:139-141`）只 toast 不回滚 `draft`，**没有 finally 恢复 `draft.preferCliAgent`**，于是错误值一直留在 state 里。

- **修复方案**（二选一，推荐 A）：
  - **A（治本，推荐）**：让 `preferCliAgent` 的取值域与 provider 注册表一致 —— 把 `factorySettings.ts:65` 的枚举扩为 `z.enum(['opencc','claude','dsh','opencode'])`，同步 `factorySettings.ts:32`、`:106-108` 的白名单、`FactorySettingsDrawer.tsx:41` 的 `Draft` 类型、`superTaskApi.ts:126` 的 DTO 类型。**理由**：`7c32e4da` 已经把 `claude` 做成了正式 provider，`preferCliAgent` 不认它才是异常的一方；只改前端会再次埋雷。
  - **B（若 `preferCliAgent` 语义上确实只支持那三个）**：在 `FactorySettingsDrawer.tsx:308-312` 把 `options` 过滤成 schema 接受的子集，并**删掉 `:307` 的 cast**（让类型系统重新生效）；同时把 `:134` 改成与其它三项一致的条件展开，避免一个坏字段连坐整次保存；`:139-141` 的 catch 里补一次 `draft` 回滚。
  - 副作用注意：方案 A 会放宽落盘校验，需确认 `preferCliAgent` 的下游消费者（`factorySettings.ts:14` 注释提到用于「任务调度器提示词」）能正确处理 `claude`。

- **上游对照**：未查（不影响计分）。注：`preferCliAgent` 是 zai 侧字段，上游 opencc 大概率没有对应物。

---

## 四、汇总表

| ID | 标题 | 严重度 | 证据等级 | 位置 |
|---|---|---|---|---|
| oc-001 | `starting` 窗口内 DELETE 实例 → 子进程被 spawn 后永不回收，且从 supervisor 视野消失 | S2 | E3a | `packages/zai/src/server/services/instanceSupervisor.ts:581`（+ `routes/instances.ts:306`） |
| oc-002 | UI 提供的 `claude` 不在 `preferCliAgent` 枚举内 → 保存必 400 且粘住，连带整次工厂设置保存失败 | S2 | E3b | `packages/zai/src/web/src/components/superTasks/FactorySettingsDrawer.tsx:307`（+ `services/factorySettings.ts:65`） |

**正式报告条目数**：2　**其中 E0 条数**：0

---

## 五、不确定与自我否定清单

> 这一节不参与扣分。以下都是我怀疑过、追过、但**没有**达到正式报告标准的线索，全部如实列出。

| 线索 | 位置 | 为什么站不住 / 为什么没能证实 |
|---|---|---|
| 上一届 `oc-001` 同款 —— 设了 `ZAI_DATA_DIR` 仍读写真实 `~/.zai/settings.json` | `services/paths.ts:23` | 我实测了**我走的那条路径**（工厂设置）隔离是生效的：写入落在 `/tmp/bughunt-opencc/zai-home/factory-settings.json`，且 `~/.zai/factory-settings.json` 根本不存在。但 `find ~/.zai -newermt '-10 minutes'` 确实列出了 10 个近期被改的真实文件，**我无法归因**（用户 9201 实例在跑 + 我这条 agent 会话自身在写 memory）。要做实需要停用户实例，我没做。**所以我不报这条 —— 既不能证明它成立，也不能证明它已修** |
| 离线通知补发的 noticeStore 清理只挂在 6 条触发路径中的 1 条上 | `services/aaClient/noticeStore.ts:83-92`、`reverseDispatch.ts:2032` | 机制我读下来像是真的（只有 AA `session.interrupt` RPC 会调 `resolveNoticesForZaiSession`；`runtime.aborted` 走 `eventAdapter.ts:198` → `:668-671` 只映射成 timeline item，不碰 noticeStore）。**但按 §4.2.1 第②问它塌了**：`isAaEnabled()` 要求 `ZAI_AA_ENABLED==='1'`，只由 `--aa` 命令行 flag 设置，help 文本自己写着 "Default: local-only"。普通 `pnpm dev` 根本不构造 `OfflineBuffer` —— 这正是上届 `wb-010` 塌掉的方式，我不想重复 |
| 同上：「delivered 只看 `getStatus().state==='connected'` 就推进游标，`ws.send()` 没给回调」 | `services/aaClient/offlineBuffer.ts:150-154`、`connection.ts:613` | 推理链完整，但同样被 `--aa` 门挡住，且我没读 `ws` 库源码验证「无回调时 send 是否真的静默丢弃」，属于未验证 |
| 同上：`stop()` 只翻布尔量，`initOfflineBuffer` 起的 1s 轮询 `setInterval` 从不 `clearInterval`（该文件 `clearInterval` 出现 0 次） | `services/aaClient/offlineBuffer.ts:78,83-85,229` | 机制成立但**当前生产不可达**（`initOfflineBuffer` 只被调一次且有 `getAaConnection()` 守卫），最多是测试隔离隐患。按 §4.2 应按 S4 计，不值得占正式条目 |
| `killChildTree` 在 group-kill 之前就 early-return，导致 `sh -c 'sleep 120 & exit 0'` 的孙进程变孤儿 | `server/utils/killTree.ts:28` | 由子 agent 报告并称「用独立脚本复现过」，**我自己没有复现也没有读那段脚本**（时间不够）。且我担心 `ReplSession.ts:245` 的 `finish()` 会把 `this.child` 置空、导致根本走不到 `killChildTree` —— 这会让它从「漏杀」降级为「不可达」。**未经我亲自验证，不进正式报告** |
| `attach()` 注册的任务永不消费 inbox（`DefaultBackgroundRuntime.ts:263` 建 `running` 记录但不调 `runOne`） | `compat/background/DefaultBackgroundRuntime.ts:631` | 同上，子 agent 静态推理，我未复现，且需要构造真实子 agent 工具调用链，超出我剩余时间 |
| `cli/subagents/opencc` 与 `claude` 两个 provider 共存时，registry 可能互相覆盖 | `compat/subagents/opencc/index.ts`、`claude-code/index.ts` | 子 agent 明确报告「未发现覆盖，registry 按 name 分键」。我倾向相信但没自己核，**不报** |
| `z.enum` 之外，前端 DTO `superTaskApi.ts:126` 与服务端 `factorySettings.ts:32` 也各写了一份 `'opencc' \| 'dsh' \| 'opencode'` —— 同一取值域散落 5 处 | 多处 | 这就是 oc-002 的**根因**，我已并入 oc-002 一条（§4.6：同一根因的多个表现算一条），没有拆成第 3 条 |

**我还看过但确认干净的地方**（供裁判抽查我的覆盖面）：`openccInit` 的幂等闩（`if (initPromise === attempt)` 的写法能正确避开误删后一次重试的登记，失败前的副作用都是幂等 env 写入）；`doStop` 的 `starting` 窗口处理（`:549` 排队 + `runStart:523` 先把状态落 `down` 再 reject，顺序正确，无双 spawn）；`routes/instances.ts` 四个生命周期 handler 均有 try/catch + `handleError`，无 Express 4 未捕获 async rejection。

---

## 六、给裁判的一句话

这一届我刻意**只交 2 条**，但两条都做过实跑复现、都有能区分变量的对照组，且都出自上一届**不到一天前**刚落地的新代码 —— `oc-001` 出自「starting 窗口不再静默丢弃 stop」这条修复（它把新闸加在了 `doStop` 里面，却漏掉了 `doRemove` 这个唯一不经过 `doStop` 的删除路径），`oc-002` 出自「拆分 claude / opencc 两个子 agent provider」这条新特性（provider 加进了 UI 探针名单，却没加进 `preferCliAgent` 的 zod 枚举）。我的判断是：**这个仓库当下的主要缺陷面已经不在旧代码里，而在「上周刚修的地方」** —— 修复方案本身成了新的排查面，而 typecheck 因为 `as` cast 和注释充分而完全看不见它们。另外提醒一处我主动放弃的高价值面：`aaClient` 那整条离线通知链的机制问题几乎都是真的，但被 `--aa`（默认 local-only）整条挡住，这跟上一届 `wb-010` 的塌法一模一样 —— 建议下一届直接把 `--aa` 场景纳入默认基线，否则这块永远只能出 S4。
