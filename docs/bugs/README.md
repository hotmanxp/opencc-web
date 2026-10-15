# docs/bugs/

已确认但**尚未修复**的缺陷记录。每条包含：根因、精确位置、可复现的实证、修复方向。

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

## 未修复

### 严重

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
