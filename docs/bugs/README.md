# docs/bugs/

已确认但**尚未修复**的缺陷记录。每条包含：根因、精确位置、可复现的实证、修复方向。

> ⚠️ **动手修之前先读 [`2026-10-16-known-bug-reconciliation.md`](./2026-10-16-known-bug-reconciliation.md)**。
> 下表 22 条成文于 2026-10-05，至 2026-10-16 的 HEAD `6f9ceaeb` 已过 **66 个提交**，
> 逐条对账结果是：**15 条已修 / 2 条部分修 / 5 条仍成立**。
> 换言之 **本表有 17 条已经过时** —— 照着它修会修到已经修好的东西。
> 对账文档同时记录了 2 条与本表重合的本场新发现（wb-004、wb-008）。
>
> ⚠️ **2026-10-17 补充**：本目录已新增两场 bug-hunt 比赛的产出，**含 7 条从未被任何静态审计扫到的新缺陷**，见下方「2026-10-17 bug-hunt 场新增」。另外对账结论本身也会过时 —— 上一届据对账认定已彻底修完的 `instance-supervisor-double-spawn`，本场实测发现其**删除路径仍未覆盖**。**判定「已知缺陷是否还活着」一律以当前源码为准。**

命名沿用仓库约定 `YYYY-MM-DD-<topic>.md`。设计/取舍类文档在
[`../superpowers/specs/`](../superpowers/specs/)，实施计划在
[`../superpowers/plans/`](../superpowers/plans/)。

> **本批报告的质量评估见 [`rank.md`](rank.md)**（评估者 opencc，2026-10-05）。
> 结论：22 条中 14 条完全属实，**4 条存在实质性推理错误**
> （`symlink-traversal` 的「删同理」、`dns-rebinding` 的「任意文件读」、
> `vendor-write-symlink` 的「绕过整个权限系统」、`session-inbox` 的严重度）
> —— 这些会误导修复优先级，**修复前请先读 rank.md**。

「发现者」列区分 2026-10-05 两轮并行代码审计的来源：

- `--by opencc`（4 条）—— 三路并行审计（会话并发 / 资源泄漏 / 安全与数据）。
- `--by claude`（9 条）—— 另一路并行审计（服务端路由与实例 / 会话状态与 SSE /
  前端 store / vendor 漂移 四路），外加针对 `--lan` 暴露面的直接实测。
- `--by zai`（9 条）—— 第三路审计（微信通道 / 会话运行时 / fs 与权限 三路），
  全部结论均经**亲自复现**：`curl` 打活实例验证 RCE 往返、自建 Express 复现
  `req.on("close")` 语义、mock long-poll 写出失败用例、磁盘文件计数。

三轮均在写入前逐条复核，行号逐条核对。`--by zai` 与 `--by opencc` 有 **1 处重叠**
（`/agent/prompt` 的 `close` 误判，两份指向同一处代码），详见对应文档顶部的交叉引用。

> 复核更正（2026-10-05，见 [`rank.md`](rank.md)）：实际重叠为 **3 处** ——
> 上述 `/agent/prompt` 一处，另有**锁文件累积**（1740 个 `~/.zai/weixin/locks/*.lock`）
> 同时出现在 `--by claude` 的 `wechat-memory-rotation-noop`（附带发现）与
> `--by zai` 的 `weixin-media-unbounded`（主体）两篇中。

## 2026-10-17 bug-hunt 场新增（7 条，**全部未修**）

> 来源：[`bug-hunt-game-10-17/`](./bug-hunt-game-10-17/)（双人赛，`opencc` + `claude`，裁判 zai）
> 终裁见 [`VERDICT.md`](./bug-hunt-game-10-17/VERDICT.md)，修复计划见 [`FIX-PLAN.md`](./bug-hunt-game-10-17/FIX-PLAN.md)。
> **这 7 条的去重后根因只有 5 个簇，其中 3 条来自「上一届的修复本身」** —— 详见下方「本节必读」。

| ID | 终裁 | 簇 | 标题 | 一句话 |
|---|---|---|---|---|
| **oc-002** | **S2/E3b** | A | `claude` provider 不在 `preferCliAgent` 枚举内 | `superTasks.ts:90` 加了 `claude`、`factorySettings.ts:65` 的 zod 枚举没同步；UI 下拉框照给、zod 拒收 → **保存必 400 且粘住**（一次失败连坐同批 4 项编辑全丢） |
| **cl-003** | S3/E1 | B | `d66d09f5` 声称「一次收口」，实际三处解析器未迁 | `compat/permissions.ts:83`、`commands/userLoader.ts:26-28,39-40`、`ReplHistoryService.ts:162-164` 仍硬写 `homedir()/.zai`；**writer 迁了 reader 没迁 → 写 A 读 B** |
| **cl-r1** | S3/E3b | B | tier-2 无条件读真实 `~/.claude/` 并回写实例目录 | `zaiSettingsCache.ts:161,166` 读用户真实配置，`:174-176` boot 回填再写进隔离目录 —— **不是读泄漏，是把真实 home 的配置复制进隔离实例** |
| **oc-001** | S3/E3a | C | `starting` 窗口内 DELETE 跳过 `doStop` | `instanceSupervisor.ts:581` → 子进程从 supervisor 脱管，`shutdown():693` / `tickHeartbeat:592` 都只遍历 `entries.values()` 故看不见它 |
| **oc-r1** | **S2** | D | manifest 撕裂读 → 整份清空 | `manifest.ts:79` 非原子写 + `:64-71` 裸 catch 返回空 manifest → 下一次写回把**所有插件**的 `extractedVersions` + `latestVersion` 一起抹掉 |
| **cl-001** | S3/E3a | D | `updateCachedVersion` 覆盖掉 `extractedVersions` | `manifest.ts:106` 无 `...existing` 展开（同模块 `:132`/`:156` 两处都有）→ LRU prune 永久失效 |
| **cl-002** | S3/E3a | E | `OfflineBuffer.setPort()` 全仓零调用 | per-child outbox 隔离从未发生；`enforceSizeCap` 的 FIFO 截断无归属概念 → 跨子实例驱逐。**需 `--aa` + 已 pairing + 50MB 溢出，三层门** |

### 本节必读

**① 3 条是「上一届的修复本身」留下的缺陷**（`oc-001` ← `5dedfe4d` 漏了 `doRemove`；`oc-002` ← `7c32e4da` 加 provider 漏了 zod 枚举；`cl-003` ← `d66d09f5` 声称一次收口实际漏三处）。这意味着**修它们是「把上一届说已修的修完」，不是加新功能**。

**② 上一届还有一条从未修过的债：`wb-010`**（`WebFetchTool/utils.ts:304-306` 超时 fallback 裸 `fetch` 绕过 SSRF 守卫）。它**不在本场 7 条里**，裁判 2026-10-17 复核仍成立。**这是本仓库唯一一条已知 SSRF**，而 `7c32e4da` 之后网络面又扩了（AA 通道）。建议单列一次修复，不要继续挂。

**③ 上一届「已修 16 条」的说法已被本场勘误推翻两条**，完整勘误见 [`bug-hunt-game-10-17/ERRETA.md`](./bug-hunt-game-10-17/ERRETA.md)。由此得到一条操作性教训：**不要用「文件被修复 commit 动过」推断「那条缺陷修完」** —— `instanceSupervisor.ts` 确实被 `5dedfe4d` 改过，但缺陷只修了一半。

## 未修复

### 严重（2026-10-05 审计批次）

| 日期 | 发现者 | 标题 | 一句话 |
|------|--------|------|--------|
| 2026-10-05 | `--by opencc` | [文件保存截断写入导致用户数据丢失](2026-10-05-non-atomic-write-data-loss.md) | `fsWrite.ts:85` 用 `writeFile` 原地覆盖，fd 打开即截断，崩溃后原内容不可恢复 |
| 2026-10-05 | `--by opencc` | [prompt 正常响应即 abort 全进程所有 pending 提问](2026-10-05-prompt-close-aborts-all-sessions.md) | `req.on("close")` 正常 200 后也触发；三个单例 registry 的 `abortAll` 无 sessionId 过滤，跨会话互相 kill |
| 2026-10-05 | `--by claude` | [未捕获的 async handler 异常直接杀掉整个 zai 进程](2026-10-05-async-handler-rejection-kills-process.md) | Express 4 不转发 async rejection + 无 `unhandledRejection` 兜底；3s 任务轮询撞上删除竞态即进程退出 |
| 2026-10-05 | `--by claude` | [`--lan` 模式全 API 零鉴权](2026-10-05-lan-mode-no-auth-rce.md) | 安全模型只建立在「只监听 localhost」上；`--lan` 打破前提却无任何补偿控制，局域网内未授权 RCE + 微信账号控制 |
| 2026-10-05 | `--by claude` | [SessionInbox 用同步 try/catch 包 async handler](2026-10-05-session-inbox-sync-try-catch.md) | catch 形同虚设；每次 subagent / 后台 bash 完成都会走，失败即崩溃 |
| 2026-10-05 | `--by zai` | [跨站请求伪造导致任意代码执行](2026-10-05-exec-csrf-rce--by-zai.md) | `GET /api/exec` 是简单请求不发预检，白名单含 `node`/`npx`；实测 `curl` 打出 `9359` |

### 高

| 日期 | 发现者 | 标题 | 一句话 |
|------|--------|------|--------|
| 2026-10-05 | `--by opencc` | [settings.json 双写者共用同一 tmp 路径](2026-10-05-settings-tmp-path-collision.md) | `zaiSettingsStore` 与 `fileStore` 用同一个固定 `.tmp` 名，并发时静默丢更新且返回假成功 |
| 2026-10-05 | `--by claude` | [SSE 断点续传的两处断裂](2026-10-05-sse-seq-guard-survives-restart.md) | 服务端重启后 seq 从 0 重数，客户端高水位丢弃全部新事件（静默不显示）；`Last-Event-ID` 写 seq 读 eventId，永不命中 |
| 2026-10-05 | `--by claude` | [InstanceSupervisor 并发 start/stop 双 spawn](2026-10-05-instance-supervisor-double-spawn.md) | `doStop` 空 child 早退会撤销 in-flight start 的 `starting` 态，守卫失效，孤儿进程占住端口 |
| 2026-10-05 | `--by claude` | [微信记忆轮转读了一个没人写入的路径](2026-10-05-wechat-memory-rotation-noop.md) | 三重不匹配（多一层目录 / 扩展名 / 格式），整条跨会话记忆静默空转 |
| 2026-10-05 | `--by claude` | [Vendor FileWriteTool 无符号链接拒绝](2026-10-05-vendor-write-symlink-bypass.md) | 权限检查在链接路径上评估、写入穿透到链接目标；上游已修，vendor 以错误理由跳过 |
| 2026-10-05 | `--by zai` | [缺 Host 头校验导致 DNS rebinding 任意文件读](2026-10-05-dns-rebinding-no-host-check--by-zai.md) | `fs.ts:1190,1336` 直接 `pathResolve(raw)` 不走 `resolveSafePath`；全服务树零 Host/Origin 校验 |
| 2026-10-05 | `--by zai` | [每次发消息都全局清空所有会话的待决审批](2026-10-05-prompt-close-aborts-all-approvals--by-zai.md) | ⚠️ 与上面 `--by opencc` 那条**同一处代码**；本篇带 keep-alive 下的 `close` 语义实证 |

### 中高 / 中

| 日期 | 发现者 | 严重度 | 标题 | 一句话 |
|------|--------|--------|------|--------|
| 2026-10-05 | `--by opencc` | 中高 | [ReplRegistry 未接入 closeServer 导致子进程泄漏](2026-10-05-repl-registry-child-process-leak.md) | `sh -c` 子进程在 zai 正常退出后存活；PTY 路径反被内核 SIGHUP 救回 |
| 2026-10-05 | `--by claude` | 中高 | [Vendor 类型闸门排除主入口 bundle-entry.ts](2026-10-05-vendor-type-gate-blind-spot.md) | 发布面是唯一不被 typecheck 的文件；已含重名 `TaskStatus` 与一个不存在的幽灵导出 |
| 2026-10-05 | `--by claude` | 中 | [SSE 连接泄漏 + session 删除不清 registry](2026-10-05-sse-subscriber-and-session-leak.md) | `req.on('close')` 注册晚于 await，断开后订阅者与心跳定时器永久泄漏 |
| 2026-10-05 | `--by zai` | 中高 | [停止按钮误杀另一个标签页的 turn](2026-10-05-abort-uses-global-session-id--by-zai.md) | `/agent/abort` 按 header abort 对了 sid，随后 `abortAgentSession` 又用全局 `currentSessionId` 杀一遍 |
| 2026-10-05 | `--by zai` | 中高 | [微信入站按文本内容指纹去重，吞掉合法重复消息](2026-10-05-weixin-content-fingerprint-dedup--by-zai.md) | `md5(text)` 当消息身份；实测两条不同 `message_id` 同文本只到 1 条，且命中续期致永久锁死 |
| 2026-10-05 | `--by zai` | 中 | [删除会话不中断运行中的 turn，被删的会话会自己回来](2026-10-05-delete-session-resurrects--by-zai.md) | DELETE 缺 `abortSessionController`；`finally` 的 wake 启动新 turn，`appendEntry` 重建被删文件 |
| 2026-10-05 | `--by zai` | 中 | [符号链接穿透：resolveSafePath 不跟随链接](2026-10-05-symlink-traversal-write-delete--by-zai.md) | `safePath.ts` 注释称「只读故已缓解」已失效——`fs.ts:548` 写、`:1516` 删都走它 |
| 2026-10-05 | `--by zai` | 中 | [微信入站游标早于 pending 落盘推进，重启丢消息](2026-10-05-weixin-cursor-ahead-of-persist--by-zai.md) | `disconnect()` 的 `flushAll(() => drop)` 既不落盘也不投递，游标已过故服务端不重投 |
| 2026-10-05 | `--by zai` | 低中 | [微信入站媒体无上限无回收 + 锁文件累积](2026-10-05-weixin-media-unbounded--by-zai.md) | `media/` 全仓无删除逻辑；`AccountLock` 每 token 建 base 文件不删，实测累积 1740 个 |

## 共同根因

**1. 「原地 `writeFile` 而非 tmp+rename」**（文件保存截断、settings tmp 冲突同源）。
本项目已在 `services/instanceStore.ts:110-114` 记录过该缺陷导致 2026-09-28
`instances.json` 变成 0 字节的真实事故，并修复了实例配置、settings、fileStore、
微信 pairing、context token 等全部写入点 —— 遗漏的是唯一直接写**用户源码**的
`fsWrite.ts`，以及未纳入串行化链的 `fileStore.writeConfig`。

修这几条时，**优先复用 `instanceStore` 的现成模式**（tmp 名带 pid + rename +
失败 unlink），不要另起炉灶。

**2. 「Express 4 + async handler + 无兜底」**（async handler 崩溃、SessionInbox
无效 catch、`fsWrite.ts:99` 同源）。`index.ts:336` 那个 catch-all error handler
给人虚假的安全感 —— 它存在、也确实工作，只是**对 async 路径完全无效**。
加一条进程级 `unhandledRejection` 兜底能同时止血这三条，但**不能替代**逐点修复：
兜底只是不让进程死，被吞掉的错误仍需在正确的层级被消费。

**3. 「vendor 同步依赖人工判断」**（symlink 守卫、类型闸门盲区同源）。
`da74a635` 用「不存在不对称」这个理由跳过了上游的**安全补丁** —— 结论对、
推理错。这类跳过需要可执行的校验来兜底，不能只靠注释记录判断。

**4. 「安全论证随代码漂移」**（`--by zai` 两条新增）。两处**注释里写着的安全前提
已经被后续改动推翻，但没人回来改注释**：

- `safePath.ts:10-17` 写「端点是只读的，符号链接风险已缓解」—— 后来
  `fs.ts` 加了写与删，同一个 helper 的前提变了。
- `agent.ts:1974-1979` 写「client 关 body 是正常 lifecycle，不要 abort」——
  注释识别出了正确语义，却只摘掉了一半（`abortController` 摘了，
  三个 `abortAll` 留着），且没有任何测试守住这个边界。

这两条的共同教训：**注释不是防线**。安全前提应有对应的测试或类型约束，
否则下次改动会静默地让注释变成谎言。

**5. 「安全模型建立在可绕过的前提上」**（`--by zai` 的 RCE + rebinding 同源）。
「只监听 localhost」被当作安全边界，但 CSRF 与 DNS rebinding **都经由用户浏览器
发起**，与监听地址无关 —— 攻击者不需要能访问 `127.0.0.1`。修这两条时，
`Host` 头白名单中间件是同一个开关，应一起加。

## 同族未修（严重度较低，暂未单独成文）

- `services/factorySettings.ts:183` / `:151-154` —— 原地写 + 解析失败静默回落默认值，
  丢失后被默认值持久化覆盖，变为永久
- `services/taskFactoryBridge.ts:89` / `:76-79` —— 同上，
  `supervisorSessionId` 丢失后 `injectSupervisorCommand` 永久 no-op
- `utils/fsWrite.ts:99` —— `stat()` 在 `try/catch` 之外，Express 4 下成为
  unhandled rejection（**不只挂住请求，按上面根因 2 会杀掉整个进程**，
  而文件此时已被修改）
