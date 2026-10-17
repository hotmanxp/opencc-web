# 交叉评审报告 · opencc

**评审者**：`opencc`
**日期**：2026-10-17
**评审对象**：`bug-hunt-claude.md`(3 条:`cl-001` / `cl-002` / `cl-003`)
**基准提交**：`31fca1d2`(与 README §1 一致,评审全程未做任何 git 写操作)

---

## 一、评审原则自查

- [x] 我对**每一处**被引用的 `file:line` 都实际 `Read` 过,确认行号所指内容与作者描述一致 —— 逐条结果见第二节「我核到的位置」。**其中 4 处行号有偏差**,我在各条下逐条标出,没有替作者掩盖。
- [x] 我的每条裁决都给出了**源码上的理由**
- [x] 我没有因为「这不可能」就 `REJECTED` —— 本次评审**没有一条 REJECTED**
- [x] 我检查了对方**每一条 E1 的前置可达性三问** —— cl-003 是唯一 E1 条目,三问**答完**,见 §2.3
- [x] 我完成了 **4 条亲手抽验**(要求 ≥3),见第四节
- [x] 我在「评审中额外发现」抓到 **1 条新缺陷**(`oc-r1`),见 §5.1
- [x] 我在「交叉洞察」给出 **1 条**对已有缺陷的补充验证(`oc-r2`),见 §5.2
- [x] 本次没有判任何条目为 `KNOWN`,故无需核对 §3.4 清单行号

**取证环境**(与 README §3.3 一致)

```
Node v22.22.3 · 平台 darwin-arm64 · pnpm workspace
```

- **端口**:我没有启动任何服务,没有绑定任何端口,没有 `kill`。9201 未被触碰。§3.1 建议的隔离实例(8101/7715)**未启动** —— 本次全部证据都是模块级 `tsx` 脚本,不需要起服务。
- **数据隔离**:我的三个复现脚本全部在 shell 层显式设置 `ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home/...`,脚本头部各自注明(README §2 铁律 10)。落盘产物全在 `/tmp/bughunt-opencc/zai-home/` 下,**用户真实 `~/.zai/` 未被读或写**。
- **没有跑全量测试**(铁律 7),没有跑任何 vitest。
- **工作树**:我只写入了本文件 `docs/bugs/bug-hunt-game-10-17/hunt-review-opencc.md`,临时脚本全在 `/tmp/bughunt-opencc/`。未执行任何 git 写操作。
- **未阅读** `docs/bugs/bug-hunt-game-10-16/` 下任何 `bug-hunt-*.md` 与 `hunt-review-*.md`(本场规则要求我评审的是 claude 的报告,上一届报告不在范围内)。

---

## 二、逐条裁决

### `cl-001` — `updateCachedVersion` 覆盖掉 `extractedVersions`,LRU 清理永久失效,解压产物无上限泄漏

- **裁决**:`CONFIRMED`

- **我核到的位置**:

  | 作者引用 | 我读到的实际内容 | 一致? |
  |---|---|---|
  | `manifest.ts:106` | `manifest.packages[pkg] = {` / `latestVersion,` / `cachedAt: Date.now(),` —— **整体替换,无 `...existing` 展开** | ✅ 精确 |
  | `manifest.ts:132`(`recordExtraction` 写点) | `:132` 是 `manifest.packages[pkg] = {`,`:133` 是 `...existing,`,`:134` 是 `extractedVersions: list` | ✅(作者把 132-135 压成一行描述) |
  | `manifest.ts:156`(`pruneExtractions` 写点) | `manifest.packages[pkg] = { ...entry, extractedVersions: kept };` —— 逐字一致 | ✅ 精确 |
  | `manifest.ts:149`(早返回) | `if (!entry?.extractedVersions?.length) return [];` —— 逐字一致 | ✅ 精确 |
  | `manifest.ts:64-71`(`readManifest` 裸 catch) | `:64` 函数起,`:68-70` `catch { return { version, updatedAt: 0, packages: {} } }` | ✅ |
  | `manifest.ts:37`(`extractedVersions?` 可选字段) | ❌ **行号错**。`:37` 是 `/** 缓存时间戳 (Unix ms) */`,可选字段 `extractedVersions?: ExtractionEntry[]` 在 **`:42`** | ⚠️ 偏差 |
  | `extractor.ts:138-142` | `:138` `await recordExtraction(PLUGIN_PKG, entry);` · `:139` `updateCachedVersion(PLUGIN_PKG, version).catch(() => {});` · `:142` `const dropped = await pruneExtractions(PLUGIN_PKG, 3);` —— **逐字一致,含 keep=3** | ✅ 精确 |
  | `extractor.ts:143-145` | `for (const d of dropped) { await rm(d.path, ...) }` —— 确实存在,且 `dropped` 恒空时一次都不执行 | ✅ |
  | `extractor.ts:430`(`pruneExtractions` 第二调用点) | `cleanupOldExtractions(keep = 3)` 内 `const dropped = await pruneExtractions(PLUGIN_PKG, keep);` —— 存在 | ✅ |
  | `detect.ts:268` | `updateCachedVersion(pkg, version).catch(() => {});` —— 存在,同样是 fire-and-forget | ✅ 精确 |

- **理由**:缺陷点在源码上完全成立,而且**比作者写的更普遍**。我核到 `updateCachedVersion` 有 **2 个生产调用点**,不止作者点出的 `extractor.ts:139`:`extractor.ts:139`(插件安装/升级)与 `detect.ts:268`(任意 `npm view` 之后的版本缓存落盘)。作者在 §影响 里写「`detect.ts:268` 依赖 `latestVersion` 的版本判断虽仍可用」—— 这句是对的,但它低估了危害的**触发面**:`detect.ts:268` 每跑一次 `npm view` 都会执行同一个整体替换,所以**任何一次版本查询都会抹掉解压索引**,不需要等到下一次插件升级。

  更进一步:`extractor.ts:429-435` 的 `cleanupOldExtractions()`(手动清理入口)调用的是**同一个** `pruneExtractions`,因此**手动清理路径同样永久失效**——用户手动清也清不掉。这两点作者都没写。

  同一模块三个写点两种写法(两个带展开、一个不带)属实,`ManifestEntry.extractedVersions` 是可选字段(`:42`),所以少写一个 key 对 TS 完全合法 —— 作者「与 typecheck 基线无差集」的判断我也核过,成立。

- **前置可达性三问的核查**:三问**全部答完**,且质量高于及格线。
  - ①列了 2 个写入点 + 2 个删除点 + 4 个调用点,并给出 grep 命中行号;
  - ②明确回答「不需要任何非默认开关」,并点名 `extractor.ts:138-142` 是普通用户装任何插件都走的 Stage 4/5;
  - ③把「没有字段级合并」「`pruneExtractions` 的早返回是症状不是防护」「`.catch(()=>{})` 吞异常但本条不抛错」逐条拆开,并且明确指出本条**根本不抛错**,所以没有任何错误信号。
  
  这三条问不是套话,尤其是 ③ 里「早返回是症状不是防护」这句,是我见过的对这条最准确的表述。**无缺失,不需要按 §6.2 压到 S4。**

- **严重度**:维持 **S3**(与作者一致,理由:无上限磁盘增长 / 边界退化,无数据损坏、无安全影响、无凭据泄露)。

- **我的一处不同意见(不改变裁决)**:作者 §对照组 写「两个复现物跑在**两个独立 Node 进程**里(两次单独 `tsx` 调用),各自有独立的 `manifest.json`」。我读了 `/tmp/bughunt-claude/repro-manifest.mts`,**实验组与对照组在同一进程、同一份 `manifest.json` 上顺序执行**——对照组的第一次 `recordExtraction` 的 `existing` 就是实验组留下的残缺 entry。这与作者对自己执行方式的描述不符。

  但我**追踪过**这个残留是否有区分力:实验组跑完后 `extractedVersions` 已是 `undefined`,而 `recordExtraction` 的 `existing.extractedVersions ?? []`(`:126`)正好把它兜成空数组,所以对照组起点等价于全新 manifest,**结论不受影响**。而且该模块无模块级缓存(每个函数各自 `readManifest`/`writeManifest`),不存在 §3.2 第 6 条的单例污染。这属于**方法学表述过头**,不是事实性错误,不构成 `PARTIAL`。

---

### `cl-002` — `OfflineBuffer.setPort()` 零调用,per-child outbox 隔离从未发生

- **裁决**:`PARTIAL` —— **机制与根因完全成立,但作者自报的 S2 站不住,应为 S3**

- **我核到的位置**:

  | 作者引用 | 我读到的实际内容 | 一致? |
  |---|---|---|
  | `offlineBuffer.ts:69-71` | `setPort(port: number): void {` / `this.port = port;` / `}` —— 逐字一致 | ✅ 精确 |
  | `offlineBuffer.ts:14-16`(头部注释承诺 per-port 隔离) | `:14-15` `Per-port scoping: each child has its own outbox so a backlog from one noisy child doesn't head-of-line-block another.` | ✅ |
  | `offlineBuffer.ts:61-63`(构造函数) | ❌ **行号错**。`:61` 是 `serialize` 的收尾 `}`,`:62-63` 是空行;构造函数在 **`:64-67`** | ⚠️ 偏差 |
  | `offlineBuffer.ts:17-19`(size cap / FIFO trim) | `:17-19` `Size cap: ZAI_AA_OUTBOX_MAX_MB (default 50MB) per port. When exceeded, the oldest entries are dropped (FIFO trim) — better than failing altogether.` | ✅ |
  | `offlineBuffer.ts:32-33`(生产默认 50MB) | `:32` `DEFAULT_MAX_BYTES = 50*1024*1024` · `:33` `MAX_BYTES = Number(process.env.ZAI_AA_OUTBOX_MAX_MB ?? 50) * 1024*1024` | ✅ |
  | `offlineBuffer.ts:226-238`(模块单例) | `:226` `let singleton` · `:228-233` `initOfflineBuffer` · `:239-242` `resetOfflineBufferForTests` | ✅ |
  | `init.ts:170-172` | `:168-171` 注释 `Each runtime_registry registration updates the active port to the most-recently-running child` · `:172` `const buffer = initOfflineBuffer(conn, 0);` —— 逐字一致 | ✅ 精确 |
  | `init.ts:85` | `if (!isAaEnabled()) return null;` —— 逐字一致 | ✅ |
  | `server/index.ts:173` | `.then((m) => m.initAaClient())` | ✅ |
  | `connection.ts:286 / 303` | `void this.queueOffline(method, params);` 两处 | ✅ |
  | `connection.ts:307-311` | `queueOffline` 定义 + `import('./offlineBuffer.js')` + `getOfflineBuffer()` + `await buffer?.enqueue(...)` | ✅ |

- **理由(根因部分成立)**:`setPort` **生产调用点 = 0**,我独立跑过作者的 grep 并逐条看了 7 处命中 —— `offlineBuffer.ts:69` 是定义本身,其余 6 处(`web/src/pages/Instances.tsx:160,354,628,802,816,817`)是 React 的 `setPortEditRow` / 局部 `setPort(id, port)`,与 OfflineBuffer 无关。`init.ts:172` 传常量 0 且无后续代码会改。**这条不是编造,是真缺陷。**

  我还核到一件作者没写的事:**同一份「per-port 会自动跟随」的错误承诺在代码里有三处**,不是一处。除 `offlineBuffer.ts:14-15` 与 `init.ts:168-171` 外,`connection.ts:281-285` 的注释写着「passing 0 here means *let the buffer pick a representative port based on the most recent runtime registration*」—— 而 `queueOffline` 的签名里**根本没有 port 参数**,连「传 0」这个动作都不存在。三处注释共同把一个未实现的机制写成既成事实,这比作者描述的更值得修。

- **理由(为什么我判 PARTIAL 而非 CONFIRMED)**:作者把危害论证建立在「一个子实例的洪水驱逐另一个子实例的欠账」上,而这个论证**只在 `ZAI_AA_OUTBOX_MAX_MB=1` 时成立**。作者自己在三问 ② 里如实写了「需要非默认开关 `--aa`」,这点诚实;但**没有披露另外三个叠加前置**,也没有回答「生产默认 50MB 下要攒多少条才可能触发」。

  我实测了这个数字(见抽验 3)。用**真实** `OfflineBuffer.enqueue` + 真实 payload 形态量出:

  | 通知类别 | 实测字节/条 | **50MB 可容纳条数** |
  |---|---:|---:|
  | `session.state.updated`(小) | 171 B | ~305,805 |
  | `notice.upserted`(中) | 319 B | ~164,124 |
  | `timeline.itemUpsert`(流式文本 delta) | 1,733 B | **~30,245** |

  即使取最重的一类,也需要**约 3 万条**未投递通知才会触发第一次跨子实例驱逐。跨子实例驱逐还额外要求:①`ZAI_AA_ENABLED=1`(`index.ts:45-46` 实测是 `=== '1'`,纯 opt-in);②**已完成 pairing**(否则 `init.ts:119-126` 在 `readAaConfig()` 返回 null 时直接 return,OfflineBuffer 根本不会被创建);③**同时有 ≥2 个子实例在 enqueue**;④单个子实例在断线窗口内累计上述量级。

  作者的复现物用 1MB 上限 + 合成条目,把第 ④ 条的门槛压到了生产默认的 **1/50**。机制证明有效,但**危害量级被放大了 50 倍**。

  关于「`offlineBuffer.ts:17-19` 把 FIFO 截断写成被认可的设计」这一点,我的判断与「所以降级」相反,理由要说清:**FIFO trim 本身不是缺陷**(注释白纸黑字承认「better than failing altogether」,这是有界降级而非数据损坏);**真正的缺陷是缺失的那个 per-child 作用域**——因为 `:14-15` 那句注释恰恰说明了 trim 的爆炸半径**本应**被 per-child 文件切开,「一个吵闹子实例不 head-of-line-block 另一个」就是作者自己在注释里写的 trim 前提。所以注释不是免责证据,它是**作者主张的意图的证据**。这一点作者的论证是对的,我认同。

  但它推不出 S2。§4.3 的 S2 判据是「事件丢失 / 跨实例状态污染」这类**会实际发生**的损失。丢失通道存在,但需要 3 万条级的积压 + 三个额外前置,**默认配置下不可达**。按 §4.3 的 S3「边界条件算错 / 轻微泄漏」与 S4「有风险但当前不可触发或影响极小」之间,本条是:**机制真、影响真、但当前不可触发**——更贴 S3(因为它同时是一个已写明的契约未兑现,不只是空转),而非作者主张的 S2。

- **前置可达性三问的核查**:三问**答完**,且 ①③ 质量很高(①把 port 的两个赋值点 + grep 全量命中列全,③把「隔离机制存在但从未被调用」「两边都用同一个 0 所以内部自洽不报错」「`2a9e31d6` 的 io 互斥只防实例内」逐条拆开)。

  **但 ② 答得不够完**:作者只写了「需要 `--aa`」一个前置,漏了 pairing 未完成(`init.ts:119-126` 早退)、多子实例共存、以及 50MB 积压量级这三层。**这三层缺失正是 S2 站不住的原因**,所以这一条我给 `PARTIAL` 而不是 `CONFIRMED`。

- **修正后的严重度**:`S2` → **`S3`**。作者应把标题改写为「per-child outbox 隔离从未实现,一个子实例的 outbox 洪水可驱逐其它子实例的未投递通知 —— 但生产默认 50MB 上限下需约 3 万条积压,且需 `--aa` + 已 pairing + 多子实例」。

- **修正后的证据等级**:作者标 E3a —— 但严格说,两个复现物证明的是**机制**(共享文件 / FIFO 按文件位置丢),而「危害」部分是靠降低 `ZAI_AA_OUTBOX_MAX_MB` 制造出来的。若把 `ZAI_AA_OUTBOX_MAX_MB=1` 去掉,复现物 B 在生产默认下跑不出驱逐。按 §4.2「E3a 要求断言可观测结果」,机制部分够 E3a;危害部分只到 **E2**。综合仍按 E3a 起步,但作者不应把它当成 S2 的支撑。

---

### `cl-003` — `d66d09f5` 只迁了 `settings.json`,另三个解析器仍硬写 `homedir()/.zai`

- **裁决**:`CONFIRMED`(严重度维持 S3,证据等级维持 E1)

- **我核到的位置**:

  | 作者引用 | 我读到的实际内容 | 一致? |
  |---|---|---|
  | `compat/permissions.ts:81` | `export function getDefaultMode(): UserFacingPermissionMode {` | ✅ 精确 |
  | `compat/permissions.ts:83` | `const path = join(homedir(), '.zai', 'settings.json')` —— **无 env 感知**,与描述逐字一致 | ✅ 精确 |
  | `compat/permissions.ts:95-99`(catch 体为空) | `:96` `if (!(err instanceof SyntaxError) && ... !== 'ENOENT') {` · `:97` `// Real IO error — fall through to default.` · `:98` `}` —— **if 块内只有一行注释**。作者「函数体是空的」描述属实 | ✅ |
  | `userLoader.ts:26` | `const zaiDir = opts.dataDir ? join(opts.dataDir, '.zai', 'commands') : join(home, '.zai', 'commands')` | ✅ 精确 |
  | `userLoader.ts:27`(`homeClaudeDir`) | ❌ **行号错**。`homeClaudeDir` 在 **`:28`** | ⚠️ 偏差 |
  | `userLoader.ts:39-40` | `if (existsSync(zaiDir)) dirs.push(zaiDir)` / `else if (existsSync(homeClaudeDir)) dirs.push(homeClaudeDir)` | ✅ 精确 |
  | `userLoader.ts:33-34`(cwdClaude/cwdZai 同串) | 两行都是 `join(opts.cwd, '.zai', 'commands')` —— 确实是同一个字符串 | ✅ |
  | `ReplHistoryService.ts:51`(构造函数一次性捕获) | `this.historyPath = opts.historyPath ?? defaultHistoryPath()` | ✅ 精确 |
  | `ReplHistoryService.ts:82` | `await appendFile(this.historyPath, line, 'utf-8')` | ✅ 精确 |
  | `ReplHistoryService.ts:152-155`(rotate) | `private async rotate()` / `const rotated = \`${this.historyPath}.1\`` / `await rename(this.historyPath, rotated)` | ✅ 精确 |
  | `ReplHistoryService.ts:162-164` | `function defaultHistoryPath(): string {` / `return \`${homedir()}/.zai/repl-history.jsonl\`` —— 模板串写法属实,绕开了 `join(homedir(), '.zai'` 的 grep 特征 | ✅ 精确 |
  | `commands/fileStore.ts:11`(writer) | `return join(resolveZaiDir(), 'commands');` —— **已迁移** | ✅ 精确 |
  | `paths.ts:45-47` | `export function resolveZaiDir(): string { return process.env.ZAI_DATA_DIR || join(homedir(), '.zai'); }` | ✅ 精确 |
  | `test/setup.isolation.ts:19-20` | `if (!process.env.ZAI_DATA_DIR \|\| ...) process.env.ZAI_DATA_DIR = mkdtempSync(...)` —— **每次 zai 测试全局设置**属实 | ✅ 精确 |
  | `routes/agent.ts:2209` | `permissionMode: getDefaultMode(),` | ✅ 精确 |
  | `permissionMode.ts:11` | `export { getDefaultMode, type UserFacingPermissionMode } from '@zn-ai/zn-agent-core'` —— re-export 链属实 | ✅ 精确 |
  | `routes/bashRepl.ts:29` | `router.post('/bash/repl/:sessionId/exec', ...)` | ✅ |
  | `ReplSession.ts:182` | `this.historyService.appendCommand(command, sessionId)` | ✅ 精确 |

- **理由**:三处硬编码全部核实,作者最有价值的一处论证 —— **writer/reader 分裂** —— 我独立确认成立且成立得很干净:

  - **写**:`commands/fileStore.ts:11` → `join(resolveZaiDir(), 'commands')` = `$ZAI_DATA_DIR/commands`
  - **读**:`userLoader.ts:26` → `join(opts.dataDir, '.zai', 'commands')` = `$ZAI_DATA_DIR/.zai/commands`

  两者**路径字面不同**(`commands` vs `.zai/commands`),所以设了 `ZAI_DATA_DIR` 的实例写入的命令自己读不到,还会静默回落到真实 `~/.zai/commands`(`:39-40`)。作者对这条的因果描述准确。

  另两处同样核实无误:`compat/permissions.ts:83` 读真实 home 的 `settings.json`(而 `zaiSettingsCache` 写的是隔离目录的,于是 `GET /api/agent/settings` 与 `getDefaultMode()` 会互相矛盾);`ReplHistoryService` 从 `:51` 起把路径一次性冻结,`:82` append + `:152-155` rotate **写入**用户真实 home。

- **对作者「E1 且需要 ZAI_DATA_DIR」诚实度的专项核查**(这是本轮我最在意的一条):

  **作者是诚实的,而且诚实得超出及格线。** 依据有三:①三问②开门见山写「缺陷需要非默认 env `ZAI_DATA_DIR`,必须写明」;②紧接着区分「默认配置下三处行为正确,不是 bug」与「设了 `ZAI_DATA_DIR` 时隔离失效」,并自我定性为「`d66d09f5` 迁移不完整」而非「默认路径错误」;③严重度栏里**主动写**「若裁判认为仅因需要 `ZAI_DATA_DIR` 即应降档,我接受」,并在「不可触发自证」栏重申一次。

  我特别去核了 §2 铁律 10 点名的那个「设了 `ZAI_DATA_DIR` 仍读写真实 `~/.zai`」的历史坑,结论对作者有利:本条的三处**正是**那个坑的残留形态,而且作者没有借「我这里是读不是写」来弱化 —— (c) 是**写**(append + rename 覆盖 `.1`),作者把它列为三者中最实质的,这个排序是对的。

- **前置可达性三问的核查**:三问**全部答完**,每问都带 file:line 与 grep 证据。①枚举三个构造点并指出模板串变体绕开了 grep 特征(我核实属实);②明确写出前置条件与默认配置下的正确性;③把 `resolveZaiDir` 未被采用、`existsSync` 只判存在性不判归属、catch 体为空三道防线逐条说明为什么挡不住,还给出 `compat/taskListStore.ts:300` 作为「同理由已迁过」的内部对照 —— 这是很扎实的论证。**无缺失,不触发 §6.2 的 S4 降档条款。**

- **我的一处纠正(不影响裁决)**:作者 §触发路径 (b) 写「`routes/commands.ts:8` / `routes/command.ts:79` / `agentRuntime.ts:871,891` 调 `defaultCommandsDirs({ dataDir: process.env.ZAI_DATA_DIR ?? '' })`」。我全仓 grep `defaultCommandsDirs`,命中只有两处,**都在 `userLoader.ts` 自身**(`:23` 定义、`:162` `loadUserCommands` 内部调用)。`routes/commands.ts` 调的是 `reloadUserCommands`(`:4` import、`:9` 调用),它把 `dataDir` 透传给 `loadUserCommands`,再由 `:162` 调 `defaultCommandsDirs`。

  即:**因果链仍然成立**(三跳可达,我逐跳核过),但作者**把调用点写成了这些路由直接调用 `defaultCommandsDirs`,这是错的**。这类错误不影响结论,却是「E1 的最后一步精度」问题,值得指出。

- **严重度**:维持 **S3**。理由:默认配置下完全正确;危害需 `ZAI_DATA_DIR`;其中 (c) 触及用户真实 home 的写;(a)/(b) 是读 + 隔离失效。不到 S2(没有默认可达的越权或错误结果返回),也不该到 S4(在测试套件里是**每次运行都发生**的,`setup.isolation.ts:19-20` 全局设了该 env,所以它不是「不可触发」,而是「非默认部署形态下触发」—— 这正是 S3 的位置)。

---

## 三、裁决统计

| 对方条目 | 我的裁决 | 作者自报严重度 | 我判的严重度 | 与裁判终裁是否一致(裁判填) |
|---|---|---|---|---|
| `cl-001` | `CONFIRMED` | S3 / E3a | S3 | |
| `cl-002` | `PARTIAL` | **S2** / E3a | **S3** | |
| `cl-003` | `CONFIRMED` | S3 / E1 | S3 | |

3 条全部有源码依据,**0 条 REJECTED**。3 条都不在 §3.4 的已知清单里(我核过行号与清单内容,无同源),故无 `KNOWN` / `DUPLICATE`。

---

## 四、抽验记录(硬性,做了 4 条)

> 优先证伪最重的那条。cl-002 是作者唯一主张 S2 的条目,也是唯一自报严重度偏高的条目,所以我把**最多的独立工作量**放在它身上。

### 抽验 1:`cl-001`(作者 S3 / E3a)—— 自建复现物,不复用对手脚本

- **我的动作**:写 `/tmp/bughunt-opencc/oc-rev-cl001.mts`,按绝对路径 `import` **生产源码** `packages/zai/src/server/services/manifest.ts`(不是 `dist/`,§3.2 第 3 条的坑因此规避),重放 `extractor.ts:132-145` 的生产序列。跑了 **3 组**,每组一个独立 manifest(利用 `resolveZaiDir()` 每次调用重读 env 的性质,中途改 `process.env.ZAI_DATA_DIR` 即可完全隔离)。

  命令:
  ```bash
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home/boot \
    pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-opencc/oc-rev-cl001.mts
  ```

- **我看到的**(真实输出,5 个版本、keep=3、期望丢 2):
  ```
  === exp-awaited (withUpdate=true, awaited=true) ===
      after 1.0.0: extractedVersions=undefined  <-- FIELD GONE  prune dropped 0
      ... (5 次全同)
    TOTAL dropped by pruneExtractions over 5 upgrades = 0 []
    >>> expected drop with keep=3 over 5 versions = 2

  === exp-fireforget (withUpdate=true, awaited=false) ===
      ... 与上完全相同 ...
    TOTAL dropped = 0 []

  === control-no-update (withUpdate=false) ===
      after 1.0.0: extractedVersions=[1.0.0]     prune dropped 0
      after 1.2.0: extractedVersions=[1.0.0,1.1.0,1.2.0]  prune dropped 0
      after 1.3.0: extractedVersions=[1.1.0,1.2.0,1.3.0]  prune dropped 1
      after 1.4.0: extractedVersions=[1.2.0,1.3.0,1.4.0]  prune dropped 1
    TOTAL dropped = 2 ["1.0.0","1.1.0"]

  >>> control has discriminating power: YES (outputs differ)
  ```

- **与作者结论是否一致**:**一致**,且我补上了对手没做的第三个实验组。`extractor.ts:139` 在生产里是 **fire-and-forget(不 await)** 的,对手的复现物把它 await 了(并在注释里说这是「worst case so it's a lower bound」)。我专门加跑了一组**保持 fire-and-forget 语义**的版本(每次让出 5ms 让那次写落盘),结果是**竞态不会救回这个字段** —— 0 次 drop,与 await 版逐字相同。所以「await 是最坏情况所以是下界」这个说法是对的,但作者没有实测,而我实测确认了。**对照组有区分力(0 vs 2)。**

- **最终裁决**:`CONFIRMED`

### 抽验 2:`cl-002`(作者 **S2** / E3a)—— 优先证伪最重的那条

- **我的动作**:分三步。
  1. **独立复核零调用**:跑 `setPort` 全仓 grep,逐条读 7 处命中 → 确认 `offlineBuffer.ts:69` 是定义、其余 6 处是 `Instances.tsx` 的 React 局部变量。**零调用属实**。
  2. **核对作者是否伪造证据**:读 `/tmp/bughunt-claude/repro-offline-port.mts` 与 `repro-manifest.mts`。前者是否 import 真实生产模块 —— 我逐行看过,是按绝对路径 import `src/server/services/aaClient/offlineBuffer.ts`,**没有自造 `new Map()` 之类的替身**(§4.2 警告的假证据形态在本报告里**不存在**)。这一点我确认作者是干净的。
  3. **度量生产默认门槛**(对手完全没做):写 `/tmp/bughunt-opencc/oc-rev-cl002.mts`,用**真实** `OfflineBuffer.enqueue` + 从 `rpc.ts` / `eventAdapter.ts` 取的真实 payload 形态,量出每条字节数再线性外推到 50MB。

  命令:
  ```bash
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home/probe \
    pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-opencc/oc-rev-cl002.mts
  ```

- **我看到的**:
  ```
  N = 2000 enqueues per class, real OfflineBuffer.enqueue from src/
  outbox cap MB actually in force = (unset -> default 50)

    session.state.updated (small)                   171 B/entry  => 50MB holds ~305,805 entries
    notice.upserted (medium)                        319 B/entry  => 50MB holds ~164,124 entries
    timeline.itemUpsert (streaming text delta)     1733 B/entry  => 50MB holds ~30,245 entries
  ```

- **与作者结论是否一致**:**根因一致,严重度不一致。**
  - 一致的部分:`setPort` 零调用、`init.ts:172` 恒传 0、三处注释共同承诺了一个不存在的机制 —— 全部核实为真。
  - 不一致的部分:作者的危害输出 `entries owned by 9101 = 0 / >>> EVICTED` 是在 `ZAI_AA_OUTBOX_MAX_MB=1` 下取得的。生产默认是 **50MB**(`offlineBuffer.ts:33` 的 `?? 50`),实测最重的真实通知类别也要 **~30,245 条**才填满。作者用一个 1/50 的上限,把「需要极端积压」论证成了「必然驱逐」。
  - 作者未披露的另外三个前置:`ZAI_AA_ENABLED === '1'`(`aaClient/index.ts:45-46`,纯 opt-in)、**必须已完成 pairing**(否则 `init.ts:119-126` 在 `readAaConfig()` 返回 null 时早退,OfflineBuffer 根本不会被创建)、**≥2 个子实例同时 enqueue**。
  - 我**不同意**「因为 FIFO 截断被注释认可就该降级」这个推论:注释 `:17-19` 认可的是「有界降级」这个取舍,不认可「无差别跨子实例驱逐」——而 `:14-15` 恰恰写着 per-child 拆分就是为了让 trim 不波及别人。注释是作者主张的**意图**的证据,不是免责证据。

- **最终裁决**:`PARTIAL`(S2 → S3)

### 抽验 3:`cl-003`(作者 S3 / E1)—— 逐行核 + 追一处作者引错的调用链

- **我的动作**:读了 §2 表格里 17 处引用对应的全部源码(每个文件我都打开到具体行),并**追了作者引错的调用链**。

- **我看到的**:
  - 三处硬编码全部属实,行号精确(两处偏差除外,见 §2.3)。
  - **writer/reader 分裂独立确认成立**:`fileStore.ts:11` = `$ZAI_DATA_DIR/commands` vs `userLoader.ts:26` = `$ZAI_DATA_DIR/.zai/commands`,字面不同 → 写 A 读 B 属实。
  - 触发链逐跳核实:`routes/agent.ts:2209` `permissionMode: getDefaultMode()` → `permissionMode.ts:11` re-export → `compat/permissions.ts:83`;`routes/bashRepl.ts:29` → `ReplSession.ts:182` → `ReplHistoryService.ts:82`。
  - **一处作者引错**:全仓 grep `defaultCommandsDirs` 只有 `userLoader.ts:23` 与 `:162` 两处命中。作者称 `routes/commands.ts:8` / `routes/command.ts:79` / `agentRuntime.ts:871,891` 调用它 —— 实际 `routes/commands.ts:9` 调的是 `reloadUserCommands`,经 `loadUserCommands`(`:159`)才到 `defaultCommandsDirs`(`:162`)。**链条仍成立(我逐跳核过),但作者少写了一跳且把调用点安在了错的函数上。**

- **与作者结论是否一致**:**一致**。E1 定位、行号精度(三处共 6 个引用中 4 个精确)、因果推理全部站得住。**唯一缺陷是 E1 最容易出错的那一跳(调用点归属)写错了**,而这恰恰是上一届 `wb-010` 塌掉的那一跳 —— 作者能在三问里把可达性答完却在调用链上写错一跳,说明**前置可达性的排查质量 ≠ 调用链的转述精度**,这两件事得分开评。

- **最终裁决**:`CONFIRMED`

### 抽验 4:作者的复现物是否伪造证据(方法学抽验,不针对单条裁决)

- **我的动作**:读 `/tmp/bughunt-claude/repro-manifest.mts` 与 `repro-offline-port.mts` 全文,检查是否犯了 §4.2 警告的假证据形态(自造 `Map` / 用 mock 替换被测对象)。

- **我看到的**:两个脚本都是**按绝对路径 import `packages/zai/src/**` 的生产源码**,没有 `vi.mock` / `mock.module`,没有自建容器冒充被测模块。**这一关作者是通过的。**

  但我在抽验 1 里发现一处**方法学瑕疵**:作者 §对照组 声称「两个复现物跑在两个独立 Node 进程里,各自有独立的 `manifest.json`」,而 `repro-manifest.mts` 的实验组与对照组**在同一进程、同一份 `manifest.json` 上顺序执行**(第 59-74 行的对照组直接在实验组留下的残缺 manifest 上继续写)。§4.7 第 2 条要求「每次对照前必须显式复位」。

  **我追踪后确认这不影响结论**:`recordExtraction` 的 `existing.extractedVersions ?? []`(`manifest.ts:126`)把残留的 `undefined` 兜成空数组,对照组的起点等价于全新 manifest;且该模块无模块级缓存。所以对照组**有效**,只是作者对自己执行方式的**描述是错的**。记此一笔,不改裁决。

---

## 五、评审中额外发现 / 交叉洞察

### 5.1 新缺陷

> 两栏互斥(§5.4):本节事实**不在** §5.2 计分。

### [oc-r1] `manifest.ts` 的非原子写 + `readManifest` 吞掉一切异常 ⇒ 一次撕裂读会**清空整个 manifest**,不是丢一个字段

- **严重度**:**S3**(边界退化 / 静默丢缓存索引)。不到 S2:丢的是**可重建**的缓存与解压索引(重跑 `npm view` / 重新解压即恢复),不是用户工作、不是凭据、不是跨会话串号。
- **证据等级**:**E3a**(真实执行 `manifest.ts` 的生产导出函数,含有区分力的对照组,见下)
- **执行环境**:Node v22.22.3(产品运行时) · `tsx` · darwin-arm64 · **为什么它代表用户**:`manifest.ts` 是纯 `node:fs/promises` 的 JSON 读写,不经浏览器、不经 Bun 专属 API;我 import 的是 `src/` 生产源码(不是 `dist/`)。
- **位置**:
  - `packages/zai/src/server/services/manifest.ts:79` —— 裸 `writeFile`(truncate-then-write,非原子)
  - `packages/zai/src/server/services/manifest.ts:64-71` —— `catch { return 空 manifest }`,把「半截文件」与「文件不存在」当成同一件事
  - `packages/zai/src/server/services/manifest.ts:105` / `:121` / `:147` —— 三个写点**都以 `readManifest()` 的返回为基底**,基底为空 ⇒ 写回的是只含一个包的文件
- **前置可达性三问**:
  1. **谁创建这个状态?** 撕裂态由**并发**产生,构造点有三处:`extractor.ts:139` 的 `updateCachedVersion(...).catch(()=>{})`(**不 await**,fire-and-forget)、`detect.ts:268` 的 `updateCachedVersion(...).catch(()=>{})`(**不 await**,每次 `npm view` 都跑)、`extractor.ts:138` 的 `await recordExtraction` 与 `extractor.ts:142` 的 `await pruneExtractions`(各自**以 await 读文件**)。三者之间**没有任何互斥** —— 与 `offlineBuffer.ts` 在 `2a9e31d6` 里加的那把 `io` 互斥形成鲜明对照,同一批修复里 `offlineBuffer` 加了、`manifest.ts` 没加。
  2. **生产默认配置下可达吗?****不需要任何非默认开关。** `extractor.ts:138-142` 是任何普通用户装/升一次插件就跑的 Stage 4/5;`detect.ts:268` 在每次 `npm view` 后触发。只要有**两次**写落在同一毫秒级窗口内,读方就会看到半截文件。
  3. **现有防护为什么挡不住?** `readManifest`(`:68`)的裸 catch **恰恰就是那层防护,而它是错的防护** —— 它不区分「ENOENT / 空文件」与「读到了别人写到一半的文件」,两者都返回空 manifest。仓库里 `d66d09f5` 已经把 `fileStore.ts:110/157`、`zaiSettingsStore.ts:100` 改成原子写(作者在 cl-001 修复建议里自己也点了这一条),**`manifest.ts:79` 是同批文件里唯一漏网的**,而它恰好又是唯一一处「空基底会被写回」的存储。
- **我的复现命令与输出**(`ZAI_DATA_DIR` 已隔离到 `/tmp/bughunt-opencc/`,真实 `~/.zai/` 未被读写):
  ```
  oc-new — manifest.ts whole-file loss via readManifest() torn read
  manifest path = /tmp/bughunt-opencc/zai-home/manifest-loss/manifest.json

  === STEP 1: healthy manifest built by production functions ===
    healthy: packages=[@zn-ai/plugin, @zn-ai/some-other-plugin]

  === STEP 2: file left in the state a concurrent reader sees (55% written) ===

  === STEP 3: extractor.ts:138 runs recordExtraction() ===
    after recordExtraction: packages=[@zn-ai/plugin]
        @zn-ai/plugin.extractedVersions = ["1.1.0"]
    packages that vanished from the manifest: ["@zn-ai/some-other-plugin"]

  === CONTROL: identical write on an INTACT manifest ===
    packages after control write: [@zn-ai/plugin, @zn-ai/some-other-plugin]
    @zn-ai/some-other-plugin.extractedVersions = ["5.0.0","5.1.0"]

    >>> discriminating: torn read loses 1 package(s); control loses 0
  ```
  **对照组有区分力**:同样的 `recordExtraction` 调用,在完整 manifest 上跑,两个包都在;在撕裂 manifest 上跑,另一个包的**两条解压索引一起消失**。
- **一处必须诚实标注的边界**:我的 STEP 2 是**构造**出撕裂态(直接写入文件的前 55% 字节),**没有**靠调度把竞态真实触发出来。已实测成立的是**后果链**(空基底 ⇒ 写回时抹掉其它所有包);未实测的是**触发时机**(撕裂态在真实负载下出现的频率)。按 §4.2.1「无法自证的按 E1 计」的精神,这一条应当按 **E3a(后果) + E1(触发频率)** 合并看待,不宣称「实测复现了竞态」。
- **为什么对方没报**:**对方报过,但归进了 §5 自我否定清单**,原文是「机制上成立(`writeFile` 非原子 + `catch` 吞掉)……**但我没有构造出能稳定复现的时序**,也没有实测」,并自我评价「**未验证**」。所以在对方报告里它**不是正式条目**。我把它作为新缺陷提出,因为:①对方缺的那块我可以确定性补上 —— 触发时序的不确定性可以用「直接构造撕裂态」绕开,后果链则是确定性的;②对方的自我否定有一处**过于保守**:它以为要证明「时序」才能成立,但其实**后果链本身就是可证的独立缺陷**,不该因为造不出时序就整条丢掉。这条与 `cl-001` **根因不同**(非原子写 vs 字段覆盖),按 §4.6「同一根因算一条」不构成重复。
- **修复方案**:`writeManifest`(`:76-80`)改用仓库已有的原子写(与 `fileStore.ts:110/157` 同一做法);`readManifest`(`:64-71`)的裸 catch 至少区分 `SyntaxError`/`ENOENT` 与其它,并在解析失败时**不要把空 manifest 当作可写基底**返回 —— 例如读失败时抛错,让 `:105/:121/:147` 三个写点 fail loud 而不是静默覆盖。

### 5.2 交叉洞察

> 本节事实**不在** §5.1 计分(§5.4 互斥)。

### [oc-r2] 对 `cl-002`:补上作者没做的「生产默认门槛」测量,据此把 S2 修正为 S3

- **针对**:`cl-002`(作者自报 **S2**,E3a)
- **作者的原论证**:「一个吵闹子实例的 FIFO 截断会静默删掉另一个子实例尚未投递的通知」。作者用 `ZAI_AA_OUTBOX_MAX_MB=1` 跑出 `entries owned by 9101 = 0 / >>> EVICTED by 9102 flood`,并据此自报 S2(跨实例状态污染 + 静默丢消息)。
- **我补上的(作者完全没做的三件事)**:
  1. **量出生产默认的真实门槛**。用真实 `OfflineBuffer.enqueue` + 真实 payload 形态实测每条字节数,再线性外推到 `offlineBuffer.ts:33` 的生产默认 50MB:`session.state.updated` 171 B/条 → ~30.6 万条;`notice.upserted` 319 B → ~16.4 万条;**最重的 `timeline.itemUpsert`(1.5KB 流式文本 delta)1,733 B → ~30,245 条**。也就是说,即使在最不利的现实类别下,也需要约 **3 万条**未投递通知才会发生第一次跨子实例驱逐。作者的 1MB 上限把这个门槛压到了生产默认的 **1/50**。
  2. **枚举作者没披露的三个叠加前置**(作者只披露了 `--aa` 一个):`isAaEnabled()` 实为 `process.env.ZAI_AA_ENABLED === '1'`(`aaClient/index.ts:45-46`,纯 opt-in);**必须已完成 pairing** —— 否则 `init.ts:119-126` 在 `readAaConfig()` 返回 null 时直接 return,`OfflineBuffer` 压根不会被创建;以及 **≥2 个子实例同时 enqueue**(否则「跨实例」无从谈起)。
  3. **反驳「注释认可 FIFO 截断 ⇒ 应降级」这个可能反向使用的推论**。`offlineBuffer.ts:17-19` 认可的是「有界降级好过整体失败」这个取舍;但同一段注释的 `:14-15` 明写 per-child 拆分的目的就是「一个吵闹子实例不 head-of-line-block 另一个」。**所以注释是作者主张之意图的证据,不是免责证据** —— 作者的机制论证在这个点上是对的,不需要降级理由。我把它算进作者那边。
- **结论**:作者的版本 **需要修正**。
  - **成立的部分**:`setPort` 生产零调用、`init.ts:172` 恒传 0、per-child 隔离从未实现 —— 全部成立,而且比作者写的更严重(错误承诺在代码里有**三处**:`offlineBuffer.ts:14-15`、`init.ts:168-171`,以及作者没提的 **`connection.ts:281-285`** —— 后者写着「passing 0 here means let the buffer pick a representative port」,而 `queueOffline(method, params)` 的签名里**根本没有 port 参数**)。
  - **需要修正的部分**:严重度 **S2 → S3**。机制是真的,危害通道也是真的,但**默认配置下不可触发**(需 opt-in + 已 pairing + 多子实例 + ~3 万条积压),按 §4.3 更贴 S3。**证据等级也应拆开**:机制部分够 E3a,危害部分只到 E2(因为拿掉 `ZAI_AA_OUTBOX_MAX_MB=1` 就跑不出来)。
  - **作者应把标题改写为**:「per-child outbox 隔离从未实现(3 处注释共同承诺),一个子实例的 outbox 洪水可驱逐其它子实例的未投递通知 —— 生产默认 50MB 下需约 3 万条积压,且需 `--aa` + 已 pairing + 多子实例」。

---

## 六、我给评审过程的一句话

claude 这份报告的**诚实度是本场我见过的上限**:三问全部答完、每个非默认前置都主动标注、连 boot 期隔离是否生效这种「没验证」的事都专门写一段声明「我不宣称生效也不宣称失效」、自我否定清单里 10 条线索明说「追完退了 / 未验证 / 主动放弃」而不是硬凑成条目 —— 这套自我约束本身就是质量信号,我没有因为降 cl-002 的级就抹掉它。但它同时暴露出一个规律:**定位与行号精度很高,失真全部集中在「最后一步的量级」和「调用点归属」** —— cl-002 把 1/50 的门槛当生产现实,cl-003 把 `reloadUserCommands` 写成 `defaultCommandsDirs`(链条仍成立,少一跳)。上一届冠军栽在「最后一跳」,这一届栽在最后一跳的**另一个变体**:不是可达性没查,是**量级没量**。
