# 修复报告 · 批 6 下半 + 批 7

> **基线**：`5dedfe4d`（`main`，接手时工作树干净）
> **范围**：批 6 下半 4 条（oc-004 / oc-003 / wb-011 / wb-010）+ 批 7 4 条（cc-003+cc-004 / wb-012 / oc-002）
> **状态**：7 条已修，1 条未修（wb-010，与铁律冲突，见 §8）
> **改动范围**：全部落在 `packages/zai/`；**`packages/zn-agent-core/src/opencc-src/` 零改动**（`git status` 已验证）
> **未 commit**，改动留在工作树待审阅

---

## 0. 总结表

| ID | 状态 | 改动文件 | 回归测试 |
|---|---|---|---|
| **oc-004** | ✅ 已修 | `routes/desktopWallpaper.ts` | `desktopWallpaper.test.ts`（新增 1 条） |
| **oc-002** | ✅ 已修 | `routes/desktopWallpaper.ts` | `desktopWallpaper.test.ts`（新增 1 条） |
| **oc-003** | ✅ 已修 | `aaClient/noticeStore.ts`、`aaClient/reverseDispatch.ts` | `test/aaClient/noticeInterruptCleanup.test.ts`（新增 3 条） |
| **wb-011** | ✅ 已修 | `routes/agent.ts` | `test/server/agentQueueDeletedSession.test.ts`（新增 2 条） |
| **wb-010** | ⛔ **未修** | —（修复点在 vendor,与铁律 #2 冲突） | — |
| **cc-003** | ✅ 已修 | `web/store/useAgentStore.ts` | `test/web/store/useAgentStore-sessionSwitch.test.ts`（新增 3 条） |
| **cc-004** | ✅ 已修 | `web/store/useAgentStore.ts` | 同上（新增 2 条） |
| **wb-012** | ✅ 已修 | `routes/fs.ts`、`splitPane/FsContextMenu.tsx` | `routes/fs.openTerminal.test.ts`（新增 5 条） |

**统一验证**：`pnpm -r exec tsc --noEmit` → **0 error**；受影响子系统回归 **57 文件 / 590 passed / 1 skipped**。

> **本报告经独立 code review**,评审发现 oc-004 首版修复自己引入了一个新竞态（§1 的「首版修复自己引入了一个新竞态」），已修并补了确定性回归。评审对另外两条提出的疑虑也一并核实过：unbounded `deletedSessions`（核实 sid 来自 randomUUID、不复用,与 core 既有先例同构,非问题）、oc-004 并发测试偏弱（认了 —— 它证明「不该被删」,不证明「清理有效」,后者由既有「只保留最新一张」用例覆盖）。

> **⚠️ 过程中的事故（如实记录）**：验证竞态修复期间，工作树被**外部进程**清空了 —— 8 个已改文件被某个 `acc-baseline` stash 收走,4 个未跟踪的新测试文件与本报告一度全部消失。已从 `stash@{0}` 完整恢复（`git stash pop`,已 Dropped）,并把 diff + 全部新文件备份到 `/tmp/wb-backup/`(7 个文件 / 84KB)后才继续。**恢复后重新跑了全部验证,结果与事故前一致。** 若你在别处看到 `acc-baseline` 这个 stash 名,那是这次事故的现场,不是你的。
>
> 另:本会话期间 HEAD 从 `5dedfe4d` 被外部进程推进到 `7c32e4da`(「拆分 claude / opencc 两个子 agent provider」)。**那个提交不是我做的**,改的是 superTasks / agentRuntime / subagents,与本批 8 条无任何文件重叠,我的改动仍全部留在工作树未提交。

---

## 1. oc-004 — 并发清理竞态导致 N 个上传全 404 且 200 假成功

### RED 证据

新增用例「并发 N 次 PUT → N 个返回的 URL 全部 GET 200」在修复前：

```
AssertionError: expected [ 404, 404, 404, 404, 404, 404 ] to deeply equal [ 200, 200, 200, 200, 200, 200 ]
```

> **与计划描述的差异（重要）**：计划写「N 个并发上传**全部** 404」读起来像「N 个里的若干个」，实测是 **6 个 URL 全部 404**。原因是竞态比预想的更彻底 —— 每个 PUT 各自 fire-and-forget 一次清理，而**没有任何一个清理知道自己不是最后一次**，于是每一次清理都在删别人的文件，最终目录被清空。比「N-1 个 404」更严重，修复的必要性更强。

### 修法

不用计划给的「mtime 比本次写入更旧」（那需要额外 stat 竞态），改为**计划里并列的第一个方案：清理与写入共用一把互斥**，并加一个上传窗口保护集：

- `withWallpaperLock(dir, fn)` —— 目录级 promise 链，写入与清理共用，锁链自身吞错误避免一次失败卡死后续写入；
- `armCleanup(dir, name)` —— 写入后把文件名记进该目录的 `protectedNames`，并重置一个 300ms 静默期定时器；
- `sweepOldWallpapers(dir)` —— 静默期结束后跑，只删**不在 `protectedNames` 里**的旧文件。

不变量：**响应 200 的那一刻，它的文件一定可读，且此后至少再活一个静默期**。顺序上传的旧壁纸照常被回收（既有的「目录只保留最新一张」用例仍通过）。

### GREEN 证据

```
$ pnpm --filter @zn-ai/zai test src/server/routes/desktopWallpaper.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)      # 原 4 条 + 新增并发回归 + 新增 oc-002 头断言
```

### 附带修正

`timer.unref?.()` —— 定时器不能拖住进程退出。

### ⚠️ 首版修复**自己引入了一个新竞态**(独立评审发现,已修)

把 `protectedNames` 的快照/清空放进锁里之后仍有一条通道:静默期定时器的回调**先把 `st.timer` 置 null,再把 sweep 排到锁后面**。若此刻另一次写入正持锁,该写入随后完成时 `armCleanup` 看到 timer 已是 null,就又排一个新定时器;排在前面的 sweep 跑完会清空 `protectedNames`,后一个定时器就带着**空快照**去扫 —— 把刚返回 200 的文件删掉,症状与 oc-004 一模一样:

```
t=280   PUT B 进锁,writeFile 被拖慢
t=300   timer₁ 触发 → st.timer=null → sweep 排在 B 后面
t=630   B 写完 → armCleanup:protected={A,B};timer 是 null → 再排 timer₂
t=631   sweep 跑(keep={A,B},删不到东西)→ protectedNames={}   ← 抹掉保护
t=931   timer₂ 触发 → keep={} → 把 B 也 unlink
```

B 在 t=630 返回 200,文件 300ms 后没了。

**修法**:`DirState` 加 `sweepPending` 标志。定时器触发时置位、sweep 结束时(`finally`)复位;`armCleanup` 见其为真就**不再排新的** —— 排队中的 sweep 是拿到锁之后才读 `protectedNames`,必然看得见新加进去的 name。

**RED→GREEN 证据**(新增 `desktopWallpaper.race.test.ts`,把 writeFile mock 慢到 350ms 把交错放大成必然):

```
去掉守卫:  × 写入跨过静默期边界 → 刚返回 200 的 URL 不得在后续静默期后消失
            AssertionError: expected [] to include 'wmvc11m46-n2gv2w.png'
装回守卫:  Test Files  2 passed (2)
              Tests  7 passed (7)
```

> 复现这个交错花了三轮:第一版把「等第一轮窗口关闭」放在 PUT B **之前**,而 `waitForDir` 立刻返回(PUT B 落在 timer₁ **之后**),交错根本没发生 → **假 GREEN**。改成「A 上传 → 等 280ms → PUT B(写入耗时 350ms)」才让 timer₁ 必然落在 B 持锁期间。这条与 §6 是同一类错误:**先证明测试会红,再相信它绿**。

### 对既有测试的诚实修正

`desktopWallpaper.test.ts` 原有的「再次 PUT 会清理旧壁纸文件(目录只保留最新一张)」断言 `names.length === 1`,而**上传窗口内的文件是受保护的** —— 两次 PUT 挨得近时两张都会留下(这是 oc-004 修复的既定取舍:200 必须意味着文件活着)。原断言实际依赖两次 PUT 相距 >300ms 这个运气(实测连跑 5 次都过,但那是运气不是保证)。

已改成显式的两段等待:先等第一轮窗口关闭,再做第二次 PUT 并断言只剩最新一张。**放宽的是测试,不是产品** —— 语义仍是「窗口关闭后旧壁纸被回收」。

---

## 2. oc-002 — 壁纸端点缺 nosniff / CSP

### RED 证据

新增用例断言 SVG 回吐带 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox`，修复前两个 header 均 `undefined`。

### 修法

与 `fs.ts:1394-1395` **逐字对齐**（含注释风格），加在 GET 的 header 块里，位于 `Cache-Control` 之前。

计划中「这两道头在整个 server 只有 fs.ts 一处」已复核属实（`grep` 全仓无 helmet）。

---

## 3. oc-003 — AA 中断后 notice 卡片无自动回收

### RED 证据

新增 3 条用例，修复前 **3 条全红**：

```
× 中断后 noticeStore 里该 zai 会话的 notice 全部消失   （收到 [n1, n2]，期望 []）
× 中断只清自己会话的 notice,别的会话不受影响
× 超过 TTL 未被回答的 notice 不再被 listNoticesForSession 返回
```

### 读源码确认的机制

`handleInterrupt`（`reverseDispatch.ts:2023`）只 `forwardToChild`，不碰 noticeStore；唯一的回收点 `resolveNotice` 在 `handleInteractionRespond`（`:2054`）—— 而那条路要靠用户在 AA 侧**真的点一下**才会走到。

### 修法（两个都做了）

1. **`resolveNoticesForZaiSession(zaiSid)`**（新导出）—— 在 `handleInterrupt` 里转发**成功后**调用。
   ⚠️ 刻意放在转发之后：转发失败说明中断没生效，此时卡片仍应留着（子进程可能根本没中断）。
2. **`NOTICE_TTL_MS = 2h` + 惰性过期** —— 对齐 `routes/agent.ts:161` 的 `HARD_TIMEOUT_MS`（一个 turn 的绝对上限），超过它的 notice 不可能还有对应的 pending ask。惰性过期（读取时顺手清）而非定时器，保持模块无副作用。

### GREEN 证据

```
$ pnpm --filter @zn-ai/zai test test/aaClient/noticeInterruptCleanup.test.ts
 Tests  3 passed (3)

$ pnpm --filter @zn-ai/zai test test/aaClient/          # 整个 AA 子系统
 Test Files  17 passed (17)
      Tests  180 passed (180)
```

---

## 4. wb-011 — 队列车道给已删会话白烧 token

### RED 证据（这是本批最需要小心的一条）

第一次 RED 验证无效：`git stash` 整个 `agent.ts` 后测试报的是 `__resetSessionRunningForTests is not a function`（**测试 seam 本身被撤掉了**），不是判据失败。改用「只摘掉守卫、保留 seam」重做，得到干净证据：

```
AssertionError: expected 2 to be 1 // Object.is equality
 Tests  1 failed | 1 passed (2)
```

修复前确实起了**第二轮** LLM 调用，且对照组（未删除会话照常 drain）两侧都通过 —— 证明守卫没有误杀正常队列。

### 修法（与计划有出入，见下）

计划写「`agent.ts:1062` 的 `void runNextInQueue(sid)` 前加一次 `isSessionDeleted` 判短路」。**这条修法在本仓库不可直接执行**：

- `isSessionDeleted` 定义在 `packages/zn-agent-core/src/compat/runtime/deletedSessions.ts`，**未从 bundle-entry 导出**；
- `dist/compat/runtime/deletedSessions.js` **不存在**（只有 `.d.ts`，实现被打进 `opencc-core.mjs`）—— `node -e "import(...)"` 确认 dist 的导出里没有任何 delete 相关符号；
- `package.json` 的 `exports` 只允许 `.` 和 `./package.json`，子路径被 `exports` map 挡住；
- 从 zai 侧导出它需要改 `bundle-entry.ts` + 跑 `build:core`（会重编 7MB bundle 并改 `.d.ts`），超出本轮授权范围。

采用的等价修法（全部在已授权的 `packages/zai/src/server/routes/agent.ts` 内）：

1. 模块级 `deletedSessions = new Set<string>()`；
2. DELETE 路由里、`store.remove()` **之前** `deletedSessions.add(sid)` —— 与 `store.remove` 内部触发的 `markSessionDeleted`（core 写端守卫）同一时刻 arm，不存在「写入端走一处、失效端走另一处」的分裂；
3. **`runNextInQueue` 入口**判短路（不是计划说的 `:1062` finally 前）—— 三个调用点（wake handler / `wasIdle` 入队 / finally）共用入口守卫，**inbox 车道（子 agent `<task-notification>`）也一并挡住**；计划指定的 `:1062` 只是其中一条车道。顺带 `sessionQueues.delete(sid)`，否则条目永远滞留。

> **报告要点**：计划的修法形状不可直接落地（core 未导出该符号），已用等价的 zai 侧调度端守卫替代。若后续希望真正复用 core 的同一个 Set，正确做法是给 `bundle-entry.ts` 加一行导出并重编 core —— 那是一次需要单独授权的改动。

### 附带

新增测试 seam `__resetSessionRunningForTests()`（模块级 Map 跨用例残留会让「这一轮有没有起新 turn」的断言失真）。

### GREEN 证据

```
$ pnpm --filter @zn-ai/zai test test/server/agentQueueDeletedSession.test.ts
 Tests  2 passed (2)

$ pnpm --filter @zn-ai/zai test src/server/routes/agent.queue.test.ts \
    test/server/agentInboxIsMeta.test.ts test/server/busyFlush.test.ts
 Test Files  3 passed (3)
      Tests  47 passed (47)
```

---

## 5. cc-003 — 切会话不清 pendingAsk（确认从「竞态」升为「确定触发」）

### 计划要求的前置核实 —— 结论：**cc-003 不是竞态，是确定触发**

计划留了一个待核实项：「未核实服务端是否接受流式期间的 `/clear`」。已核实，链路完整：

1. `AgentInputBox.tsx:597` / `:1132` 两处 `/clear` 入口**均无 `isBusy` 前置**（读源码确认）；
2. 前端 `clearMessages()` 顺手把 `status` 置 `'idle'` → **直接解除 `isBusy` 门禁**，用户不必按 Esc 即可切走；
3. 服务端 `commands/builtin/clear.ts:23` 确实先 `await abortAgentSession('user_clear', sessionId)` 再 `store.replace(sessionId, [])` —— **服务端接受流式期间的 `/clear`**；
4. 而 `clearMessages` **不碰 `pendingAsk`** → 已解锁的会话里挂着一张无人可答的阻塞卡片，`AgentInputBox.tsx:282-283` 的 `sendBlocked = pendingAsk?.status === 'pending'` 把输入框锁死。

即计划推测的「S2 成立」成立：这是确定触发，不是竞态。

### 修法

`setCurrentSession`（`:1334`）/ `createNewSession`（`:1413`）/ `clearMessages`（`:1252`）三处都补 `pendingAsk: null`。

### RED / GREEN

```
修复前: × setCurrentSession 切到 B 后 pendingAsk 必须为 null
        × clearMessages 顺手清 pendingAsk
        × createNewSession 清 pendingAsk
        AssertionError: expected { toolUseId: 'toolu_A1', …(3) } to be null   ×3

修复后: Tests  5 passed (5)
```

---

## 6. cc-004 — 慢响应把用户刚切走的会话拽回来

### RED 证据（这里踩到一个会给出假 GREEN 的坑）

第一次跑，cc-004 的两条用例**没有红**。追查发现是我的 fixture 不对导致 `loadTranscriptMessages` 抛异常，而 `loadTranscript` 自己的 `catch { /* ignore */ }` 把异常**连同它后面的 `set` 一起吞掉** —— 「慢响应没把会话拽回来」和「响应根本没回来」在断言上长得一模一样。

第二个坑：`vitest.config.ts:14` 是 `environment: 'node'`，**没有 `localStorage`**，而 `loadTranscript` 第一行就是 `localStorage.getItem('zai-token')` → 同样抛 → 同样被吞。

两个坑都在测试里显式处理并写进注释（fixture 逐字段对齐 + `beforeAll` 补 `localStorage` stub），之后拿到真 RED：

```
× A 的慢响应回来时用户已切到 B → 不得覆盖 sessionId
  AssertionError: expected 'sess-A' to be 'sess-B' // Object.is equality
```

### 修法

严格按计划：`if (sessionId !== cur && cur !== null) return`。

> **我删掉了自己写的一条测试**：初版还有一条「`cur === null` 时不得建立会话」，比计划的守卫更严，跑出来是红的。核查后**判定这条测试越权** —— 计划明确保留 `cur !== null` 放行，且已警告「不能写成 `cur !== sessionId`，会误杀冷启动」。把当前行为固化成断言，等于替下一任作者决定了一个计划刻意留给人工判断的语义。已删除并在文件里留注释说明**为什么**不写这条断言。

冷启动对照组（`loadSessions` 先 `set({sessionId})` 再 `loadTranscript`）修复前后都通过，证明没误杀首屏。

---

## 7. wb-012 — 目录条目 path 结构上不可能带尾斜杠

### RED 证据

mock 掉 `node:child_process` 的 `execFile` 捕获真正传给终端启动器的 argv：

```
× kind=dir → 终端开在该目录本身(不是父目录)
  AssertionError: expected '-a Terminal /var/folders/…/zai-fs-term-xxx'
                  to contain '/var/folders/…/zai-fs-term-xxx/src/components'
× kind=dir 在嵌套目录上同样成立
```

另加一条「把前提钉死」的用例：`/fs/list` 返回的目录条目 `path.endsWith('/')` **恒为 false** —— 直接证明缺陷成因。

### 修法（服务端为主，比计划多一层）

计划写「前端把已有的 `kind` prop 传给服务端，服务端按 `kind` 而非字符串形状判断」。已做前端那半（`FsContextMenu.tsx` 的 `postFsCommand` 加 `kind` 形参并透传），**服务端多做了一步兜底**：

```
kind 给了 → 采信 kind
kind 没给 → 服务端 stat(safe.abs).isDirectory()   ← 不猜
stat 也失败 → 按文件处理（取父目录），与旧行为一致
```

理由：另有一个客户端路径 `useFilePathActions` → `lib/openFilePath.ts:105 callFsCommand` **发的是绝对路径且拿不到 kind**，只靠前端透传的话那条路仍然是坏的。服务端 stat 一次让服务端成为权威，两条路径一起修好，且不再有任何字符串形状判断。

### GREEN 证据

```
$ pnpm --filter @zn-ai/zai test src/server/routes/fs.openTerminal.test.ts \
    src/server/routes/fs.test.ts src/server/routes/fs.create.test.ts
 Test Files  3 passed (3)
      Tests  75 passed (75)

$ pnpm --filter @zn-ai/zai test src/web/src/components/splitPane/FsContextMenu.test.tsx src/web/src/lib
 Test Files  13 passed (13)
      Tests  124 passed (124)
```

---

## 8. wb-010 — 未修 ⛔（与铁律 #2 冲突，需裁决）

### 缺陷属实（读源码逐行确认）

`packages/zn-agent-core/src/opencc-src/tools/WebFetchTool/utils.ts`：

- **主路径** `:286` — `axios.get(url, { ..., lookup: ssrfGuardedLookup })` ✅ 有守卫
- **fallback** `:304-306` — `fetch(url, { signal, redirect: 'manual', headers })` ❌ **裸 fetch，无 lookup 注入**

`ssrfGuardedLookup`（`utils/hooks/ssrfGuard.ts:216`）是 axios `lookup` 选项的形状，注释明确说「让校验过的 IP 就是 socket 实际连的那个 IP —— 校验与连接之间没有 rebinding 窗口」。fallback 绕过它，DNS rebinding 窗口重新打开。

影响面收窄也已复核：`WebFetchTool.ts:117-120` 的 `isEnabled()` 要求 `OPENCC_WEBTOOL_ENABLE`，全仓仅 3 处提及（`builtin.ts:170` 注释 + `WebFetchTool.ts:119/120`），**zai 从不设置**，该工具默认不在工具池。属防御纵深，非当前在漏。

### 为什么不修

**修复点是 vendor 文件 `packages/zn-agent-core/src/opencc-src/tools/WebFetchTool/utils.ts`，而铁律 #2 明确写「特别是不要动 `packages/zn-agent-core/src/opencc-src/` 下的 vendor 代码」。**

铁律 #1 写明「违反即作废」，#6 要求「一条修不好就写清卡在哪、已排除什么，继续下一条」。**指令内部冲突时，我选择遵守不可违反的那条**（#2），而不是自行扩大授权。

我尝试用 `AskUserQuestion` 征求裁决（三个选项：只报告 / 授权改这一处 vendor / 本条放弃），**该工具被 mod 的 `tool.check` hook 拦截**，无法送达用户。故按 #6 记录在此。

### 待裁决的精确补丁（未应用）

`utils.ts:304-306`，把

```ts
const fetchResponse = await fetch(url, {
  signal,
  redirect: 'manual',
  headers: axiosConfig.headers,
})
```

改为携带同一个守卫（`undici ^8.9.0` 已在 `zn-agent-core` 依赖里，需经 `Agent({ connect: { lookup } })` 或等效机制把 `lookup` 注入 native fetch）：

```ts
const fetchResponse = await fetch(url, {
  signal,
  redirect: 'manual',
  headers: axiosConfig.headers,
  dispatcher: guardedAgent,   // undici Agent({ connect: { lookup: ssrfGuardedLookup } })
})
```

⚠️ 应用后必须 `pnpm run build:core`，否则测的是旧产物。

**建议**：这条与另外 7 条的紧急度不同级（工具默认不在池子里），可以单独排期；或若要修，先确认是否接受为 vendor 开一个仅限此文件的例外。

---

## 9. 与修复计划描述不符的发现（汇总）

1. **oc-004 危害被低估**：计划写「N 个并发上传全部 404」，实测是**全部 404**（目录被清空），比「N-1 个坏」更严重。
2. **wb-011 的修法形状不可落地**：`isSessionDeleted` 未从 core 导出、`dist` 里无独立 JS、`exports` map 挡子路径 —— 从 zai 侧无法引用。已用等价守卫替代（见 §4）。
3. **wb-011 的守卫位置应前移到函数入口**：计划指定 `:1062` 的 finally，只覆盖一条车道；入口守卫顺带覆盖 inbox 车道。
4. **cc-003 从「竞态」升为「确定触发」**：计划留的待核实项已核实成立（服务端接受流式期间 `/clear`）。按计划自己的说法，这提升了优先级；修法不变，已按确定触发处理。
5. **wb-012 服务端需多一层兜底**：计划的「前端传 kind」修不到 `useFilePathActions` → `callFsCommand` 那条路径（发绝对路径、无 kind）。已加服务端 stat。
6. **wb-012 计划描述的文件行号有一处偏差**：`FsContextMenu.tsx:17` 持有 `kind` prop 属实；但计划未提到 `useFilePathActions.tsx` / `lib/openFilePath.ts:105` 这第二个调用点。
7. **`loadTranscript` 的双层静默吞异常**（cc-004 调查副产品）：`localStorage` 缺失 / `loadTranscriptMessages` 抛异常，都会被 `catch { /* ignore */ }` 连同后面的 `set` 一起吞掉。这让任何针对该函数的回归测试都可能**假 GREEN**。已在测试文件里显式注释警示，但没有改产品代码（超出本轮范围）—— 若后续有人给 `loadTranscript` 加回归，务必知道这个坑。

---

## 10. 验证命令与结果汇总

```bash
# 类型检查(全 workspace)
$ pnpm -r exec tsc --noEmit
(无输出 = 0 error)

# 全部 7 条的回归 + 相关既有测试
$ pnpm --filter @zn-ai/zai test \
    src/server/routes/desktopWallpaper.test.ts \
    src/server/routes/fs.openTerminal.test.ts \
    src/server/routes/fs.test.ts \
    test/aaClient/noticeInterruptCleanup.test.ts \
    test/server/agentQueueDeletedSession.test.ts \
    test/web/store/useAgentStore-sessionSwitch.test.ts \
    src/web/src/components/splitPane/FsContextMenu.test.tsx
 Test Files  7 passed (7)
      Tests  95 passed (95)

# 受影响子系统回归(含全部新增测试)
$ pnpm --filter @zn-ai/zai test test/aaClient/ src/web/src/components/splitPane/ \
    test/web/store/ test/web/useAgentStore src/server/routes/agent.queue.test.ts \
    test/server/busyFlush.test.ts test/server/agentInboxIsMeta.test.ts \
    src/server/routes/desktopWallpaper.test.ts src/server/routes/desktopWallpaper.race.test.ts \
    src/server/routes/fs.test.ts src/server/routes/fs.create.test.ts \
    src/server/routes/fs.openTerminal.test.ts test/server/agentQueueDeletedSession.test.ts
 Test Files  57 passed (57)
      Tests  590 passed | 1 skipped (591)
```

未跑 `pnpm -r test` 全量（按铁律 #3）。未起任何真实服务、未碰 9201（铁律 #4）。涉及 `ZAI_DATA_DIR` 的用例均在临时目录（铁律 #5）。

---

## 11. 改动文件清单

**修改（8）**
```
packages/zai/src/server/routes/agent.ts              wb-011 守卫 + 测试 seam
packages/zai/src/server/routes/desktopWallpaper.ts  oc-004 互斥清理 + oc-002 两道头
packages/zai/src/server/routes/fs.ts                wb-012 kind/stat 目录判定
packages/zai/src/server/routes/desktopWallpaper.test.ts   oc-004/oc-002 回归
packages/zai/src/server/services/aaClient/noticeStore.ts      oc-003 TTL + 按会话清理
packages/zai/src/server/services/aaClient/reverseDispatch.ts  oc-003 中断路径接线
packages/zai/src/web/src/store/useAgentStore.ts     cc-003 pendingAsk + cc-004 stale 守卫
packages/zai/src/web/src/components/splitPane/FsContextMenu.tsx  wb-012 传 kind
```

**新增（5）**
```
packages/zai/src/server/routes/fs.openTerminal.test.ts              wb-012（5 条）
packages/zai/src/server/routes/desktopWallpaper.race.test.ts         oc-004 竞态（1 条）
packages/zai/test/aaClient/noticeInterruptCleanup.test.ts            oc-003（3 条）
packages/zai/test/server/agentQueueDeletedSession.test.ts           wb-011（2 条）
packages/zai/test/web/store/useAgentStore-sessionSwitch.test.ts      cc-003+cc-004（5 条）
```

**未改动（按铁律 #2 保持干净）**
```
packages/zn-agent-core/src/opencc-src/    git status 为空
```
