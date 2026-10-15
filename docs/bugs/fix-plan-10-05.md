# 2026-10-05 bug 修复计划（非安全档）

**编制：** zai
**日期：** 2026-10-05
**基线：** HEAD `da6a49b6`
**依据：** [`rank.md`](rank.md)（claude 主报告 + zai 附录 A，两份交叉核对后的结论）
**范围：** 22 份 bug 文档中**排除安全类**后的 15 条

---

## 0. 范围与排除项

### 0.1 纳入本计划的 15 条

按核验后的严重度分三档，与 `rank.md` 两份报告的共识部分对齐。

### 0.2 明确排除的 7 条（不在本计划内）

| 排除项 | 原档 | 排除理由 |
|--------|------|---------|
| `lan-mode-no-auth-rce` | 严重 | 按指示排除 —— `--lan` 无 token 是**有意暂时放开** |
| `exec-csrf-rce--by-zai` | 严重 | 安全类（CSRF → RCE） |
| `dns-rebinding-no-host-check--by-zai` | 高 | 安全类（无 Host 校验） |
| `symlink-traversal-write-delete--by-zai` | 中 | 安全类（路径穿越） |
| `vendor-write-symlink-bypass` | 高 | 安全类（符号链接绕过；且核心断言已被证伪） |
| `session-inbox-sync-try-catch` | 严重 | **已证伪** —— `sessionInbox.ts:341-353` 已套 `.catch()`，建议直接删除该文档 |
| `prompt-close-aborts-all-approvals--by-zai` | 高 | **重复记录** —— 与 `prompt-close-aborts-all-sessions` 同一处代码（`agent.ts:1967-1987`），合并处理 |

### 0.3 排除项的残余风险（必须留档，不可静默消失）

排除是排期决定，不是风险消失。以下三条建议另开安全 backlog，不要因为不在本计划就忘了：

1. **`exec-csrf-rce` 是这批里唯一被实测打通的活漏洞。** 核验时 `GET /api/exec?cmd=node&args=-e,console.log(1337*7)` 真实返回 `9359`，伪造 `Host` / `Origin` 同样执行。全仓零 Host/Origin 校验，`GET` 变体全仓无消费者（死代码）。**若 `--lan` 放开是既定决策，建议至少把「删掉 GET 变体 + 移除白名单里的 `node`/`npx`/`npm`」拆出来单独做** —— 这两步与鉴权策略无关，不构成对「有意放开」的削弱，成本极低。
2. **`vendor-write-symlink-bypass` 的真实缺陷不是权限绕过。** 权限引擎会遍历整条链接链（见 `rank.md` §3.2），真实残余缺口是 **confused-deputy**：ask 卡片渲染的是链接路径而非解析后目标，用户批准「写 evil.md」实际授权的是 `~/.ssh/authorized_keys`。修上游 `symlinkDenyDecision` 移植即可。
3. **一处需要确认的外部依赖。** `rank.md` 两份报告都提到 Chrome LNA/PNA 对「公网页面 → 环回地址」子资源有 gating，Firefox / Safari 无此机制。若属实，CSRF 的实际可利用性依浏览器而异，**修复理由应写成「无浏览器全覆盖」而非「所有浏览器均可」**。这条尚未独立核实，建议排期前先确认。

---

## 1. 先修的共享根因（4 个，收缩 12 条）

这四个根因各自覆盖多条缺陷。**先做它们，后续分档修复的改动量会显著下降。**

### R1 — 原地 `writeFile` 而非 tmp+rename

**现状：** 项目已在 `services/instanceStore.ts:110-120` 诊断并修复过同款缺陷（2026-09-28 `instances.json` 变 0 字节事故的注释就在那里），但**已修方案没有被推广到其余 5 处**，各处各写各的。

**待替换的全部写入点：**

| 位置 | 写入目标 | 备注 |
|------|---------|------|
| `server/utils/fsWrite.ts:85` | **用户源码**（分屏编辑器保存路径） | 根因条目 |
| `server/services/WeixinBotManager.ts:612` | 微信 QR 凭据 + token（`mode: 0o600`） | `rank.md` 查出，**原文档漏报**；同时推翻了「应用状态已全部改用 tmp+rename」的叙事 |
| `server/services/factorySettings.ts:183` | 任务工厂设置 | 原文档漏报；配 `:151-154` 的解析失败静默回落默认值 → 下次写回把默认值**持久化覆盖**，丢失变永久 |
| `server/services/taskFactoryBridge.ts:89` | `supervisorSessionId` 状态 | 原文档漏报；配 `:76-79` 同上，丢失后 `injectSupervisorCommand` 永久 no-op |
| `server/services/fileStore.ts:70` | `~/.zai/settings.json` 等 | tmp 名冲突（见 H1），一并处理 |
| `server/services/zaiSettingsStore.ts:85` | `~/.zai/settings.json` | 同上 |

**做法：** 在 `server/utils/` 抽一个 `atomicWriteFile(path, data, opts?)`：

```
tmp = `${path}.${process.pid}.${counter++}.tmp`
try { writeFile(tmp, data, opts); rename(tmp, path) }
catch (e) { unlink(tmp).catch(()=>{}); throw e }
```

保留 `mode` 选项（微信凭据那处需要 `0o600`）。**不要**照抄裸的 `${path}.${process.pid}.tmp` —— `fileStore` 与 `zaiSettingsStore` 是同进程内的两个并发写者，pid 相同仍会撞名，必须带计数器。

**顺带修 R1-b：** `fsWrite.ts:99` 的 `await stat(absPath)` 在 try/catch 之外，抛出即成为 unhandled rejection（触发 R2 的进程崩溃）。把它挪进 try，或给 `writeTextFile` 整体包一层。

**验证：** 目标文件单测覆盖「写 tmp 失败时原文件内容不变」「rename 后无残留 tmp」；`fsWrite.ts` 加一条 ifMatch 乐观锁语义不回归的用例。

---

### R2 — Express 4 + async handler + 无进程级兜底

**现状：** express 解析到 `4.22.1`，不转发 async rejection；全仓 `unhandledRejection` / `uncaughtException` **零注册**；`index.ts:336` 的 catch-all error handler 对 async 路径完全无效。

**两步：**

**R2-a（一次性止血，一处覆盖所有现有及未来路由）**：在 CLI 入口注册进程级兜底。

```ts
process.on('unhandledRejection', (reason) => {
  logHttp(`[zai-fatal] unhandledRejection: ${reason}\n${(reason as Error)?.stack ?? ''}`, 'error')
  // 不退出：让受影响请求降级为 500，但保住进程与所有其他会话
})
```

> 注意：**不要**顺手加 `process.on('uncaughtException')` 后静默继续 —— 那是另一个量级的决定，需要单独讨论。unhandledRejection 不同，它多数是「某个 await 挂了」而非「进程状态已损坏」。

**R2-b（根因修法）**：`zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts` 的 check-then-act。

```ts
// 现状：existsSync 检查 → readFile 使用，中间被删即 ENOENT
// 改法：单次 readFile + catch ENOENT → 返回 null
```

`listIn` 内的 `readdir` 同样包一层。这样即使上层忘了 try/catch 也不会炸。

**R2-c（逐路由补 try/catch）**：`routes/superTasks.ts` 是缺口（`try={9}` vs `routes={16}`，对照 `weixin.ts` 19/19、`instances.ts` 6/7、`agentSettings.ts` 17/16 全覆盖）。优先 `:87`（3s 轮询）、`:215/227/301/317/331/354/371`、`:249/264/283`。

> **触发概率的准确表述**（供写 PR 描述参考）：`superTasks.ts:87` 那条 TOCTOU 窗口是**每任务亚毫秒级**，不是「用户点一下删除、3s 后就中」。但同族里 `setTaskFactoryState`（EACCES/ENOSPC/EROFS）与 `resources.ts:84` 的 `spawn('npx')`（ENOENT）窗口宽得多，ENOSPC 一次调用即可稳定触发。**类是必修，触发叙述别夸大。**

**验证：** 单测构造「readTaskMeta 时目录被删」应返回 null 而非抛出；启动 zai 后 `kill -9` 任意请求处理中的进程，确认日志有 `[zai-fatal]` 且其他会话 SSE 仍在。

---

### R3 — 资源回收未接入 `closeServer`

**现状：** `closeServer()`（`runtimeLifecycle.ts:60-143`）的回收链是 `shutdownInstanceSupervisor` → `shutdownBackgroundRuntime` → `weixinBot.stop` → `terminalService.disposeAll` → `agentRegistry.clear` → `stopSkillWatcher` → http server → vite → branchChecker。以下三个持有资源的对象**都不在链上**：

| 对象 | 位置 | 现状 |
|------|------|------|
| `ReplRegistry` | `services/repl/ReplRegistry.ts:27` | `dispose()` 全仓唯一调用点是测试 seam `__resetReplRegistryForTest`（`:44-48`）。`sh -c` 子进程在退出后存活被 init 收养。**两条退出路径都扫不到**：`closeServer()` 没有它；`agentRuntime.ts:799-805` 的 SIGTERM handler 走的是 `ReplRuntime.shutdown()`，那是另一个 map |
| `disposeSessionAgents` | `services/sessionAgentRegistry.ts:68` | 全仓**零生产调用方**（grep 只命中定义行）。DELETE 会话时 agent 绑定不释放 |
| `disposeSessionInbox` | `services/sessionInbox.ts:363` | 生产路径只 import 不调用；唯一调用点 `agentRuntime.ts:502` 在 `__resetAgentRuntimeForTests` 内 |

**做法：** 三个各加一个批量回收方法，按 `terminalService.disposeAll()` 的位置对齐接入 `closeServer()`；`DELETE /agent/sessions/:id`（`routes/agent.ts:2166-2199`）补上后两个的调用。

**附带的第二个问题（M3-a 同源）：** `routes/bashRepl.ts:75` 在**订阅**时就通过 `reg.get()` 创建一个永久条目。事件订阅不应分配需要显式回收的资源。`--lan` 模式下客户端可创建无限多个并发 shell 且全部不回收。

**验证：** 单测断言 `closeServer()` 后 `ReplRegistry` 的 map 为空；起一个 `sleep 300`，调 `closeServer()`，断言子进程已消失（`ps`）。

---

### R4 — 微信子系统读写路径不匹配

见 M1、M2、M5 —— 三条缺陷同源于「写方与读方各写各的路径/格式」。集中处理。

---

## 2. 严重档（3 条）

### S1 — 文件保存截断写入导致用户数据丢失

**对应：** `non-atomic-write-data-loss`（`--by opencc`）
**根因：** R1

`fsWrite.ts:85` 的 `writeFile` 用默认 flag `'w'` = `O_WRONLY|O_CREAT|O_TRUNC`，**fd 打开瞬间即截断为 0 字节**，内容才开始写。open 之后任何失败（SIGKILL / ENOSPC / EIO / 断电）留下 0 字节或半截文件，原内容不可恢复，而 UI 只收到一个干净的 500。

**修法：** R1 的 `atomicWriteFile`。保留现有 `ifMatch`（sha256 乐观锁）语义与错误码映射（`ENOENT` / `EACCES` / `ENOSPC` / `CONFLICT`），它们都在 `writeFile` 之前的独立逻辑里，不受影响。

**档位说明：** `rank.md` 上文主张降到「中」（窗口是亚毫秒级），本计划取 **中高** —— 触发窗口确实短，但后果是用户源码本身，且修复成本接近零。

**验证：** 单测：mock `writeFile` 在中途抛 `ENOSPC`，断言目标文件仍是原内容；mock rename 前 kill，断言无 0 字节文件。

---

### S2 — 未捕获的 async handler 异常杀掉整个 zai 进程

**对应：** `async-handler-rejection-kills-process`（`--by claude`）
**根因：** R2

**修法：** R2-a + R2-b + R2-c。

**档位说明：** 上文主张降到「中高」，本计划取 **严重** —— 这是一条**进程级**原语，命中即所有会话 / SSE / 在跑的 turn 全丢。爆炸半径与触发频率是两个维度，不应因后者而降低前者。

**验证：** 见 R2 验证项。

---

### S3 — prompt 正常响应即 abort 全进程所有 pending 提问

**对应：** `prompt-close-aborts-all-sessions`（`--by opencc`）+ **合并** `prompt-close-aborts-all-approvals--by-zai`
**两份取长：** opencc 那份指出「**按 sessionId 过滤也修不好同会话场景**」；zai 那份的 keep-alive 探针实证更强（`close fired=1 writableEnded=true socket.destroyed=false`）。合并时两者都带上。

**机制：** `agent.ts:1967` 的 `req.on("close")` 在正常 200 响应后**也会触发**（`res` 关闭 ≠ 请求异常），随即调用三个注册表的 `abortAll`：

```ts
// askRegistry.ts:74-79 / approveRegistry.ts:103-108 / permissionRegistry.ts:94-99
abortAll(reason = 'session_aborted'): void {
  for (const p of this.pending.values()) {   // ← 全局遍历，无 sessionId 判断
    this.pending.delete(p.toolUseId)
    p.reject(new Error(reason))
  }
}
```

三处都已是单例、无 sessionId 过滤 → **跨会话互相 kill**。而同文件 `:1974-1979` 的注释已经写明「client 关 body 是正常 lifecycle，不要 abort」——**注释识别出了正确语义，却只摘掉了一半**。

**修法（三步，缺一不可）：**

1. **判别条件**：`req.on('aborted')` 在 Node 17+ 已废弃且只在提前中断触发。正确做法是 `res.on('close')` 里判 `res.writableFinished` —— 正常响应完成时为 true。
2. **过滤 sessionId**：三个 `abortAll` 增加 `sessionId` 参数，只 abort 该会话的 pending。三个 `Pending` 类型本来就都带 `sessionId`（`approveRegistry` 旁边就有未被使用的 `listBySession`）。
3. **同会话场景仍需处理**：同会话内 pending 的 ask 仍会被「正常响应结束」误杀，需靠第 1 步的 `writableFinished` 判别兜住。**只做第 2 步会留下半个坑。**

**验证：** 单测：mock 一个正常 200 的 prompt 请求，断言三个 registry 的 pending 数量在响应完成后不变；另一个测试模拟同会话 pending ask + 正常响应，断言 ask 仍挂着。

---

## 3. 高档（4 条）

### H1 — settings.json 被整对象覆盖（config 静默丢失）

**对应：** `settings-tmp-path-collision`（`--by opencc`），**根因按 `rank.md` 上文修正**

**修正后的主因不是并发竞态，而是整对象覆盖：** `fileStore.writeConfig`（`fileStore.ts:64-74`）是**整对象写**，完全绕过 `updateZaiSettings` 的 read-merge-write。所以**即使完全不并发**，在配置页保存一次「Zai」（`web/src/pages/Config.tsx:579` 走 `api.put('/config/zai', ...)`，tab 列表 `Config.tsx:13-18` 含 `zai`），就会**回滚设置抽屉期间写入的所有字段**。

并发的 tmp 名冲突（`zaiSettingsStore.ts:85` 与 `fileStore.ts:70` 都用固定 `${path}.tmp`，且 `CONFIG_PATHS` 把 `zai` 与 `opencc` 双双映射到 `~/.zai/settings.json`）是次级症状。

**修法：**
1. `writeConfig` 改 read-merge-write：先读现有内容，浅合并 patch 字段后再写。
2. 或：给 `PUT /config/zai` 单独走 `updateZaiSettings`（patch 语义），不走 `writeConfig`。
3. 并发路径仍按 R1 收敛 tmp 名（带 pid + 计数器）。

**验证：** 单测：先 `updateZaiSettings({a:1})`，再 `writeConfig('zai', {b:2})`，断言 `a` 未丢失。

---

### H2 — SSE 断点续传的两处断裂（重启后客户端静默不显示）

**对应：** `sse-seq-guard-survives-restart`（`--by claude`）

**断裂 1 — seq 高水位跨重启不重置：**
- `eventBus.ts:171` `private seqCounter = 0`，注释 `:169-170` 明写「进程重启后从 0 重新计数」
- 客户端 `useAgentStore.ts:801-804`（`upsertToolCall`）与 `:998-1001`（`upsertStreamBlock`）都有 `if (guardSeq <= prev) return s`
- `setCurrentSession`（`:1125-1126`）重置 `messages / textSegmentRev / segmentedToolUseIds / sendSeq / lastRuntimeTurnIndex` —— **唯独不重置 `lastSeqBySession`**。全仓 grep 该字段无任何重置路径

结果：服务端重启后 seq 从 0 重数，客户端高水位把所有新事件当旧事件丢弃 → 页面 spinner 转、文本空白、**静默无提示**。而重启路径（`SettingsDrawer.tsx:1544` → `requestRestart`）**不刷新页面**。

**断裂 2 — `Last-Event-ID` 永不命中：**
- `sse.ts:50` `const id = event.seq ?? (event as {eventId?}).eventId` —— `seq` 恒有值，**右分支是死代码**
- `eventBus.ts:262` `_sliceAfter` 用 `arr.findIndex((e) => e.eventId === lastEventId)` 匹配
- 而 `eventId` 形如 `evt_${Date.now().toString(36)}_${counter}`（`eventBus.ts:7`），**不可能等于数字型 seq**

**附带：** `applyQueueChanged`（`:1041`）、`applyPromptAsk`（`:1971`）、`applyPromptApprove`（`:1994`）、`applyPromptPermission`（`:2091`）、`applyCwdChanged`（`:2157`）都缺 `applyRuntimeEvent`（`:1618-1619`）那样的 `currentSid` 比较。`useEventStream.ts:43-46` 的注释已自认这一点。`pendingAsk` 会卡住发送按钮（`AgentInputBox.tsx:1746` / `:2117`）与输入框（`:2040`）。

**修法：**
1. `setCurrentSession` / `clearMessages` 里重置 `lastSeqBySession`。
2. `sse.ts:50` 二选一 —— 要么统一用 `eventId` 做 id 且让 `_sliceAfter` 也按 `eventId` 匹配，要么删掉右分支并在注释里写明「断点续传按 seq 走整段重放」。
3. 五个 `apply*` 补 `currentSid` 比较。

**验证：** 单测：构造 seq 单调递增的序列，模拟「服务端重启后 seq 归零」，断言新事件不被丢弃。

---

### H3 — InstanceSupervisor 并发 start/stop 双 spawn

**对应：** `instance-supervisor-double-spawn`（`--by claude`）

**机制（行号全部精确）：** `doStop` 的 `instanceSupervisor.ts:439` 在 `!child` 时**无条件** `setStatus(entry, { state: 'stopped' })` 并早退，撤销 in-flight start 在 `:310` 设的 `starting` 态；`:309` 的守卫是 check-then-act，中间隔 `:327 assertPortAvailable` 与 `:330 probePort` 两个 await。

**按 `rank.md` 上文的修正 —— 原复现链「双击重启」走不通**（两次点击若都在 C1 存活期间，第二个 `doStop` 走正常路径，不会 clobber）。**真实可达路径：**

1. **自动扫描 + 多个基础端口被占**时，`probePortDefault` = `findAvailablePort`，最多循环 100 个候选，每个都是真 connect + bind + close 的 await → 反复让出到 I/O 阶段 → 已排队的第二个请求在扫描中途被派发，看到 `entry.child === null`，clobber 状态，自己的 `doStart` 直接穿过守卫；
2. **UI 无 in-flight 守卫已核实**：`Instances.tsx:242` 的 `act()` 直接 `fetch`，无 pending 态；`disabled={!canRestart}` 是状态派生，而 `loadInstances()` 只在整条请求完成后才刷新 → **整个重启期间按钮都可点**；
3. 钉端口路径窗口更窄（`assertPortAvailable` = 一次 connect + 一次 bind），但仍是真实的 turn 边界。

**文档漏掉的第二个缺陷：** `attachChild` 的 exit handler **无条件** `entry.child = null`（约 `:289-290`），所以泄漏的 C2 日后退出时**还会把 C3 的引用也清掉** —— supervisor 连带丢失对存活 child 的追踪。其上方那句注释「a stale exit from a replaced child can never touch the new entry.child」**与代码不符**。

**修法：**
1. `doStop` 的 `:439` 分支加守卫：仅当 entry 当前**不处于 `starting`** 时才翻回 `stopped`。
2. `attachChild` exit handler 补 stale-child 检查（`if (entry.child !== child) return`）—— `:294` 已有这个模式，只是没用在这里。
3. `instances.ts` 的 `startInstance` / `stopInstance` / `restartInstance` 加 per-instance in-flight 串行化。
4. 前端 `Instances.tsx` 加 pending 态，重启期间禁用按钮。

**验证：** 单测：并发发 `startInstance` + `stopInstance`，断言 `deps.spawn` 只被调用一次、`shutdown()` 能遍历到 child。

---

### H4 — 微信记忆轮转读了一个没人写入的路径

**对应：** `wechat-memory-rotation-noop`（`--by claude`）
**根因：** R4

**三重不匹配（磁盘证据可独立复现）：**

| | 读方 `weixinMemory.ts:109-111` | 写方 `legacyTranscriptStore.ts:89-95` |
|---|---|---|
| 目录 | `join(base, 'projects', sanitizePath(cwd), \`${sid}.json\`)` | `join(dataDir, 'projects', sanitizePath(cwd))` |
| 扩展名 | `.json` | `.jsonl`（`JSONL_EXT`，`:78`） |
| 格式 | `JSON.parse` 整个文件 | JSONL 逐行追加 |

`weixinMemory.ts:126-128` 的 `catch {}` 静默跳到下一个候选 → **整条跨会话记忆静默空转**。

**核验补充（`rank.md` 上文查出的第四重不匹配，比文档说的更糟）：** 两个 `sanitizePath` 的截断阈值不同 —— `weixinMemory.ts:77` 与 `compat/transcript/paths.ts:22` 用 `<= 80`，而 `legacyTranscriptStore.ts:29` 用 `MAX_SANITIZED_LENGTH = 200`。**任何 sanitized 形式超过 80 字符的 cwd，两侧算出的是不同目录名。**

**更精确的定性（`rank.md` 上文把它从「推断」升级为「已证实的回归」）：** `~/.zai/transcripts/projects/` 下那些陈旧 `.json` 的实际结构 `{version, transcriptId, meta, messages}` **正是读取方解析器期待的形状** → **读取方是照着旧版写入方写的，写入方后来搬走了，读取方从未跟进**。

**修法：** 改读方对齐写方（`projects/<sanitizePath(cwd)>/<sid>.jsonl` + JSONL 解析 + 阈值统一为 200 或统一为 80 —— 建议统一到 vendor 侧的 200 并给 `weixinMemory` 加注释指向 `legacyTranscriptStore`），或反过来改写方。**推荐前者**：读方改动的爆炸半径小，且不用迁移现存数据。

**验证：** 单测：跑一次 `recordRotationSummary`，再用 `getSessionMemory` 读回，断言内容一致（当前必然读空）。

---

## 4. 中高 / 中 / 低中档（8 条）

### M1 — 微信入站按文本内容指纹去重，吞掉合法重复消息

**对应：** `weixin-content-fingerprint-dedup--by-zai`｜**根因：** R4
**核验：零事实错误**

两层 key 空间：`WeixinAdapter.ts:430` 用 `messageId`（正确），`:485` 又加了一层 `content:${senderId}:${md5(text)}`。两条不同 `message_id`、同文本的消息通过第 1 层，撞在第 2 层。

`MessageDeduplicator.ts:36-39` 命中时执行 `this.map.set(key, now + this.ttlMs)` **续期**，`constants.ts:40` `TTL = 300s` → 用户在 5 分钟内每重发一次就把 key 往后推 300 秒，**永久锁死**。

同一个 `if (text)` 守卫（`:484`）还让**纯媒体消息完全绕过去重**，与 M5 的媒体泄漏同源。

**测试覆盖为零**：`WeixinAdapter.inbound.test.ts:130` 是唯一的去重测试，只测 `messageId` 重复；`MessageDeduplicator.test.ts` 的 6 个用例全在测通用类，没有一个覆盖 adapter 里的 content-key 构造。

**修法：** 删掉内容指纹层，只保留 `messageId`。若确需防「服务端重投同一条消息」而 messageId 不可信，退而求其次也要把 key 换成 `messageId + mediaPaths`，且**不续期**（用 `set` 而非覆盖 TTL）。

**验证：** 新增单测：两条不同 `messageId` 同文本 → 期望 2 条消息，当前会得到 1 条（**先写这个失败用例**）。

---

### M2 — 微信入站游标早于 pending 落盘推进，重启丢消息

**对应：** `weixin-cursor-ahead-of-persist--by-zai`｜**核验：根因成立，文档的修复建议 2 不可实施**

**真正的丢失窗口不在 `disconnect()`：** `WeixinAdapter.ts:373-377` 的 `_pollLoop` 先 `syncBuf = newBuf; await this.syncStore.save(...)`（游标落盘），**之后**才 `:388` 派发批次（`_processMessageSafe(m).catch(...)`，不 await）。**游标推进与 pending 落盘之间任何崩溃都丢消息，与 disconnect 无关。**

`weixinInboundBridge.ts:386/388/393/394` 的顺序是 `pending.save` → `followup` → `markProcessed` → `remove` —— 这条链本身是对的，但只有在消息**真的被派发**后才走得到。而 `:294` 的 `this.debounce.flushAll(() => { /* drop */ })` 在优雅重启时把缓冲区直接丢弃，既不落盘也不派发，游标已过 → 服务端不重投。

**修法：** 确立不变量 —— **游标只在 pending 落盘成功后才推进**。具体做法：把 `syncStore.save` 移到批次派发**之后**（或先落 pending 再存游标）。`disconnect()` 处的 `flushAll(drop)` 改为 `flushAll` 时**真正派发**而非丢弃。

**注意：** 不要按原文档建议 1「让 disconnect 在 flush 前不推进游标」实施 —— 游标不在 `disconnect()` 里推进，改那里没用。

**验证：** 单测：mock 一条消息进入 debounce 缓冲（不派发），调 `disconnect()`，断言重启后该消息仍会被服务端重投。

---

### M3 — ReplRegistry 未接入 closeServer 导致子进程泄漏

**对应：** `repl-registry-child-process-leak`（`--by opencc`）｜**根因：** R3
**核验：行号全对**

`ReplRegistry.dispose()` 全仓只在测试 seam 可达；`closeServer()` 回收链 9 步逐项核对确实没有它，SIGTERM 路径也没有（走的是另一个 map）。

**PTY 路径为何反而安全（反直觉但正确）：** `node-pty` 走 `forkpty`，PTY shell 是 session leader 且以 slave 为控制终端，master 关闭时内核发 SIGHUP 自动回收。`sh -c` + piped stdio 的子进程是**普通同进程组子进程**，父进程干净 `process.exit(0)` 时收不到任何信号。

**`rank.md` 上文补充的加重项：** managed child 以 `detached: false` spawn、按 pid kill，所以 **supervisor 驱动的重启也扫不到这些孙进程**。

**修法：** 见 R3。`ReplRegistry` 加 `disposeAll()`，在 `closeServer()` 中对齐 `terminalService.disposeAll()` 的位置调用。

---

### M4 — 删除会话不中断运行中的 turn，被删的会话会自己回来

**对应：** `delete-session-resurrects--by-zai`

**症状成立，归因要改。** DELETE 路由（`agent.ts:2166-2199`）只做 5 件事：`store.remove`（`:2175`）、`CwdStore.delete`（`:2177`）、`unregistryAgent`（`:2180`）、`getTerminalService().disposeSession`（`:2185`）、`eventBus.emit('session.deleted')`（`:2191`）—— **没有 `abortSessionController`**。在跑的 turn 继续 append，`appendFile` 重建刚被 `rm` 的文件。

**两处归因修正（`rank.md` 上文查出）：**
- 文档点名的 `appendEntry` **不是实际写入者** —— 它走 `store.append`，而那是**空实现**（`compat/runtime/legacyTranscriptStore.ts:528-533`，注释：「vendor QueryEngine 直接写文件, 这里保持 no-op」）。真正重建者是 vendor 的 `sessionStorage.ts:1046-1055` `appendDirectlyToFile`（`mkdir` + `fsAppendFile`），以及 `:1793` 在 `sessionFile` 指针已缓存时直接 append、**不复查文件是否存在**；facade 侧 `sessionFacade-impl.ts:99-115` 对 ENOENT 做 mkdir + 重试
- **不需要新 turn** —— 在跑的 turn 自己就会把文件写回来。原文档说「finally 启动新 turn」有未言明的前置条件：`flushSessionInboxNextStep` = `promoteNextStepToNextTurn`（`busyFlush.ts:67-79`）只在 `promoted > 0` 时才 `inbox.wakeFor`；普通流式 turn 的 inbox `nextStep` 车道为空 → 返回 0，不 wake

**修法：** DELETE 路由补 `abortSessionController(sid, 'session_deleted')` + `disposeSessionInbox(sid)`（后者也补进 R3），**在 `store.remove` 之前**。加 stale 守卫，确保 turn 的 `finally` 不会对已删会话再写。

**验证：** 单测：起一个长 turn，DELETE 会话，断言 `abortSessionController` 被调用、transcript 文件不再出现。

---

### M5 — 微信入站媒体无上限无回收

**对应：** `weixin-media-unbounded--by-zai`｜**根因：** R4

**锁文件（数字可逐位复现 —— 评估者亲验 `ls | wc -l` = `1740`，`du` = `0B`）：** `AccountLock.acquire` 为每个 token 在 `~/.zai/weixin/locks/` 创建一个 base 文件，**从不删除**；`release()`（`AccountLock.ts:54-62`）只调 `releaseFn()` 回收 `.lock` **目录**，不删 base 文件。

**媒体：** `~/.zai/weixin/media/` 与 `<cwd>/.zai/weixin-media/` 全仓无删除逻辑，且**纯媒体消息完全绕过去重**（同一个 `if (text)` 守卫，见 M1）→ 同一张图反复发不会被拦。

**修法：**
1. 锁文件：给 `locks/` 加启动清扫 —— 删超过 24h 且未被 proper-lockfile 持有的 `.lock` base 文件。**注意不能盲删正在被持有的锁**：先确认 proper-lockfile 的 stale 判定不依赖 base 文件的存在。更彻底的做法是带 pid 的临时名 + 退出清理（对齐 R1）。
2. 媒体：加保留策略 —— transcript 被删或超过 N 天时清理关联媒体。需要先建立「媒体文件 → messageId/sessionId」索引。
3. 纯媒体去重：与 M1 一并处理。

**验证：** 单测：连续 acquire/release 同一 token 100 次，断言 `locks/` 目录项数不增长。

---

### M6 — Vendor 类型闸门排除主入口 bundle-entry.ts

**对应：** `vendor-type-gate-blind-spot`（`--by claude`）｜**核验：两个真实缺陷成立，1 处论证方向反了**

**真实缺陷 1：** `tsconfig.typecheck.json:20` 把 `"src/bundle-entry.ts"` 放进 `exclude` —— **发布面是唯一不被 typecheck 的文件**。实测把 exclude 去掉后恰好 3 个错误：

```
src/bundle-entry.ts(213,25): error TS2300: Duplicate identifier 'TaskStatus'.
src/bundle-entry.ts(276,3):  error TS2305: Module '"...taskFactoryFiles.js"' has no exported member 'bodyAfterFrontmatter'.
src/bundle-entry.ts(281,3):  error TS2300: Duplicate identifier 'TaskStatus'.
```

`TaskStatus` 实为**三方分裂**：`taskListStore.ts:30`（`'pending'|'in_progress'|'completed'|'deleted'`）、`taskFactoryFiles.ts:8`（`'queued'|'processing'|'paused'|'verifying'|'done'|'failed'`）、`web/src/lib/taskApi.ts:8`（`'queued'|'running'|'completed'|'failed'|'cancelled'`）。

**真实缺陷 2：** `bodyAfterFrontmatter` 在 vendor `src/` 内除 `bundle-entry.ts` 自身外**零命中**（上游 `opencc/src/` 也零命中），但 `dist/bundle-entry.d.ts:138` 声明了它 → 消费者探针 0 错误，运行时 `undefined`。

**论证方向修正：** 文档说「第二个声明胜出」，实测**第一个**胜出（`pending` / `in_progress` / `deleted` 类型通过，`queued` / `paused` / `verifying` 报 TS2322）。结论侥幸成立，论证不成立 —— 写 PR 时别沿用原文。

**机制也需修正：** 消费者探针 0 错误不是因为「bundler resolution 静默丢弃」，而是因为 `tsconfig.consumer.json` 的 `skipLibCheck: true` 吃掉了 d.ts 内部的诊断。控制实验：import 一个 d.ts 里**根本不出现**的名字会报 TS2305。所以这个闸门不是对「不存在的导出」全盲，而是对「列在 re-export 里但远端解析不到的名字」盲。

**修法：**
1. 从 `exclude` 移除 `bundle-entry.ts`，把 3 个错误逐个修掉。
2. 三套 `TaskStatus` 统一到一处（建议 vendor 的 `taskFactoryFiles` 版本，它是语义最全的；`taskApi.ts` 那套是前端自己的投影，需评估调用方）。
3. 删掉 `bodyAfterFrontmatter` 幽灵导出。
4. `skipLibCheck` 那条不必动（业界通行），但要在 `tsconfig.consumer.json` 注释里写清它会掩盖什么，避免下一个人再误判。

**注意：** 本条改 `packages/zn-agent-core/`，**验证前必须 `pnpm run build:core`**，否则 ego / 活实例验的是旧 bundle。

---

### M7 — SSE 连接泄漏 + session 删除不清 registry

**对应：** `sse-subscriber-and-session-leak`（`--by claude`）

**SSE 泄漏（两个机制叠加）：**
- `routes/event.ts:66-72` 先注册 subscriber（拿到 `unsubscribe`），`:123` 有 `await bg.list()`，而 `req.on('close', markClosed)` 在 **`:155`** —— 晚于 await
- Node 的 `close` 事件是**一次性的**：客户端已断开后再注册监听器，**永不触发**
- 于是 `await closed`（`:157`）永久挂起，`finally`（`:161-169`）永不执行 → `unsubscribe` 不调用、心跳 `setInterval` 不 `clearInterval`
- 且 `:150-152` 的 `try { res.write(': heartbeat\n\n') } catch { markClosed() }` 也救不了 —— 已 destroy 的 response 上 `res.write` **返回 false 而不抛异常**（`rank.md` 上文用自建 `node:http` 探针实测确认），catch 永不触发

**registry 泄漏：** `disposeSessionAgents`（`sessionAgentRegistry.ts:68`）全仓零生产调用方；`disposeSessionInbox` 同样只在测试 seam。

**修法：** 把 `req.on('close', markClosed)` **移到第一个 await 之前**（订阅之前注册）。`finally` 里的 `clearInterval` + `unsubscribe?.()` 就会正常执行。registry 两个的回收见 R3。

**验证：** 单测：mock 一个在 `bg.list()` 期间 destroy 的客户端，断言 `eventBus.subs` 回到基线、心跳定时器被清。

---

### M8 — 停止按钮误杀另一个标签页的 turn

**对应：** `abort-uses-global-session-id--by-zai`｜**核验：零事实错误**

`agent.ts:2288-2302` 先按 header `x-session-id` 调 `abortSessionController(sid, ...)` 拿到正确的 sid，随后**无条件**调 `abortAgentSession("user_abort")`；后者签名（`agentRuntime.ts:920-951`）**不接 sessionId**，函数体读模块级 `currentSessionId`（`:71`），并用它做三件事：

```ts
abortSessionController(currentSessionId)              // :925
cancelBackgroundTasksByParentSession(currentSessionId) // :933
runtime.abort(currentSessionId)                        // :946
```

**讽刺点：** 前端 `useAgentStore.ts:1453` 主动塞这个 header，注释写明意图是「避免误杀其它正在跑的 turn」，而服务端的**第二**次调用把第一调用的精确度整个废掉。`agent.ts:2296-2299` 声称「重复调用不会引入副作用」—— 只在 `sid === currentSessionId` 时成立。

**与 S3 同源但不同解：** S3 是 `abortAll` 缺 sessionId 过滤；本条是 `abortAgentSession` **函数签名层面**就没有 sessionId。**同一个 PR 里一起改**（`abortAgentSession(reason, sessionId)` 加参数，三个内部调用改用入参）。

**修法：** 给 `abortAgentSession` 加 `sessionId` 形参，函数体用入参而非模块全局；或直接删掉重复的那次调用（若 `abortSessionController(sid)` 已足够）。

**验证：** 单测：同时开两个 session，abort 其中一个，断言另一个的 controller 未被调用。

---

## 5. 建议执行顺序

### 批次 1 — 共享根因（先做，后续改动量显著下降）

| 序 | 项 | 覆盖条目 | 改动面 |
|----|----|---------|--------|
| 1 | R1 抽 `atomicWriteFile` + 替换 6 处 + `fsWrite.ts:99` 挪进 try | S1 + H1 的一部分 | 7 个文件 |
| 2 | R2-a 进程级 `unhandledRejection` 兜底（一处） | S2 的止血 | 1 个文件（CLI 入口） |
| 3 | R3 三个资源回收接入 `closeServer` | M3 + M4 的一部分 + M7 的一部分 | 4 个文件 |

> R2-a 单独一行、优先级最高：改一处就把「单请求搞死整个 server」降级为「单请求返回 500」，收益远大于成本。

### 批次 2 — 严重档

| 序 | 项 | 说明 |
|----|----|------|
| 4 | S3 abortAll / abortAgentSession 修（S3 + M8 一起） | 同一个 PR，两个症状同源 |
| 5 | S2 剩余部分：R2-b `taskFactoryFiles` check-then-act + R2-c `superTasks` 逐路由 | R2-a 只是止血，根因在这 |

### 批次 3 — 高档

| 序 | 项 |
|----|----|
| 6 | H1 settings 整对象覆盖（**先做这个，别做 tmp 竞态**） |
| 7 | H2 SSE seq 高水位 + Last-Event-ID |
| 8 | H3 InstanceSupervisor 双 spawn（含前端 in-flight 守卫） |
| 9 | H4 微信记忆路径对齐（与 M1/M5 一起收） |

### 批次 4 — 中高档

| 序 | 项 |
|----|----|
| 10 | M6 vendor 类型闸门（**改完必须 `pnpm run build:core`**） |
| 11 | R4 剩余：M1 去重 / M2 游标 / M5 媒体与锁文件 |
| 12 | M7 SSE 注册顺序 |
| 13 | M4 删除会话不 abort |

---

## 6. 验证约定

沿用仓库既有约定（见 `AGENTS.md`「常用验证命令」）：

- **只跑直接受影响的测试文件**，不要全量 `pnpm -r test`（约 4.5 分钟）
- **改 `packages/zn-agent-core/` 的（只有 M6）→ 验证前必须 `pnpm run build:core`**，否则验的是旧 bundle
- **页面样式 / 前端交互类的（H2、H3 前端部分）→ 用 `/ego-browser` 真实浏览器验**，单测不算门禁
- **修 bug 前先写一个会失败的测试**，确认它真的红 —— 这是本批里 M1、M8、S3 特别需要的前提
- 纯后端行为类（S1、S2、H3 后端、M2、M4）单测即可

**服务端口注意：** 验证时用空闲端口起独立 dev 实例（`pnpm --filter @zn-ai/zai dev -- --port <空闲>`），**不要 kill 920x**（那是用户的正式服务实例）。

---

## 7. 一并建议的文档清理

- **删除** `session-inbox-sync-try-catch.md`（已证伪，`sessionInbox.ts:341-353` 已套 `.catch()`）
- **合并** `prompt-close-aborts-all-approvals--by-zai.md` 进 `prompt-close-aborts-all-sessions.md`（同一处代码；两份取长：opencc 的「同会话场景按 sid 过滤修不好」+ zai 的 keep-alive 实证）
- 更新 `README.md` 索引：按本计划的分档调整严重度；把 5 条安全类标注为「另开安全 backlog」
- 给 `safePath.ts:10-17` 的失效注释加一条指向本计划的说明（**注释不是防线** —— 它写「端点是只读的」，而 `fs.ts:548` 写、`:1516` 删都走它）

---

*本计划由 zai 编制，依据 `rank.md` 的 claude 主报告与 zai 附录 A 交叉核对结论。所有 file:line 均经独立回源码核对，基线 HEAD `da6a49b6`。安全类 5 条按指示排除，排除项与残余风险见 §0.2 / §0.3。*
