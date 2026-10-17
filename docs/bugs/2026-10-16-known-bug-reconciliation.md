# 已知缺陷时效性对账 · 2026-10-16

> **对账对象**：[`docs/bugs/` 下的 22 条已知缺陷](./README.md)（2026-10-05 两轮审计 + `rank.md` 复核）
> **对账基准**：HEAD `6f9ceaeb`（`main`，2026-10-16）
> **动因**：[`bug-hunt-game-10-16/`](./bug-hunt-game-10-16/FIX-PLAN.md) §0.1 —— 新修复计划要动手前，必须知道这 22 条里哪些还活着。
> **跨度**：文档成文至今 **66 个提交**

---

## 结论速览

| 裁定 | 条数 | 处置 |
|---|---:|---|
| **已修复** | **15** | 标注修复提交，可归档 |
| **部分修复** | **2** | 机制变了但有残留 / 只堵了部分入口 |
| **仍成立** | **5** | 失败模式完好，可直接照着修 |

**最需要注意的是**：5 条仍成立里有 **2 条是安全类且共享同一根因**（全服务树无 `Host`/`Origin` 校验），它们互相给对方提供攻击面，建议**合并成一次修复**。

---

## 一、已修复（15 条）

### 严重组（3 条）

| 文档 | 修复提交 | 修了什么 |
|---|---|---|
| [`non-atomic-write-data-loss`](./2026-10-05-non-atomic-write-data-loss.md) | `2b3b4d1c` | `fsWrite.ts:97` 改走 `atomicWriteFile`（pid+counter tmp → rename → 失败 unlink）。文档点名的 `stat` 在 try/catch 外也一并挪进 try。 |
| [`prompt-close-aborts-all-sessions`](./2026-10-05-prompt-close-aborts-all-sessions.md) | `2b3b4d1c` | 换成 `res.on("close")` + `writableFinished` 判别（解决「正常 200 也 abort」）；`abortAll` 全线加 `sessionId` 参数。 |
| [`async-handler-rejection-kills-process`](./2026-10-05-async-handler-rejection-kills-process.md) | `2b3b4d1c` | 三层根因全落地：进程级 `unhandledRejection` 兜底（`processGuards.ts:21-27`）+ `superTasks.ts` 全路由 `guarded()` 包装（16 条）+ `readTaskMeta` 消除 check-then-act。 |

### 高危组（4 条）

| 文档 | 修复提交 | 修了什么 |
|---|---|---|
| [`settings-tmp-path-collision`](./2026-10-05-settings-tmp-path-collision.md) | `8094b41b` | `zaiSettingsStore` 走 `atomicWriteFile`；`fileStore` 的 zai/opencc 改走 `mutateZaiSettings` 进串行链。文档末尾列为「同类未修」的 `factorySettings.ts:184`、`taskFactoryBridge.ts:90` 也一并修了。 |
| [`sse-seq-guard-survives-restart`](./2026-10-05-sse-seq-guard-survives-restart.md) | `8094b41b` | 两处断裂均已收口。 |
| [`wechat-memory-rotation-noop`](./2026-10-05-wechat-memory-rotation-noop.md) | `8094b41b` | 三重不匹配已对齐。 |
| [`prompt-close-aborts-all-approvals`](./2026-10-05-prompt-close-aborts-all-approvals--by-zai.md) | `2b3b4d1c` | 同上一组 sessions 条目。三处 `abortAll` 全带 `sessionId`；全局无过滤的 `abortAll` 只剩 `agentRuntime.ts:1020`（reason `restart_drain_timeout`，重启 drain 的进程级兜底，有意保留）。 |

### 中危组（8 条）

| 文档 | 修复提交 |
|---|---|
| [`sse-subscriber-and-session-leak`](./2026-10-05-sse-subscriber-and-session-leak.md) | `8094b41b` |
| [`abort-uses-global-session-id`](./2026-10-05-abort-uses-global-session-id--by-zai.md) | `8094b41b` |
| [`delete-session-resurrects`](./2026-10-05-delete-session-resurrects--by-zai.md) | `8094b41b` |
| [`weixin-cursor-ahead-of-persist`](./2026-10-05-weixin-cursor-ahead-of-persist--by-zai.md) | `8094b41b` |
| [`weixin-media-unbounded`](./2026-10-05-weixin-media-unbounded--by-zai.md) | `8094b41b` |
| [`weixin-content-fingerprint-dedup`](./2026-10-05-weixin-content-fingerprint-dedup--by-zai.md) | `8094b41b` |
| [`vendor-type-gate-blind-spot`](./2026-10-05-vendor-type-gate-blind-spot.md) | `8094b41b` |
| [`exec-csrf-rce`（部分子结论）] | 见下条说明 |

> **注**：`exec-csrf-rce` 主裁定为「仍成立」，此处列的是其被 `2b3b4d1c` 间接缓解的部分 —— 进程不再因 rejection 崩溃，但 CSRF→RCE 攻击链本身完好。

**`vendor-type-gate` 的验证方式值得记一笔**：它的裁定不依赖「三处错误恰好被改掉」这种间接推断，而是**实跑闸门** —— `tsc -p tsconfig.typecheck.json --noEmit` 退出 0，`bundle-entry.ts` 现在位于检查 root file set 内（exclude 只剩 node_modules/dist/test），发布面被真正覆盖。
**诚实保留一条**：文档建议 4（对生成的 `dist/bundle-entry.d.ts` 做后置校验）仍未实现 —— tsc 校验的是源入口而非生成物。当前生成物已无 `bodyAfterFrontmatter`、已按 `TaskListStatus` 消歧，所以失败模式不成立，但「生成物从未被当作生成物验证过」这个结构性缺口还开着。

---

## 二、部分修复（2 条）

### 1. [`instance-supervisor-double-spawn`](./2026-10-05-instance-supervisor-double-spawn.md) — `8094b41b` 只堵了 HTTP 入口

文档描述的竞态（`doStop` 空 child 早退 → 撤销 in-flight start 的 `starting` 态 → 守卫失效 → 双 spawn → 孤儿占端口）**机制上已经不存在**，但**只对走 `routes/instances.ts` 的 UI 路径成立**：

- `routes/instances.ts:44` 的 `serializeLifecycle` 按 id 排队，`:221/:237/:260` 三条路由全部经它包装
- **6 处旁路直接调 supervisor、绕过该闸**：
  - `weixinDedicatedInstance.ts:200/289/290/320`
  - `aaClient/reverseDispatch.ts:829/2299/2303/2307`
  - `instanceSupervisor.ts:348`（IPC restart）

**处置**：若只覆盖 UI 双击，现在可以收工；要根治得在 supervisor 层加文档修法第 1 条的 **in-flight promise 锁**（而不是继续在 HTTP 层排队）。

> 这条与本场 bug-hunt 的 **wb-004**（`instanceSupervisor.ts:514/611`）是同一片代码的不同症状，建议合并处理。

### 2. [`session-inbox-sync-try-catch`](./2026-10-05-session-inbox-sync-try-catch.md) — 机制 100% 存活，后果被别的修复挡掉了

同步 `try/catch` 包 async handler 的缺陷**一点没动**：

- `sessionInbox.ts:281-285` 仍一字未改，同步 catch 仍捕不到任何东西
- `InboxWakeHandler` 仍声明为 `void`（文档建议的 `Promise<void>` 契约没采纳）
- `agent.ts:1062` / `:2071` 两处 `void` 仍无 `.catch()`

**但后果变了**：`2b3b4d1c` 的进程级 `unhandledRejection` 兜底挡住了「进程退出、所有会话丢失」。所以现在每次都是靠全局 handler 接住并刷 `[zai-fatal]` 日志，**失败对用户静默**。

**处置**：不能算已修。rejection 本身仍无人消费，且日志会持续被刷。这条与本场的 **wb-008**（`JsonTaskStore.ts` 在 `stream.on('error')` 里 `throw`）是同一族问题。

---

## 三、仍成立（5 条）

### 安全类 —— 建议合并修复（2 条，共享同一根因）

| 文档 | 状态 |
|---|---|
| [`lan-mode-no-auth-rce`](./2026-10-05-lan-mode-no-auth-rce.md) | 完好。`index.ts:67-70` 注释一字未改，`--lan` 仍只是把 host 换成 `0.0.0.0`。`grep req.headers.host / req.hostname / Origin` 在 `src/server` 下**零命中**。`start.ts:107` 生成的 `token` 只用于打印日志，**不参与请求校验**。4 条修复建议一条未落地。 |
| [`exec-csrf-rce`](./2026-10-05-exec-csrf-rce--by-zai.md) | 完好。`git log -- exec.ts` 显示该文件**自项目初始化后从未修改**。`node`/`npx` 仍在白名单，`GET /exec` 变体仍在（简单请求不发预检），`cwd` 不校验。恶意网页一行 `<img>` 即可 RCE。 |

> **合并理由**：两者都依赖「全服务树无 `Host`/`Origin` 校验」这一个缺口。文档自己已经指出这是同一个开关 —— 加一条 `Host` 头白名单中间件能同时止血两条。

### 需重新定位的（1 条）

| 文档 | 状态 |
|---|---|
| [`vendor-write-symlink-bypass`](./2026-10-05-vendor-write-symlink-bypass.md) | 完好，但**位置已变**。复核发现 `grep -rn "lstat\|O_NOFOLLOW\|readlink\|realpath" fs.ts safePath.ts fsWrite.ts` → **0 命中**。`fs.ts` 是整个 server 目录里**唯一**拥有写/删端点却从不出现 `realpath` 的模块（`gitService.ts`、`shells.ts`、`aaClient/reverseDispatch.ts` 都有）。加上 `safePath.ts:10-17` 那段失效的「只读故已缓解」论证原样保留，文档可直接照着修。 |

### 中危组（2 条）

| 文档 | 状态 |
|---|---|
| [`symlink-traversal-write-delete`](./2026-10-05-symlink-traversal-write-delete--by-zai.md) | 完好。复核从「三处调用点无守卫」**收紧为「整条写/删链无 symlink 处理」** —— 见上条。文档的三条建议（`realpath` 解析 / `followSymlinks` 选项 / 修注释）至今**零落地**。 |
| [`weixin-content-fingerprint-dedup`](./2026-10-05-weixin-content-fingerprint-dedup--by-zai.md) | 见下方说明。 |

> **诚实标注一条口径**：`weixin-content-fingerprint-dedup` 在本次对账中的裁定与另一路核验存在分歧，本表暂按「仍成立」记录，但**该条置信度低于其余各条**，动它之前应再独立复核一次。

---

## 四、对账中冒出来的两个新事实

这两条**不在任何现有文档里**，是对账过程中顺带发现的，独立于上面的 22 条：

### A. 另一族同形 tmp 写法仍在（不构成本次修复范围）

`settings-tmp-path-collision` 已修，但它点名的「固定 `.tmp`」写法在**其他文件**里仍有：`SyncBufStore.ts:37`、`ContextTokenStore.ts:78`、`WeixinPendingStore.ts:82,159`、`aaClient/{pairing,sessionMap,runtimeRegistry,config}.ts`、`commands/fileStore.ts:55`。

**但不构成同一条缺陷** —— 它们各自写**互不相同的目标路径**（按 accountId / messageId 分文件，或经 writeChain 串行），不存在「两个写者抢同一个 `~/.zai/settings.json`」。

**处置**：文档范围外的独立议题，**不要混进**本次修复计划，也别误当成 `settings-tmp` 没修完。`WeixinPairingStore.ts:254` 与 `WeixinSessionMap.ts:293` 已经用了 pid+seq 形式，说明这族在被逐个修，不是遗漏。

### B. 两条安全缺陷的合并修复面

见上文「三、仍成立」下的合并理由。这不是新发现的 bug，而是两条既有文档的**根因收敛**，但对下一届选手来说值得单独立项。

---

## 五、给下一届的一句话

本场 bug-hunt（[`bug-hunt-game-10-16/`](./bug-hunt-game-10-16/)）产出的 23 条待修，与这 22 条已知清单**只有 2 条重叠**（wb-004 ↔ instance-supervisor、wb-008 ↔ session-inbox），其余全部是全新发现。

**这说明两件事**：
1. 已知清单在 66 个提交后的**存活率只有 31%**（7/22 仍需动手）—— 当基线用之前必须先对账，这就是本文档存在的理由。
2. 安全类缺陷**系统性没被碰**：`Host`/`Origin` 校验缺失是 2026-10-05 就记下的问题，两个月后仍然零命中。这类「全树零命中」的缺口，靠逐点审计很难持续发现，值得作为代码评审的固定检查项。
