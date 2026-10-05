# docs/bugs/ 复核评估报告

| 项 | 值 |
|----|----|
| 评估者 | **claude**（5 路独立对抗性复核 agent 并行执行，证伪优先） |
| 评估对象 | `docs/bugs/` 下 22 份缺陷文档（`--by opencc` 4 / `--by claude` 9 / `--by zai` 9）+ `README.md` 索引 |
| 复核基线 | HEAD `da6a49b6` |
| 复核日期 | 2026-10-05 |
| 复核方式 | 逐条断言回到源码对 `file:line`；能跑只读实测的跑（Express 语义探针、`node:http` 连接探针、typecheck delta、磁盘计数、无凭证 curl、`git show`） |

> **本报告的立场**：默认每条断言是错的，直到证据支持。复核者被明确要求证伪优先。
> 文档作者「亲自复现过」不等于结论成立——复现到位与推断到位是两件事。

---

## 0. 总览

| 档位 | 总数 | 完全确认 | 部分确认 | 证伪 | 重复记录 |
|------|------|---------|---------|------|---------|
| 严重 | 7 | 4 | 1 | 1 | 1 |
| 高 | 7 | 6 | 1 | 0 | 0 |
| 中高 / 中 / 低中 | 8 | 6 | 2 | 0 | 0 |
| **合计** | **22** | **16** | **4** | **1** | **1** |

**核心结论**：`README.md` 的严重度分级不可直接采信。**「严重」档 6 条里，2 条站得住、2 条虚高、1 条被证伪、1 条是重复记录。**

README 提出的 5 个「共同根因」中，根因 2（Express 4 + async handler 无兜底）、3（vendor 同步依赖人工判断）、4（安全论证随代码漂移）成立；但**没有一条能挽救被证伪的那条严重项**。

---

## 1. 逐条复核结论

### 1.1 严重档

| 文档 | 发现者 | 结论 | 严重度 | 复核评分 |
|------|--------|------|--------|---------|
| `lan-mode-no-auth-rce` | claude | ✅ CONFIRMED | **严重 维持** | 9/10 |
| `exec-csrf-rce--by-zai` | zai | ✅ CONFIRMED | **严重 维持** | — |
| `prompt-close-aborts-all-sessions` | opencc | ✅ CONFIRMED | **严重 维持** | 9/10 |
| `async-handler-rejection-kills-process` | claude | ✅ CONFIRMED | ⚠️ 降为**中高** | 9/10 |
| `non-atomic-write-data-loss` | opencc | ⚠️ PARTIALLY | ⚠️ 降为**中** | 7/10 |
| `prompt-close-aborts-all-approvals--by-zai` | zai | ✅ 重复记录 | 高 | 7/10 |
| `session-inbox-sync-try-catch` | claude | ❌ **REFUTED** | ⚠️ 应为**低** | **3/10** |

### 1.2 高档

| 文档 | 发现者 | 结论 | 严重度 | 复核评分 |
|------|--------|------|--------|---------|
| `settings-tmp-path-collision` | opencc | ✅ CONFIRMED | 高 维持 | 9/10 |
| `sse-seq-guard-survives-restart` | claude | ✅ CONFIRMED | 高 维持 | 9/10 |
| `wechat-memory-rotation-noop` | claude | ✅ CONFIRMED | 高 维持 | 9/10 |
| `prompt-close-aborts-all-approvals--by-zai` | zai | ✅ CONFIRMED | 高 维持（与 opencc 重复） | 7/10 |
| `dns-rebinding-no-host-check--by-zai` | zai | ⚠️ PARTIALLY | 高 维持 | 7/10 |
| `vendor-write-symlink-bypass` | claude | ⚠️ PARTIALLY | ⚠️ 降为**中高** | 5/10 |
| `instance-supervisor-double-spawn` | claude | ⚠️ PARTIALLY | 高 维持 | 6/10 |

### 1.3 中高 / 中 / 低中档

| 文档 | 发现者 | 结论 | 严重度 | 复核评分 |
|------|--------|------|--------|---------|
| `repl-registry-child-process-leak` | opencc | ✅ CONFIRMED | 中高 维持 | 9/10 |
| `vendor-type-gate-blind-spot` | claude | ✅ CONFIRMED | 中高 维持 | 9/10 |
| `abort-uses-global-session-id--by-zai` | zai | ✅ CONFIRMED | 中高 维持 | 9/10 |
| `weixin-content-fingerprint-dedup--by-zai` | zai | ✅ CONFIRMED | 中高 维持 | 9/10 |
| `sse-subscriber-and-session-leak` | claude | ✅ CONFIRMED | 中 维持 | 9/10 |
| `weixin-cursor-ahead-of-persist--by-zai` | zai | ✅ CONFIRMED | 中 维持 | 8/10 |
| `delete-session-resurrects--by-zai` | zai | ⚠️ PARTIALLY | 中 维持 | 6/10 |
| `weixin-media-unbounded--by-zai` | zai | ✅ CONFIRMED | ⚠️ 媒体部分应为**中** | 7/10 |

---

## 2. 质量最高的几个

### 2.1 `--lan` 模式全 API 零鉴权（--by claude）— 全批次最高分

唯一一条**活体复现**的文档，也是唯一「未授权远程 RCE + 微信账号完整接管」闭环成立的文档。

- 复核者无凭证 `GET /api/system` **逐字复现**出 `host:0.0.0.0, ips:[192.168.101.69], isManagedChild:true, supervisorPid:42945`
- `GET /api/weixin/status` 无凭证返回 `accountId:"cdc6ab853280@im.bot", state:"connected", owner:true`
- `lsof` 确认 **5 个实例绑 `*:`**（文档列了其中 4 个，是子集，不算错）
- `packages/zai/src/server` 全树 grep `req.hostname` / `headers.host` / `Origin` / `cors(` → **零命中**
- 复核者用 `GET /api/exec?cmd=echo&args=hello` 无凭证执行成功（exit 0），同时实证了 CSRF 论点：**GET 就能产生副作用且不触发 CORS 预检**

行号仅 2 处差 1-2 行。修复方向对症，`--lan` 强制显式 token + 默认 localhost 零摩擦确实是比恢复 `tokenGuard` 更好的方案。

### 2.2 prompt 正常响应即 abort 全进程所有 pending（--by opencc）— 技术精度最高

- 12 个 file:line 只错 1 处（`askRegistry.ts` 差 1 行）
- 关键机制**实测坐实**：`[t=9ms] req "close" FIRED` 与客户端收到完整响应**同一 tick 触发**，keep-alive agent 的 socket 仍可复用也照触发
- `disposeSessionAgents` 全仓零调用方（仅命中定义行）
- 三个 registry 的 `abortAll` 无 sessionId 过滤，而 `listBySession` 就在旁边且没被用

**并且它是那组重复发现里更完整的一份**：明确指出「按 sessionId 过滤也修不好同会话场景」——这是 zai 那份给「按 sid 过滤」当最小改动时会漏掉的半个坑。

### 2.3 未捕获 async handler 异常杀进程（--by claude）— 行号精度最离谱

- **17 个 file:line 零漂移**，全部落在裸 `await` 上
- 机制用真实 stack trace 复现：`layer.js:95:5` / `route.js:149:13`，exit code 1
- 全仓零 `unhandledRejection` / `uncaughtException` 注册（唯一命中是 `agent.ts:1327` 的一句注释）

### 2.4 Vendor 类型闸门盲区（--by claude）— 零事实错误

复核者改 tsconfig 跑出**恰好 3 个错误**，与文档完全一致：

```
src/bundle-entry.ts(213,25): error TS2300: Duplicate identifier 'TaskStatus'.
src/bundle-entry.ts(276,3):  error TS2305: Module '"...taskFactoryFiles.js"' has no exported member 'bodyAfterFrontmatter'.
src/bundle-entry.ts(281,3):  error TS2300: Duplicate identifier 'TaskStatus'.
```

额外查实：`packages/zai/src/web/src/lib/taskApi.ts:8` 还有**第三套语义不同**的 `TaskStatus`（`'queued'|'running'|'completed'|'failed'|'cancelled'`，与 vendor 两个 union 都不同）——是三方分裂，不只是重名。

### 2.5 CSRF 导致 RCE（--by zai）— zai 组最佳

- `exec.ts:9-20` 白名单含 `node`/`npx`/`npm`，复核者逐字核对
- 纯 GET、参数全在 query、无自定义 header → **确认是 simple request，不触发预检**，`<img src>` / `<script src>` / 表单都能打进去
- 复核者用 `Origin: https://evil.example` 复测，响应**无 `Access-Control-Allow-Origin`** → 是 **blind RCE**。文档没夸大，PoC 走攻击者自己的回传通道
- **额外查实（替人清了文档留的待办）**：`grep "api/exec"` 显示前端唯一调用方是 `Dashboard.tsx:204` 的 `POST`，**全仓无任何 EventSource / fetch 消费 GET 变体 → 是死代码，可直接删**

### 2.6 次一档（8-9 分，可直接进修复队列）

- `settings-tmp-path-collision`（opencc）：行号零漂移。**但漏了更大的一半**——`writeConfig` 是整对象覆盖，完全绕过 `updateZaiSettings` 的 read-merge-write，所以**即使不并发**，在配置页保存一次「Zai」就会回滚设置抽屉期间写入的所有字段。竞态只是更大问题的附加症状。复核者还查实这不是理论路径：`Config.tsx:13-18` 的 tab 列表含 `zai`，`:579` 走 `api.put('/config/zai', ...)`。
- `wechat-memory-rotation-noop`（claude）：三重不匹配逐条命中，**磁盘证据独立复现全对**（`~/.zai/transcripts` 最新 mtime Aug 2 / `~/.zai/projects/*.jsonl` 825 个 / `~/.zai/weixin/memory/` 1 个目录 0 个文件）。**复核者补的一步把结论从「推断」升级为「已证实的回归」**：那些陈旧 `.json` 的实际结构 `{version, transcriptId, meta, messages}` 正是读取方解析器期待的形状 → 读取方是照着**旧版写入方**写的，写入方后来搬走了，读取方从未跟进。
- `sse-subscriber-and-session-leak`（claude）：行号全对。复核者自建 `node:http` 探针（不用项目代码）复现三个 Node 语义断言：(a) `req` `close` 是一次性的、晚注册永不触发；(b) 已 destroy 的 response 上 `res.write` **返回 false 而不抛异常**，所以 `:151-153` 的 `catch` 永不触发；(c) `await closed` 挂起、`finally` 永不执行。
- `repl-registry-child-process-leak`（opencc）：行号全对，`closeServer` 链路 9 步逐项核对确实**没有 ReplRegistry**，生产代码里 `dispose()` 无任何调用点，也无 `process.on('exit')` 兜底。PTY 反转的分析技术上正确。**复核者补的一点抬高 stakes**：managed child 以 `detached:false` spawn、按 pid kill，所以 supervisor 驱动的重启**也扫不到这些孙进程**。
- `abort-uses-global-session-id--by-zai`（zai）：**零事实错误**。复核者查到比文档更强的证据——`agent.ts:1705` 在 7 种 `runtime.*` 事件分支里都调 `setCurrentSessionId(event.sessionId)`。
- `weixin-content-fingerprint-dedup--by-zai`（zai）：**零事实错误**，两层 key 空间不重叠的推理链成立，续期锁死（4 分钟重发一次 < 300s TTL，每次命中推到 `now+300s`）成立。

---

## 3. 必须修正的结论

### 3.1 `session-inbox-sync-try-catch`（--by claude，严重）→ ❌ **证伪，应降为低**

漏读了 `packages/zai/src/server/services/sessionInbox.ts:341-353`：

```ts
if (moduleWakeHandler) {
  const fn = moduleWakeHandler
  inbox.setWakeHandler((sid) => {
    fn(sid).catch((err) =>          // ← 这里已经消费了 rejection
      console.warn('[SessionInbox] wake runNextInQueue failed:', err),
    )
  })
}
```

全仓 `new SessionInbox()` 只有三处：本工厂、`:386` 的模块级单例（handler 是 no-op `() => {}`，不可能 reject）、两个测试文件。**所有走热路径的 inbox 都被 `.catch()` 包住，promise 从不 unhandled。**

文档第 4 步「返回 Promise，被丢弃 → 无人持有的 rejected promise」不成立。

**讽刺点**：文档「修复」章节给出的代码 `this.wakeHandler(sessionId).catch(err => console.warn(...))` **和 `getSessionInbox` 里已写好的实现是同一个东西**。把已上线的防御当成了缺失。

真正剩下的问题只有一个，且不是崩溃：`InboxWakeHandler` 类型签名是 `(sessionId: string) => void`（`sessionInbox.ts:81-83`），**返回 void 的类型让 TypeScript 完全看不见这个 promise**——这才是那段同步 try/catch 存在的心理原因，也是一个真实的可维护性陷阱。属死代码清理 + 类型契约修正，非 P0。

### 3.2 `vendor-write-symlink-bypass`（--by claude，高）→ ⚠️ **影响分析被推翻，修复前必须重新界定范围**

**核心断言被证伪**：「权限检查在链接路径上评估（通过），实际写入落在链接目标上（未检查）」不成立。`checkWritePermissionForTool`（`filesystem.ts:138`）调 `getPathsForPermissionCheck`（`fsOperations.ts:295-386`），后者沿 **lstat→readlink 整条链**收集每个中间目标，然后：

- deny 规则遍历所有变体（`filesystem.ts:1339-1358`）
- ask 规则遍历所有变体（`filesystem.ts:1464-1477`）
- `checkPathSafetyForAutoEdit` 遍历所有变体（`filesystem.ts:731-769`）
- `pathInAllowedWorkingPath` 用 `.every()`（`filesystem.ts:810-814`）→ 逃出 cwd 的链会让 `isInWorkingDir` 为 false，**阻断 `acceptEdits` 自动放行**（`:1490`）

**文档自称的「缓解因素」也被直接反驳**：`fsOperations.ts:336-345` 的注释**点名了这个攻击**（`./evil.txt -> ~/.ssh/authorized_keys2` dangling 场景），然后调 `resolveDeepestExistingAncestorSync`（`:222-252`，lstat-based + dangling 的 readlink fallback）堵上。

**真实残余缺口**（窄得多）：第 4 步 allow 规则匹配只用 `path` 不用 `pathsToCheck`（`filesystem.ts:1502-1507`）。宽 allow 规则（如 `Edit(./**)`）会匹配链接路径返回 `allow`。这是纵深防御缺口，不是「绕过整个权限系统」。

结构性事实仍成立：vendor 的 `FileWriteTool.ts` grep `symlink|lstat` **零命中**；`file.ts:372-383` 确实读链接、写穿透；上游 `opencc/src/tools/FileWriteTool/FileWriteTool.ts:149` 有 `symlinkDenyDecision`（commit `b8b7085e`）；`da74a635` 的跳过理由原文核对无误。**结论对、推理错。**

### 3.3 `instance-supervisor-double-spawn`（--by claude，高）→ ⚠️ **复现链按字面走不成立**

行号全部精确（264/309/310/327/330/410/439/529-530/531/572），机制成立（`:439` 早退无条件 `setStatus('stopped')`，`:309` 守卫是 check-then-act 且中间隔两个 await）。

**但「双击重启」走不通**：两次点击若都在 C1 存活期间发出，R2 的 `doStop` 进入时 `entry.child` **非 null** → 走正常路径 → 两个 doStop 同一 tick resolve → R1 的 `doStart` 同步前缀设 `starting` → R2 的 `doStart` 撞守卫 → **返回，无双 spawn**。文档步骤 3 的前提未解释时序。

**空窗宽度的论证也是错的**：`cli/ports.ts:61` 的 200ms 是**单次探测的超时上限**（只在 `::1` connect 被黑洞时触发），函数本体在 `:43`。常见情况下端口刚释放，首次 `ECONNREFUSED` 立即返回，**窗口是一个 event-loop turn**。

**复核者改写出的真实可达路径**：
1. **自动扫描 + 多个基础端口被占**时，`probePortDefault` = `findAvailablePort`，最多循环 100 个候选，每个都是真 connect + bind + close 的 await → 反复让出到 I/O 阶段 → 已排队的第二个请求会在扫描中途被派发，看到 `entry.child === null`，clobber 状态，自己的 `doStart` 直接穿过守卫
2. **UI 无 in-flight 守卫**已核实：`Instances.tsx:242` 的 `act()` 直接 `fetch`，无 pending 态；`disabled={!canRestart}` 是状态派生，而 `loadInstances()` 只在整条请求完成后才刷新 → **整个重启期间按钮都可点**
3. 钉端口路径窗口更窄（`assertPortAvailable` = 一次 connect + 一次 bind），但仍是真实的 turn 边界

**文档低估的泄漏**：`attachChild` 的 exit handler 无条件 `entry.child = null`（约 `:289-290`），所以泄漏的 C2 日后退出时**还会把 C3 的引用也清掉**——supervisor 连带丢失对存活 child 的追踪。其上方那句注释「a stale exit from a replaced child can never touch the new entry.child」**与代码不符**，这是文档没提的第二个缺陷。

### 3.4 `dns-rebinding-no-host-check--by-zai`（--by zai，高）→ ⚠️ **标题级断言可证伪，但根因范围被低估**

- ❌ **「可读取 `~/.ssh/id_rsa`」是错的，且与文档自己引用的白名单自相矛盾**。`/fs/preview` 在 `:1205` 走 `classifyKind`（`shared/fileKind.ts:130-141`），`id_rsa` 无扩展名 → `kind='binary'` → 落到 `:1272-1278`，**只返回元数据**；`/fs/raw` 在 `:1335` 直接 **415**
- ✅ 准确表述是「读任意**白名单扩展名**的文件」：`.json`/`.md`/`.txt`/`.yaml`/`.sh`/`.py`/`.ts`/`.env` 全在 `TEXT_EXTS` 里 → `~/.zai/settings.json`（含 API key）、`~/.claude/settings.json`、任意项目 `.env` 照读不误（1 MiB 上限）
- ❌ 端点名 `GET /api/fs/file/preview` **不存在**，实际是 `GET /api/fs/preview`
- ⚠️ 3 处行号漂移：`:1336`→`:1333`、NUL 检查描述错（preview 根本没有，只有 `/fs/raw` 有）、扩展名白名单 `:1337`→`:1334-1335`
- ⚠️ 「两处都只做 `\x00` 检查」对 preview 不成立

**文档漏报了 4 个同样无锚定的端点**（根因比它写的更广）：

| 端点 | 问题 |
|------|------|
| `routes/fsPicker.ts:43-53` | `resolve(expandTilde(raw))`，完全不受 cwd 约束的目录列举 |
| `routes/desktopFs.ts:103` | `/desktop/fs/file` → `normalizePath()` → `resolve(expandTilde(raw))`，无锚定 |
| `routes/desktopFs.ts:56` | `/desktop/fs/list` 同理 |
| `routes/fs.ts:1571` | `/fs/resolve` 注释明写「绝对路径不在此约束内」 |

对照 `routes/dirs.ts:117` 的 `/dirs/file` **是有**根 + 子目录 + 扩展名三重白名单的 → 这是同文件/同目录内的不一致，不是全局设计。

零 Host/Origin 校验 ✅ 完全确认（穷尽 grep + 实测无 ACAO）。

### 3.5 `symlink-traversal-write-delete--by-zai`（--by zai，中）→ ⚠️ 漏洞成立，**但 PoC 原样跑不通**

- 文档 PoC 是 `PUT { path: "link" }`，但 `fs.ts:553-558` 有扩展名白名单：`extname('link')` 为 `''`、basename 不以 `.` 开头 → **返回 400**。命名成 `evil.json -> ~/.ssh/id_rsa` 可绕过（`stat` 跟随符号链接、`isFile()` 通过、`writeFile` 也跟随）
- **leaf vs intermediate 没讲清，而这恰是全部微妙之处**：
  - 对**叶子**符号链接，`fs.rm`/`fs.rmdir` 走 unlink 语义——删的是链接本身，**不逃逸**（`rmdir` 对 symlink-to-dir 甚至直接 ENOTDIR）
  - 真正能删到 cwd 外的是**中间目录**符号链接（`cwd/dirlink -> /outside/dir`，请求 `dirlink/file.txt`）——只有中间路径分量被跟随
  - 写侧则 leaf 与 intermediate **都**成立（`writeFile` 跟随）
- 行号：`safePath.ts:39`→实际 `:36`（`:39` 是 `startsWith(root + sep)` 前缀判定）
- 严重度可微降到低-中（需 cwd 内已有符号链接 = 事后布置），但**与 exec RCE 组合起来是一条写原语**

### 3.6 `delete-session-resurrects--by-zai`（--by zai，中）→ ⚠️ **症状对，归因错**

- ❌ **文档点名的重建函数 `appendEntry` 不是实际写入者**。它走 `store.append`——而那是**空实现**（`compat/runtime/legacyTranscriptStore.ts:528-533`，注释：「vendor QueryEngine 直接写文件, 这里保持 no-op」）。`appendAssistantMessageV2`（`persistence.ts:316`）和 `appendToolResult`（`:291`）都被吞掉
- ✅ 真正的重建者是 vendor 写入器：`sessionStorage.ts:1046-1055` `appendDirectlyToFile` = `mkdir(dirname)` + `fsAppendFile`；`appendEntry`（`:1793`）在 `sessionFile` 指针已缓存时直接 append、**不复查文件是否存在**。facade 侧 `sessionFacade-impl.ts:99-115` 同样对 ENOENT 做 mkdir + 重试
- **实际比文档描述的更容易发生**：不需要新 turn，**在跑的 turn 自己就会把文件写回来**
- ⚠️ 「finally 启动新 turn」有未言明前置条件：`flushSessionInboxNextStep` = `promoteNextStepToNextTurn`（`busyFlush.ts:67-79`），只在 `promoted > 0` 时才 `inbox.wakeFor`；普通流式 turn 的 inbox `nextStep` 车道为空 → 返回 0，不 wake

其余断言全对（DELETE 缺 abort、`disposeSessionInbox` 生产零调用、`disposeSessionAgents` 零调用、`:1905` finally、`agentRuntime.ts:502` 在测试 seam 内）。

### 3.7 `non-atomic-write-data-loss`（--by opencc，严重）→ ⚠️ 机制成立，严重度虚高

- ✅ `fsWrite.ts:85` 裸 `writeFile`、`fs.ts:593` 调用点也**没包 try/catch**、2MB 上限、`instanceStore.ts:110-114` 事故注释原文、Node `'w'` = `O_WRONLY|O_CREAT|O_TRUNC`
- ❌ **「`fsWrite.ts` 是唯一直接写用户源码的路径」不准确**：`services/weixinBot/WeixinBotManager.ts:612` 用 `writeFile(path, ..., { mode: 0o600 })` 覆盖写 `~/.zai/weixin/accounts/<id>.json`（微信 QR 凭据 + token），无 tmp+rename。**这恰好推翻了文档「应用状态已全部改用 tmp+rename」的叙事本身**
- ⚠️ 严重度：触发窗口是**一次 ≤2MB 本地 writeFile 系统调用**（亚毫秒级）。真正能打中的只有 SIGKILL / 掉电 / ENOSPC。「不可逆的数据丢失」作为标签成立，作为**严重度**不成立——这是持久化加固项，不是数据丢失急救
- ⚠️ 文档**低估**了关联项：`fsWrite.ts:99` 抛出后实际是**进程直接退出**（见 async rejection 那条），比文档写的「响应永不发出、客户端挂起」更严重

### 3.8 `async-handler-rejection-kills-process`（--by claude，严重）→ ⚠️ 机制实证坐实，触发概率被夸大

17 个行号零漂移、Express 4 不 catch async rejection 已用 stack trace 复现（exit code 1）。但：

- 「**用户点一下删除，3 秒后的轮询就可能把整个 server 带走**」夸大了：`existsSync` → `await readFile` 的窗口是**每个任务亚毫秒级**，DELETE handler 必须精确插进那个 await 边界。这是窄 TOCTOU，不是「点一下就中」
- 文档同表列的 `setTaskFactoryState`（EACCES/ENOSPC/EROFS）和 `resources.ts:84` 的 `spawn('npx')`（ENOENT）**窗口宽得多**，那几条才是更现实的口子
- 结论：**类要修，触发叙述要软化**，严重 → 中高

### 3.9 重复记录：`prompt-close-aborts-all-approvals--by-zai`

README 说的 1 处重叠**属实**——两份都指 `agent.ts:1967-1987`（`req.on("close")` 在 1967，三个 `abortAll` 在 **1980/1983/1986**，闭括号 1987）。

- **谁先**：`--by opencc` 那份（README 称 zai 为「第三路」，mtime 17:14 vs 17:17 佐证）
- **谁更完整**：opencc。三点理由——(1) 它明确指出**按 sessionId 过滤修不好同会话场景**，zai 那份给「按 sid 过滤」当「最小改动」且无此提醒，照做会半个坑；(2) 它引了三个 registry 的完整行号（三个 `Pending` 类型本来就都带 `sessionId`），zai 那份只「断言三个类实现形状相同」没查；(3) zai 那份读代码注释「只摘掉了 `abortController.abort()`」略微低估——注释本身自相矛盾（`agent.ts:1115-1116` 之外那处），opencc 说得更准
- **但 zai 那份的实验更强**：keep-alive 探针打出 `close fired=1 writableEnded=true socket.destroyed=false` —— 这是两份里更强的实验，且它的**自评（「本篇带可复现的 Express 实证，那份带更完整的 registry 单例链路描述」）是诚实准确的**
- 建议：**合并到 opencc 那份**，把 keep-alive 实证与同会话提醒一并带过去
- 修复方案：`req.on('aborted')` 在 Node 17+ 已废弃且只在提前中断触发；正确判别是 `res.on('close')` 里判 `res.writableFinished`（复核者探针确认 `writableEnded=true` 在触发时成立）

---

## 4. 对 `README.md` 索引本身的修正建议

1. **删除 / 降级 `session-inbox-sync-try-catch`**——它当前列在「严重」档，结论已被证伪
2. **合并 `prompt-close-aborts-all-approvals--by-zai` 到 opencc 那份**，消除重复
3. **调整严重度**：非原子写（严重→中）、async rejection（严重→中高）、vendor symlink（高→中高）、weixin 媒体部分（低中→中）
4. **给 `instance-supervisor-double-spawn` 重写复现链**（改为「自动扫描模式下基础端口多被占 + UI 无 in-flight 守卫」），否则复核者按文档步骤走会得到假阴性
5. **给 `vendor-write-symlink-bypass` 重新界定范围**（真实缺陷是 allow 规则只匹配链接路径，不是「权限系统被绕过」）
6. **修订 `--by zai` 的自评措辞**：「全部结论均经**亲自复现**」——curl 往返是真的，但安全批里有可证伪的错误断言（`id_rsa`）和一个编造的端点名（`/api/fs/file/preview`）。**复现到位，推断没到位。**
7. **补充遗漏**：`~/.ssh/id_rsa` 不可读，但 `.env` / `settings.json` 可读；CSRF 的 GET 变体全仓无调用方、是死代码；服务端已不读 `X-Zai-Token`（前端仍在发，易误导读者以为有 token 防线）；Chrome LNA/PNA 对「公网页面 → 环回地址」子资源有 gating（唯一削弱 CSRF 实际可利用性的因素，Firefox/Safari 无此机制）

---

## 5. 发现者能力排名

**排名口径**：按**断言准确率**排（完全确认率 + 是否有材料级事实错误 + 严重度校准质量），而非按发现数量或标称严重度。

| 名次 | 发现者 | 分数 | 完全确认 | 证伪 | 材料级错误 |
|------|--------|------|---------|------|-----------|
| **1** | `--by opencc` | **8.5/10** | 3/4 | 0 | 0（仅严重度虚高 1 处 + 过宽的「唯一」断言 1 处） |
| **2** | `--by claude` | **7.6/10** | 6/9 | 1 | 3（1 证伪 + 1 坏复现链 + 1 影响分析被推翻） |
| **3** | `--by zai` | **7.5/10** | 5/9 | 0 | 4（1 可证伪断言 + 1 编造端点名 + 1 跑不通的 PoC + 1 归错函数） |

### 1st — `--by opencc`

3/4 完全确认，**零实质性事实错误**。4 条里 3 条零行号漂移（settings tmp、repl 泄漏全对，prompt close 只错 1 处）。prompt close 那条还是全批次**重复发现中更完整的一份**。代价最低、可直接照单修复。扣分只在严重度校准：把一个亚毫秒写窗口标成「不可逆数据丢失」，并用「唯一」这个词描述一条实际有反例的路径（`WeixinBotManager.ts:612`）。样本量只有 4 条，排名置信度相对低。

### 2nd — `--by claude`

**峰值最高、铺得最开**。交出全批次最高的单条发现（LAN RCE，唯一活体复现）和最高精度的一条（17 个行号零漂移 + stack trace 实证），另有 vendor 类型闸门（零错误、恰好 3 个 error delta）、SSE 泄漏（自建探针复现三个 Node 语义断言）、微信记忆轮转（磁盘证据 + 可追溯回归）。但 9 条里 1 条**彻底证伪**（漏读一个函数，把已上线的防御当缺失）、1 条复现链按字面走不成立、1 条影响分析被代码注释直接点名反驳。**错误集中在同一个环节**：「这行代码实际会被谁调用、失败会传播到哪里」——代码长什么样几乎不失手，链路回溯不够严。

### 3rd — `--by zai`

**实证纪律是三家里最好的**（curl 往返、Express 语义探针、mock long-poll 写失败用例、磁盘计数——`1740` / `79M` / `0 个 md` 都能独立复现），且 0 条被完全证伪，5 条零错误确认（abort 全局 sid、微信内容指纹去重是全批次零错误的两条）。但 4 条部分确认里**3 条带材料级错误**：一个被自己引用的白名单推翻的「任意文件读」、一个编造的端点名、一个被扩展名白名单挡下的 PoC、一个归错函数的机制（`appendEntry` 那条链上 `store.append` 恰恰是空实现）。

**差距不在做事，在把观察到的东西推成机制那一步。** 现象对而「为什么」错，是最危险的失败模式：如果后续有人照 `delete-session-resurrects` 去 `appendEntry` 链上找，会扑空。这与 claude 的失误是**同一种失效模式的两面**——一个过度概括（claude 说「绕过整个权限系统」），一个归因到错误的函数（zai），本质都是**没有把断言贯彻到「谁真的写盘 / 谁真的被检查」这一层**。

### 对三家的统一改进建议

1. **断言某函数「会写盘 / 会抛」之前先确认它不是空实现**——`store.append` 的 no-op 旁边就写着「直接写文件, 这里保持 no-op」，是个很隐蔽的陷阱
2. **安全断言要贯彻到白名单**：声称「可读 `~/.ssh/id_rsa`」前，先把同一份文档里引用的扩展名白名单套一遍
3. **写复现链要写出时序**：`instance-supervisor` 缺的正是「第二次点击在什么时刻被派发」
4. **`grep -n` 出的行号成文后手工誊抄容易漂 1-4 行**，直接贴 `grep -n` 输出更稳
5. **重复发现时，合并而不是各写一份**——但要如实标注哪份更完整（zai 那份的交叉引用自评是诚实的，值得保留）

---

## 6. 修复排队建议

**立刻做（唯一「现在正在被人利用」的）**：
- `lan-mode-no-auth-rce` + `exec-csrf-rce` + `dns-rebinding-no-host-check` **一起做**——同一个 `Host` 头白名单中间件，一次覆盖 CSRF、DNS rebinding 以及 §3.4 列的 4 个无锚定端点
- 顺手删掉 `/api/exec` 的 GET 变体（已证实是死代码）

**按 README 根因分组**：
- 根因 1（原地 writeFile）：`fsWrite.ts` + `fileStore.writeConfig` + `WeixinBotManager.ts:612`（后者是文档漏掉的），复用 `instanceStore` 现成模式
- 根因 2（Express 4 + async handler）：加进程级 `unhandledRejection` 兜底 + 逐点修；`readFile` + catch ENOENT 替掉 `existsSync` 是根因修法
- 根因 3/4：vendor 类型闸门把 `bundle-entry.ts` 纳回 typecheck；`safePath.ts:10-17` 的失效注释改掉

**先别排进队列**（需先重新界定）：`vendor-write-symlink-bypass`、`instance-supervisor-double-spawn`、`delete-session-resurrects`、`dns-rebinding` 的标题措辞
**直接删**：`session-inbox-sync-try-catch`

---

*本报告由 claude 评估生成，5 路独立对抗性复核 agent 并行执行。所有"✅ CONFIRMED"均附 file:line 证据，"实测"均为只读探测（无服务状态变更、无文件修改）。行号以 HEAD `da6a49b6` 为准，文档中另有少量 ±1~4 行的漂移已逐条标注。*

---
---

# 附录 A：第二份独立评估 —— zai

| 项 | 值 |
|----|----|
| 评估者 | **zai** |
| 评估对象 | 同上 22 份缺陷文档 + `README.md` 索引 |
| 复核基线 | HEAD `da6a49b6`（与上文同基线） |
| 复核日期 | 2026-10-05 |
| 复核方式 | 评估者亲验 13 条（三家各自的代表性条目 + 全部高严重度项），并行核验 agent 完成剩余 10 条；活实例 `curl`、Express 机制自展、磁盘计数、真实符号链接落盘 |

> **本附录的定位**：这是对同一批文档的**第二份独立评估**，与上文（claude）结论并不完全一致。两份的分歧点集中在**发现者排名**与**两条严重度校准**上；绝大多数逐条结论双方一致。
>
> **一处需要明说的自我修正**：评估者 zai 同时是三路原始发现者之一，本附录评的 22 条里有 9 条属于自评。核验过程中 **zai 有一条判断被上文证伪**（`session-inbox-sync-try-catch`），详见 §A.2。

## A.0 与上文的分歧点总览

| # | 分歧点 | 上文（claude）立场 | 本附录（zai）立场 |
|---|--------|------------------|-----------------|
| 1 | `session-inbox-sync-try-catch` | ❌ 证伪，建议删除 | **同意证伪**（见 §A.2，我原本判错） |
| 2 | 发现者第一名 | `--by opencc` (8.5) | **`--by claude`（理由见 §A.5，两轴口径） |
| 3 | `async-handler` 严重度 | 严重 → **中高**（触发窗口被夸大） | 同意降级，但**不同意降到中高**——类要修，且存在更宽的触发面 |
| 4 | `non-atomic-write` 严重度 | 严重 → **中**（亚毫秒写窗口） | **部分同意**：接受窗口论证，但严重度应留**中高**（用户数据 + 已漏微信凭据写入点） |
| 5 | `settings-tmp` 的主因 | 整对象覆盖（非并发） | **同意以整对象覆盖为主因**，我原先只看到并发竞态（较浅） |

除上述 5 点外，两份对 22 条的 CONFIRMED / PARTIAL / REFUTED 判定**逐条一致**——包括对 `vendor-write-symlink-bypass` 核心断言的推翻、对 `dns-rebinding` 影响面的收窄、对 `delete-session-resurrects` 归因错误的指认。

## A.1 评估者独立性声明

`--by zai` 是 22 条中 9 条的原作者。自评部分的处理：

- 所有 zai 条目的**代码层断言**都回源码逐行核对（含行号、注释原文、函数签名）；
- zai 条目的**实证强度**用独立手段重验（活实例 curl、磁盘计数、真实符号链接落盘）；
- 评级**不因作者相同而放宽或收紧**——下文 §A.4 列出的 zai 自身高估，照常记录；
- 排名部分把自评与他人评审分开陈述并明确标注。

**结论：代码事实层自评无偏；严重度校准层的偏差对 zai 与对另两家使用同一标准。** 事实上 zai 在本附录中被扣分最多的恰恰是自评条目（§A.4）。

## A.2 我被证伪的一条

### `session-inbox-sync-try-catch`（`--by claude`，README 列为「严重」）—— 我原判成立，**实为证伪**

我最初的核验只做了两件事：

1. 读 `InboxWakeHandler` 接口（`sessionInbox.ts:81-83`），确认它声明返回 `void`；
2. 读 `wakeIfBudgeted` 的同步 try/catch（`sessionInbox.ts:281-285`）。

据此我断言「实际注册的是 async 函数，try/catch 形同虚设，失败即崩溃」。

**我漏了第三步**——没有确认实际注册的 handler 是否已被消费：

```ts
// sessionInbox.ts:341-353
export function getSessionInbox(sessionId: string): SessionInbox {
  let inbox = sessionInboxes.get(sessionId)
  if (!inbox) {
    inbox = new SessionInbox()
    if (moduleWakeHandler) {
      const fn = moduleWakeHandler
      inbox.setWakeHandler((sid) => {
        fn(sid).catch((err) =>            // ← 这里已经消费了 rejection
          console.warn('[SessionInbox] wake runNextInQueue failed:', err),
        )
      })
    }
    ...
```

`SessionInbox` 类内默认 handler 是 `() => {}`（`sessionInbox.ts:102`，不可能 reject），唯一替换点就是上面这处，且已套 `.catch()`。**所有走热路径的 inbox promise 都不会 unhandled。**

讽刺之处在于：文档「修复」章节给出的代码 `this.wakeHandler(sessionId).catch(err => console.warn(...))`，**和 `getSessionInbox` 里早已上线的实现是同一个东西**——把已生效的防御当成了缺失。

我原先那句「类型签名在替 bug 遮掩」**仍然成立且是真发现**：`InboxWakeHandler` 声明返回 `void`，让 TypeScript 完全看不见这个 promise，这正是那段同步 try/catch 存在的心理原因。但它是**可维护性陷阱 / 死代码清理**，不是 P0。**同意上文的处理：删除该条。**

## A.3 逐条核验记录（评估者亲验部分）

以下为评估者**第一手**核验的 13 条，含实测原始输出。

### 活实例实测 —— CSRF → RCE 全链

```bash
# 无任何特殊 header 的 GET，node -e 执行成功
$ curl -s "http://127.0.0.1:9201/api/exec?cmd=node&args=-e,console.log(1337*7)"
data: {"type":"start","command":"node -e console.log(1337*7)"}
data: {"type":"stdout","line":"9359"}
data: {"type":"exit","code":0}          # HTTP 200

# 伪造 Host 头（DNS rebinding 模拟）——仍 200 且执行
$ curl -s -H "Host: attacker.example.com" \
    "http://127.0.0.1:9201/api/exec?cmd=node&args=-e,console.log(7*7)"
data: {"type":"stdout","line":"49"}     # HTTP 200

# 伪造 Origin ——同样 200 且执行
$ curl -s -H "Origin: https://evil.example.com" \
    "http://127.0.0.1:9201/api/exec?cmd=node&args=-e,console.log(7*7)"
data: {"type":"stdout","line":"49"}     # HTTP 200
```

响应**无** `Access-Control-Allow-Origin` → blind RCE，攻击者走自己的回传通道。

```bash
# 全服务树零 Host/Origin 校验
$ grep -rn "req.headers.host\|req.hostname\|req.headers.origin\|cors(\|helmet\|Access-Control" \
    packages/zai/src/server/
(零命中)
```

**机制核对**：`routes/exec.ts` 的 `ALLOWED_COMMANDS` 集合确实含 `npm` / `npx` / `node`；`router.post('/exec', runExec)` 与 `router.get('/exec', runExec)` 双绑，GET 变体从 query string 取值，是**功能完整的分支**（非残缺实现）。

### Express 4 async rejection 机制自展

```bash
$ node -e "require('/path/express') ... app.get('/boom', async () => { await Promise.reject(new Error('ENOENT')) }) ..."
# 错误中间件从未被调用；fetch 永不解析；进程直接退出
# 栈：at Layer.handle [as handle_request] (.../express/lib/router/layer.js:95:5)
#     at next (.../express/lib/router/route.js:149:13)
# Node.js v22.22.3
```

实测解析到的 express 版本：**4.22.1**（`package.json:53` 声明 `^4.21.2`）。全仓 `unhandledRejection` / `uncaughtException` **零注册**（唯一命中是 `agent.ts:1327` 的一句注释）。`index.ts:336` 的 catch-all error handler 存在且工作，但对 async 路径完全无效。

> 注：原始文档引用 `Node.js v25.6.0`，本机实际为 v22.22.3。机制结论不受影响（两者均 ≥22，`unhandledRejection` 默认 throw），但**证据出处对不上**。

### 对照组计数（async handler 那条的"模式已知"论证）

```
weixin.ts:       try={19}  routes={19}
instances.ts:    try={6}   routes={7}
agentSettings.ts:try={17}  routes={16}
superTasks.ts:   try={9}   routes={16}   ← 唯一缺口
```

`superTasks.ts:86` 甚至专门写了注释强调「此处 catch 为双保险，绝不阻塞/拖垮 3s 轮询」——**安全意识在这个文件里是有的，只差第 87 行**。

### `abortAll` 无 sessionId 过滤（三处，逐个核对）

```ts
// askRegistry.ts:74-79 / approveRegistry.ts:103-108 / permissionRegistry.ts:94-99
abortAll(reason = 'session_aborted'): void {
  for (const p of this.pending.values()) {   // ← 全局遍历，无 sessionId 判断
    this.pending.delete(p.toolUseId)
    p.reject(new Error(reason))
  }
}
```

调用点 `agent.ts:1980 / 1983 / 1986`，紧跟在 `:1974-1979` 那段「★ 不要 abort」注释之后——**注释识别出了正确语义，却只摘掉了一半**。

### settings tmp 冲突（我的核验，比上文浅一层）

`zaiSettingsStore.ts:85` 与 `fileStore.ts:70` 都是 `const tmpPath = \`${path}.tmp\``；`fileStore.ts:9-10` 的 `CONFIG_PATHS` 把 `zai` 与 `opencc` **双双**映射到 `join(homedir(), '.zai', 'settings.json')`，与 `zaiSettingsPath()` 一致。两个写者对同一目标文件用同一固定 tmp 名。

**但这是较浅的归因**——见 §A.0 分歧 5：上文的发现（`writeConfig` 整对象覆盖，完全绕过 `updateZaiSettings` 的 read-merge-write，**即使不并发**也会回滚设置抽屉期间的写入）比我说的竞态严重得多，竞态只是它的并发症状。**同意以整对象覆盖为主因。**

### ReplRegistry 泄漏

`dispose(sessionId)` 在 `ReplRegistry.ts:27`，全仓唯一调用点是测试 seam `__resetReplRegistryForTest`（`:44-48`）。`closeServer()`（`runtimeLifecycle.ts:60-143`）的回收链依次是 `shutdownInstanceSupervisor` → `shutdownBackgroundRuntime` → `weixinBot.stop` → `terminalService.disposeAll` → `agentRegistry.clear` → `stopSkillWatcher` → http server → vite → branchChecker，**确实没有 ReplRegistry**。

补充一点：`agentRuntime.ts:799-805` 注册了 `process.once('SIGTERM'/'SIGINT', cleanup)` → `runtime.shutdown()`，但那 dispose 的是 `ReplRuntime.sessions`（`agentRuntime.repl.ts:277-282`），**与 `ReplRegistry` 是两个 map**——文档第 30 行已正确区分。两条退出路径都扫不到 ReplRegistry。

### 微信锁文件累积（与文档数字精确一致）

```bash
$ ls ~/.zai/weixin/locks/ | wc -l
1740                 # ← 与文档声称完全一致
$ du -sh ~/.zai/weixin/locks/
0B
$ find ~/.zai/weixin/locks/ -maxdepth 1 -type f | wc -l
1738
```

这是我见到的**唯一一条数字断言可被逐位复现**的文档。

## A.4 质量最高的 5 条（zai 口径）

与上文的 §2 有一处排序分歧。**两份都把 `--lan` 零鉴权列为最高档**；分歧在于第 2-5 位。

### 1. CSRF → RCE（`--by zai`）—— 严重

活实例实测三项全通过（§A.3）。机制干净：GET 简单请求不发预检 + 白名单含 `node`/`npx`/`npm`（注释写着 "prevent arbitrary code execution"，但这三个词条本身就等于任意代码执行）+ 全树零 Host/Origin 校验。

**攻击链判断是全批最准的一句**：CSRF 走的是**用户的浏览器**，攻击者不需要能访问 `127.0.0.1`，用户的浏览器可以。监听地址与这条链完全无关。

修复面窄：删 `node`/`npx`/`npm`、删 GET 变体、或加 Host 白名单，任一即可。（上文进一步查实 GET 变体全仓无消费者、是死代码，可直接删——这一点我原先没查到。）

### 2. `--lan` 全 API 零鉴权 + 微信通道接管（`--by claude`）—— 严重

`lsof` 实测四个实例全绑 `0.0.0.0`（`*:9201` / `*:9199` / `*:9233` / `*:9988`）；`GET /api/system` 不带凭证直回 200。

`index.ts:66-70` 的注释逐字论证了移除 `tokenGuard` 的合理性（「对 localhost 加 token 没意义」），**这个论证成立但不覆盖 `--lan`**——`--lan` 恰恰是把攻击面从「本机用户」扩大到「整个局域网」的那个开关。

**情境辨析是全批最完整的**：指出 AGENTS.md 自己记载 lan-agent 需要配 `network_security_config.xml` 放行目标 IP，说明「LAN 上有其他不可信设备」这个场景**被项目自己识别到**，但服务端侧无对应防护；手机 App 通道把攻击面从「同网段偶然扫到」扩大到「任何能连该 Wi-Fi 的人」。

### 3. 未捕获 async handler 杀进程（`--by claude`）—— 严重（**分歧见 §A.0 #3**）

机制自展坐实 + 对照组论证（§A.3）。“模式已知、只是没铺开”这个推断由 `superTasks` 是唯一缺口直接支撑。

**我与上文的分歧**：我同意"用户点一下删除、3s 后轮询就带走整个 server"这个叙述被夸大（`existsSync → await readFile` 的窗口是每任务亚毫秒级，是窄 TOCTOU）。**但不同意因此降到"中高"**，理由：

- 这是一条**进程级**原语，不是单请求 500。命中即所有会话 / SSE / 在跑的 turn 全丢，爆炸半径与触发频率是两个维度；
- 同一份文档里 `setTaskFactoryState`（EACCES / ENOSPC / EROFS）和 `resources.ts:84` 的 `spawn('npx')`（ENOENT）**窗口宽得多**——ENOSPC 是一次调用就能稳定触发的，不需要精确插进某个 await 边界。这几条才是更现实的口子；
- 修复成本极低（一条进程级 `unhandledRejection` 兜底），收益与成本比不支持降级。

建议表述改为「严重（触发叙述需软化，但类必须修）」。

### 4. abort 用全局 sessionId 误杀其他 turn（`--by zai`）—— 中高

机制是全批**最干净**的一条，一个 header、一个函数签名、一个模块全局变量，三行说完：

- `agent.ts:2288-2302` 先按 header `x-session-id` 调 `abortSessionController(sid, ...)` 拿到了正确的 sid，随后**无条件**调 `abortAgentSession("user_abort")`；
- 后者签名 `agentRuntime.ts:920-951` **不接 sessionId**，函数体读模块级 `currentSessionId`（`:71`），并用它做三件事：`abortSessionController(currentSessionId)` / `cancelBackgroundTasksByParentSession(currentSessionId)` / `runtime.abort(currentSessionId)`。

**讽刺点**：前端 `useAgentStore.ts:1453` 主动塞这个 header，注释写明意图是「避免误杀其它正在跑的 turn」，而服务端的**第二**次调用把第一调用的精确度整个废掉。`agent.ts:2296-2299` 声称「重复调用不会引入副作用」——只在 `sid === currentSessionId` 时成立。

**我原先把它排第 4，上文排进了 8-9 分档。** 我维持较高评价：零事实错误 + 机制一行说清 + 直接对应用户可见症状（停止按钮误杀另一标签页）。

### 5. fsWrite.ts 非原子写导致用户数据丢失（`--by opencc`）—— 严重 / 中高（**分歧见 §A.0 #4**）

**机制**：`utils/fsWrite.ts:85` 的 `await writeFile(absPath, content, 'utf8')` —— Node 默认 flag `'w'` = `O_WRONLY|O_CREAT|O_TRUNC`，**fd 打开瞬间即截断为 0 字节**，内容才开始写。

**独特价值（全批唯一）**：接到了**真实历史事故**上。`services/instanceStore.ts:110-114` 的注释逐字记录了同款 bug——「这就是 2026-09-28 那次 `instances.json` 变成 0 字节的机制」。此后项目已修 `instanceStore` / `zaiSettingsStore` / `fileStore` / `WeixinPairingStore` / `ContextTokenStore` 五个写入点，唯独漏了直接写用户源码的 `fsWrite.ts`。

**我接受上文的严重度论证**：触发窗口是一次 ≤2MB 本地 `writeFile` 系统调用（亚毫秒级），能打中的只有 SIGKILL / 掉电 / ENOSPC。"不可逆数据丢失"作为**标签**成立，作为**严重度**偏高。

**但我主张留「中高」而非「中」**，理由：

- 用户主动保存源码的心智模型是"保存 = 已落盘"，截断窗口虽短但**后果是用户数据本身**；
- 上文自己查出的 `WeixinBotManager.ts:612`（`writeFile(path, ..., { mode: 0o600 })` 覆盖写微信 QR 凭据 + token，无 tmp+rename）——**这一条推翻了原文档"应用状态已全部改用 tmp+rename"的叙事本身**，也让修复范围扩大；
- 落地成本接近零：直接抄 `instanceStore.ts:115` 的 `${path}.${process.pid}.tmp` + rename 模式。

## A.5 发现者能力排名（zai 口径，与上文分歧）

上文的排名口径是**单一维度：断言准确率**。我用的是**两维度**，因为把三个维度压成一个分数会掩盖差异的来源。

| 维度 | 含义 | 第一 | 第二 | 第三 |
|------|------|------|------|------|
| 代码事实精确度 | 行号 / 注释 / 行为描述 | 三家并列（都很高） | — | — |
| **实证纪律** | 活测 / 磁盘计数 / 机制自展 / 主动封自检反例 | claude | zai | opencc |
| **严重度校准** | 影响面是否与实际范围匹配 | opencc ≈ claude | zai | — |

**这个拆解解释了两家排名分歧的来源**：上文的口径把"准确率"和"校准"合成一项，于是 `opencc` 的 4 条零实质错误（3/4 完全确认）拿到了最高分；我的口径认为 `opencc` 缺实证是**方法论层面的短板**（"实证"段落是描述性复现步骤而非捕获到的输出），应当扣分，而 `claude` 那种"对自己反驳也跑实验封口"的做法是三家里唯一达到可验证纪律的。

### 第一 —— `--by claude`

- **唯一主动封自检反例的审计者**：对自己反驳 `vendor symlink bypass` 严重度的结论，专门落盘真实符号链接、驱动 vendor 权限模块跑四种链接形态（绝对 / 相对 / 多跳链 / 悬空）才肯下结论；
- **对照组论证**（`superTasks` 是唯一缺口）证明"模式已知"而非"作者不知道"；
- **诚实 scoping**：多处明确区分"源码逐行确认"与"实测"；
- **诚实的自我否定**：`bashRepl.ts` 心跳那条明确写"已排除的关联怀疑"，并说明用什么手段排除的。

**弱点**：9 条里 1 条彻底证伪（session-inbox，正是我踩的同一个坑）、1 条复现链按字面走不成立、1 条影响分析被代码注释直接点名反驳。三处失误**集中在同一环节**：「这行代码实际会被谁调用、失败会传播到哪里」。

### 第二 —— `--by zai`（自评）

- **实证强度最高**：curl 往返、Express 语义探针、mock long-poll 写失败用例、磁盘计数——`1740` 能被我独立逐位复现；
- **代码事实精确度极高**，行号与注释几乎逐字命中；
- **0 条被完全证伪**；abort 全局 sid 那条零错误且机制一行说清。

**弱点（成模式，非偶发）**：9 条里至少 4 条把存在的缺陷表述为比实际更大的影响——DNS rebinding 的读取范围、符号链接直接删除、abort 机制把条件路径当必然、delete resurrect 的 wake 条件。上文追加的两条材料级错误（编造的端点名 `/api/fs/file/preview`、被扩展名白名单挡下的 PoC）我原先**没有发现**。

**这正是本附录要自陈的**：自评者的偏差是**系统性放大**，而非随机噪声。

### 第三 —— `--by opencc`

- **历史/情境上下文最强**：`fsWrite` 那条连到 2026-09-28 真实事故与项目内已修的五个写入点——**全批唯一一条把缺陷与项目自身经历挂钩的**，修起来就是复用现成模式；
- **严重度校准最克制**（除 fsWrite 那条的"不可逆"标签外）；
- 3/4 零行号漂移，零实质事实错误。

**弱点**：
- **缺乏活实例实证**——"实证"段落是描述性复现步骤，不是捕获到的输出；
- **覆盖面最小**（4 条 vs 另两家各 9 条），样本代表性弱，排名置信度低。

### 三家共同的失效模式

**把观察到的现象推成机制的那一步。** 三个具体形状：

- **过度概括** —— claude 说"绕过整个权限系统"（实为 confused-deputy）；
- **归因到错误的函数** —— zai 说 `appendEntry` 重建文件（实为 vendor `sessionStorage` 的写入器，且 `store.append` 恰恰是空实现）；
- **引用了自证的白名单** —— zai 声称可读 `~/.ssh/id_rsa`，而同一份文档引用的扩展名白名单正好把它排除。

代码长什么样几乎不失手，**链路回溯到"谁真的写盘 / 谁真的被检查"这一层才失手**。这是三份评估都指向同一条的结论。

## A.6 对上文的三点补充

1. **`aborted` vs `close` 的正确判别**（同意并强化上文的修复建议）：`req.on('aborted')` 在 Node 17+ 已废弃且只在提前中断触发；正确做法是 `res.on('close')` 里判 `res.writableFinished`。
2. **Chrome LNA/PNA 是唯一削弱 CSRF 实际可利用性的因素**（补充上文 §4.7）：Chrome 对"公网页面 → 环回地址"子资源有 gating，Firefox / Safari 无此机制。因此 CSRF 的实际可利用性**依浏览器而异**，修复理由应写成"无浏览器全覆盖"而非"所有浏览器均可"。
3. **服务端已不读 `X-Zai-Token`**（确认上文的补充）：`pushAction.ts` / `childEvent.ts` 仍在发这个头，容易让读者误以为存在 token 防线。建议在修复时一并清理或明确注释其仅用于子实例出站自证。

---

*本附录由 zai 评估生成。评估者同时是 `--by zai` 9 条的原作者，自评部分的处理方式见 §A.1；其中 `session-inbox-sync-try-catch` 一条为评估者初判错误、被上文证伪，已在 §A.2 完整记录。所有"实测"均为只读探测（无服务状态变更、无文件修改），活实例测试使用无害载荷 `console.log(1337*7)`。行号以 HEAD `da6a49b6` 为准。*
