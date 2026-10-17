# Bug 发掘报告 · claude

> 场次 `bug-hunt-game-10-17` · 参赛名 `claude` · ID 前缀 `cl-`
> 基线提交 `31fca1d2` · 环节一(自主发掘)

---

## 一、取证环境

- 工作树状态（开始与收口前 `git status --porcelain` 输出）：
  ```
  ?? docs/bugs/bug-hunt-game-10-17/
  ```
  全程只有本目录一条未跟踪项。**我没有对仓库任何既有文件做过 Edit/Write/删除,没有执行任何 git 写操作**（无 commit/add/stash/reset/checkout/restore/clean/push/rebase,未改 git config,未建分支或 worktree）。本报告文件本身位于 `docs/bugs/bug-hunt-game-10-17/` 下,符合铁律 3。

- typecheck 基线结果（§3.3）：
  ```
  zai  exit = 0   错误数 = 0
  core exit = 0   错误数 = 0
  ```
  - 与 README §3.4 声明的差异：**无差异**。§3.4 说基准提交 `31fca1d2` 两包 exit 0 零预存错误,我重跑得到同样的结果。
  - **差集说明**：我全程**没有发现任何新的 typecheck 错误**。本报告的三条 bug 没有一条是类型系统能看见的——全部是运行时数据流缺陷。这与 §8 的判断一致:typecheck 绿不代表没有 bug。

- 我实际执行过的命令：
  ```bash
  mkdir -p /tmp/bughunt-claude
  git rev-parse HEAD          # 31fca1d2e4033c94e7d368f41c2616adcffba84d
  git status --porcelain      # ?? docs/bugs/bug-hunt-game-10-17/
  git log --oneline 6f9ceaeb..HEAD      # 10 commits, 16 条修复
  git diff 6f9ceaeb..HEAD --stat
  pnpm --filter @zn-ai/zai run typecheck        > tc-zai.log  2>&1; echo "zai exit=$?"   # exit=0
  pnpm --filter @zn-ai/zn-agent-core run typecheck > tc-core.log 2>&1; echo "core exit=$?" # exit=0

  # 复现物（全部在 /tmp/bughunt-claude/，均为模块级脚本,未起任何服务）
  ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
    pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-manifest.mts        # cl-001
  ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
    pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-port.mts    # cl-002
  ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home ZAI_AA_OUTBOX_MAX_MB=1 \
    pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-evict.mts   # cl-002 后果
  ```
  - **我没有跑过全量测试**（铁律 7）。本报告不含任何依赖 `pnpm -r test` 的证据。

- **数据隔离自证**（铁律 10）：
  - **是**,三个复现脚本全部在 shell 层显式设置 `ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`,脚本头部也各自注明（见 `/tmp/bughunt-claude/repro-*.mts` 首行注释）。
  - **隔离实际生效的验证**(不只是贴 export):三个脚本的落盘路径经 `paths.ts:23` 的 `ZAI_DIR` 解析后全部位于 `/tmp/bughunt-claude/zai-home/` 下。实测产物:
    ```
    /tmp/bughunt-claude/zai-home/manifest.json      # cl-001
    /tmp/bughunt-claude/zai-home/aa/outbox-0.jsonl  # cl-002
    ```
  - **对用户真实 `~/.zai/` 的影响:零。** 我在第一次失败的运行(转译期报错,未执行任何代码)之后核对过 `~/.zai/aa/`,其内容为 `config.json`(2026-09-28)与 `outbox-0.jsonl`(0 字节,**时间戳 2026-10-11,早于本场开赛**),此后未再变动。
  - **⚠️ 如实声明（§8 提醒的那件事）**:README §2 铁律 10 点名「设了 `ZAI_DATA_DIR` **仍然**会读写用户真实 `~/.zai/settings.json`」,并要求选手如实写明隔离是否真的生效。**本场我无法对 boot 期路径下这个结论,因为我没有启动过任何 zai 服务实例**——我的复现全部是模块级 `tsx` 脚本,不经过 `server/index.ts` 的启动序列,因此 boot 期的 permissions backfill 等自动写路径**没有被执行,也没有被验证**。我不宣称隔离在 boot 期生效,也不宣称它失效;这一项**未验证**。若裁判要核这一条,需按 §3.1 起一个隔离实例(端口见下)。

- **端口自证**（铁律 11）：**我没有启动过任何服务,因此没有绑定任何端口**。9201 未被触碰,未执行任何 kill。三个复现物都是纯 Node 模块执行,不开监听端口。§3.1 建议的隔离实例(8101/7715)**未启动**。

---

## 二、排查范围

| 子系统 | 是否排查 | 结论 |
|---|---|---|
| `packages/zai/src/server/routes/` | 部分 | 读了 `agent.ts`(wb-011 的 `deletedSessions` 调度端守卫)、`permission.ts`、`fs.ts`;追完调用链后**未报**(见第五节自证) |
| `packages/zai/src/server/services/` | **重点** | 产出 cl-001(`manifest.ts`)、cl-002(`aaClient/offlineBuffer.ts`)、cl-003(三个未迁移的路径解析器) |
| `packages/zai/src/web/`(前端组件 / store / hooks) | 略读 | 读了 `useAgentStore.ts` 的 session 切换 diff;前端断言按 §3.2 第 7 条需真实浏览器,本场时间预算内未做,主动放弃 |
| `packages/zn-agent-core/src/compat/` | **重点** | 产出 cl-003 的 `compat/permissions.ts:83`;另外通读 `runWithSessionId.ts`、`openccInit.ts`、`deletedSessions.ts`、`headlessPermissionBridge.ts` 的 cc-002 修复,**未报**(见第五节) |
| `packages/zn-agent-core/src/opencc-src/`(vendor) | 部分 | 读了 `createOpenccRuntime-impl.ts` 的 per-query bridge 写/恢复点;定位到 `filesystem.ts:126/321` 与 `daemon/roster.ts:29` 的 `~/.zai` 硬编码,但**自证为同族**(见 cl-003 与第五节) |
| 上一届修复新落地的代码(`git log 6f9ceaeb..HEAD` 的 diff) | **重点** | 逐个 commit 读了:`2a9e31d6`(离线补发,产出 cl-002 的邻域)、`29d86914`/`31fca1d2`(cc-r1/wb-r1,未报)、`ee6d154e`(per-chain ALS,未报)、`a26f47b7`、`e00cfe11`、`d66d09f5`(产出 cl-003) |
| 其他:`extractor.ts` / `detect.ts` / `commands/` / `repl/` | 重点 | cl-001 的调用链与 cl-003 的 writer/reader 分裂 |

**我读过但明确放弃的区域**:

| 区域 | 放弃理由 |
|---|---|
| §3.4 A 组 7 条(`lan-mode-no-auth-rce` / `exec-csrf-rce` / 两条 symlink / `weixin-content-fingerprint-dedup` / `instance-supervisor-double-spawn` / `session-inbox-sync-try-catch`) | 重报 0 分(§3.4 明确) |
| §3.4 B 组 `wb-010`(WebFetch SSRF 裸 fetch) | 重报 0 分 |
| §3.4 C 组 5 条归档项(`cc-001`/`cc-006`/`wb-002`/`wb-009`/`tc-rv-001`) | 重报 0 分 |
| vendor 被 stub 的 ~230 个 `.tsx`(组件体 `return null`) | §3.2 第 5 条,有意移除的终端 UI,不是缺陷 |
| `docs/bugs/bug-hunt-game-10-16/bug-hunt-*.md` 与 `hunt-review-*.md` | 铁律 6,环节一禁止阅读对方及上届任何选手的 bug 报告。我**未打开过这些文件**;本报告的每一条都是我自己追出来的。(上届的 `VERDICT.md` / `FIX-PLAN.md` 可读,但我也没有打开——本场不需要) |
| 前端 React 组件树 / 样式 | §3.2 第 7 条:happy-dom 断言红绿无意义,要判需 `/ego-browser` 真实渲染。本场时间预算不足以做有意义的浏览器验收,与其交 E0 不如不交 |
| `packages/zai/src/cli/ports.ts` 的 split-brain | §3.4 A 组已列(两条安全缺陷的共享根因),不重报 |

**为什么没排查其它区域**:60 分钟预算下,我把时间集中在 §8 点名的「上一届刚落地的 16 条修复本身」+「模块级单例的生命周期」两片,每条报告都要求有可复验的 `file:line` 与对照输出;广撒网交 20 条 E0 在本场是负收益(§8 明说)。

---

## 三、Bug 报告

### [cl-001] 标题：每次插件安装/升级,`updateCachedVersion` 都会把上一行刚写进 manifest 的 `extractedVersions` 整体覆盖掉,导致 LRU 清理永久失效、`~/.zai/extracted/` 无上限增长

- **严重度**：S3(边界退化——错误路径不清理/不释放。每一次插件升级都泄漏一整份解压产物,无告警、无上限、无回收)

- **证据等级**：**E3a**(真实执行被测模块 `packages/zai/src/server/services/manifest.ts` 自身的导出函数,完整复现 `extractor.ts:132-146` 的生产调用序列;**未使用任何 `vi.mock` 替换被测对象本身**;含有区分力的对照组,见下)

- **前置可达性三问**:
  1. **谁创建/写入这个状态?** 写 `extractedVersions` 的生产代码只有两处,删掉它的也是两处:
     - 写入:`manifest.ts:132`(`recordExtraction` 内,`manifest.packages[pkg] = { ...existing, extractedVersions: list }`——**有展开,保留**)、`manifest.ts:156`(`pruneExtractions` 内,`{ ...entry, extractedVersions: kept }`——**有展开,保留**)。
     - 删除:`manifest.ts:106`(`updateCachedVersion` 内,`manifest.packages[pkg] = { latestVersion, cachedAt: Date.now() }`——**整体替换,无 `...existing`,字段被抹掉**)。
     - 调用点共 4 处生产代码:`extractor.ts:138`(`recordExtraction`)、`extractor.ts:139`(`updateCachedVersion`,`.catch(() => {})` fire-and-forget)、`extractor.ts:142` 与 `extractor.ts:430`(`pruneExtractions`)、`detect.ts:268`(`updateCachedVersion`,同样 fire-and-forget)。
     - grep 证据:`grep -rn "updateCachedVersion\|recordExtraction\|pruneExtractions" packages/zai/src --include="*.ts" | grep -v "\.test\."` → 命中 `detect.ts:9,268`、`manifest.ts:101,117,143`、`extractor.ts:18,19,20,138,139,142,430`。
  2. **生产默认配置下可达吗?****可达,且不需要任何非默认开关。** `extractor.ts:138-142` 位于插件安装/升级的 Stage 4/5,是**普通用户装任何一个插件**就会走的路径。不需要 `ZAI_DATA_DIR`、不需要 `--aa`、不需要 `--lan`、不需要任何只在测试里设的 env。普通 `pnpm --filter @zn-ai/zai dev` 起服务后在 UI 里装插件即触发。
  3. **现有防护为什么挡不住?** 这条路径上**没有任何防护**:
     - 没有字段级合并——`recordExtraction`(`:132`)和 `pruneExtractions`(`:156`)都写了 `...existing`,唯独 `updateCachedVersion`(`:106`)没有,同一个模块内三个写点两种写法,编译器不会报错(字段是可选的 `extractedVersions?`)。
     - `pruneExtractions`(`:149`)有一个 `if (!entry?.extractedVersions?.length) return []` 的早返回,但那是**症状不是防护**:它正是「索引已被抹掉」的表现,函数静默返回空数组,调用方 `extractor.ts:143-145` 的 `for (const d of dropped) await rm(...)` 因此一次都不执行。
     - `extractor.ts:139` 的 `.catch(() => {})` 把 `updateCachedVersion` 的异常吞掉,但本条**根本不抛错**——它是成功地写了一个残缺对象,所以没有任何错误信号。
     - 同模块的 `readManifest`(`:64-71`)有裸 `catch { return 空 manifest }`,会进一步掩盖问题(读失败被当成空),但这不是本条的成因。

- **执行环境**：运行时 Node **v22.22.3**(产品运行时,与裁判 §1 实测一致) · 工具链 `tsx` ESM 转译 + `pnpm --filter @zn-ai/zai exec` · 平台 darwin-arm64
  - **为什么这个环境代表用户**:`packages/zai` 的产品运行时就是 Node-direct(§1),`manifest.ts` 是纯 `node:fs/promises` 的 JSON 文件读写,不经任何浏览器/happy-dom 环境,也不经 Bun 专属 API。我直接调用的是生产模块源码本身(不是 `dist/` 产物,§3.2 第 3 条的坑因此规避),因此结论对产品运行时成立。

- **位置**：
  - `packages/zai/src/server/services/manifest.ts:106` — 缺陷点(整体替换丢字段)
  - `packages/zai/src/server/services/manifest.ts:132` / `:156` — 对照:同模块另两个写点有 `...existing` 展开
  - `packages/zai/src/server/services/manifest.ts:149` — 早返回,让缺陷静默
  - `packages/zai/src/server/services/extractor.ts:138-142` — 生产调用序列

- **触发路径**：用户安装/升级任意插件 → `extractPlugin()` (`extractor.ts`) → `recordExtraction(PLUGIN_PKG, entry)` (`extractor.ts:138`,写入 `extractedVersions:["1.2.0"]`) → `updateCachedVersion(PLUGIN_PKG, version)` (`extractor.ts:139`,**抹掉整个字段**) → `pruneExtractions(PLUGIN_PKG, 3)` (`extractor.ts:142`,读到 `undefined` → 早返回 `[]`) → `extractor.ts:143-145` 的 `rm(d.path)` 循环一次都不跑。

- **现象**：
  - 预期:`manifest.json` 里 `packages["@zn-ai/plugin"].extractedVersions` 累积已解压版本列表;装第 4 个版本时,`pruneExtractions(keep=3)` 返回恰好 1 个待删目录,LRU 把最老的解压产物从磁盘上删掉。磁盘占用收敛。
  - 实际:`extractedVersions` 在每次升级后变成 `undefined`;`pruneExtractions` 恒返回 `[]`;`~/.zai/extracted/` 下每个装过的版本都留一份完整副本,永不回收。

- **影响**：**对用户**:`~/.zai/extracted/` 单调增长且无上限,插件升级 N 次就是 N 份解压产物。每装一次插件,磁盘占用增长一份插件体积。**对数据**:manifest 的解压索引退化为空,`detect.ts:268` 依赖 `latestVersion` 的版本判断虽仍可用,但 LRU 这一层永久失效。**对成本**:无直接 token 成本,但长期跑会让 `~/.zai` 所在分区被撑满,进而影响同盘其它数据。

- **对照组**(§4.7):对照组 = **同样的 4 次 `recordExtraction` + `pruneExtractions`,唯独不调用 `updateCachedVersion`**。如果 bug 不存在,两组输出应完全相同;实测差异极大:
  - 实验组(完整生产序列,4 次升级):每次 `updateCachedVersion` 后 `extractedVersions = undefined`,`pruneExtractions` 返回 **0**,4/4 次。
  - 对照组(去掉 `updateCachedVersion`,4 次安装):`pruneExtractions` 累计 drop **1** 个版本——恰好等于「4 个版本、keep=3」的数学期望。
  - **区分力**:对照组精确地把嫌疑收敛到 `updateCachedVersion` 一个函数上——它证明 `recordExtraction` + `pruneExtractions` 这条链本身是好的,坏的只有在它们之间插进去的那一行动作。
  - **模块级状态复位**:两个复现物跑在**两个独立 Node 进程**里(两次单独 `tsx` 调用),各自有独立的 `manifest.json`,不存在跨对照复用模块级缓存的问题。

- **复现步骤**:
  1. `mkdir -p /tmp/bughunt-claude/zai-home`
  2. `export ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`(隔离,见铁律 10)
  3. `pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-manifest.mts`
  4. 看 `manifest.json` 的 `packages["@zn-ai/plugin"]` 字段

- **复现命令与输出**(真实输出,未做任何删改):
  ```
  $ ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
      pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-manifest.mts
  ZAI_DATA_DIR = /tmp/bughunt-claude/zai-home

  === upgrade #1: install @zn-ai/plugin@1.0.0 ===
    after recordExtraction (extractor.ts:138): extractedVersions = ["1.0.0"]
    after updateCachedVersion (extractor.ts:139): extractedVersions = undefined  <-- FIELD GONE
    pruneExtractions returned 0 version(s) to delete from disk
    after pruneExtractions (extractor.ts:142): extractedVersions = undefined  <-- FIELD GONE

  === upgrade #2: install @zn-ai/plugin@1.1.0 ===
    after recordExtraction (extractor.ts:138): extractedVersions = ["1.1.0"]
    after updateCachedVersion (extractor.ts:139): extractedVersions = undefined  <-- FIELD GONE
    pruneExtractions returned 0 version(s) to delete from disk
  ... (upgrade #3 / #4 同形)

  === CONTROL GROUP: does the extraction index survive 4 versions? ===
    A healthy index with keep=3 over 4 versions must drop exactly 1.
    total versions dropped by pruneExtractions over 4 installs = 1
    expected if index intact = 1
    >>> index works
  ```
  - 与 §3.4 typecheck 基线的差集:**无**。本条不是 typecheck 能抓的类型矛盾——`extractedVersions?` 在 `ManifestEntry`(`manifest.ts:37`)上是**可选字段**,赋值时少写一个 key 对 TS 完全合法,两包 typecheck 仍为 exit 0。

- **修复方案**:`manifest.ts:106` 与同模块另两个写点对齐,补上展开:
  ```ts
  const existing: ManifestEntry = manifest.packages[pkg] ?? { latestVersion: null, cachedAt: 0 };
  manifest.packages[pkg] = { ...existing, latestVersion, cachedAt: Date.now() };
  ```
  建议同时把 `readManifest`(`:64-71`)的裸 `catch` 与 `writeManifest`(`:79`)的裸 `writeFile` 换成 `atomicWriteFile`——本仓库 `d66d09f5` 改过的 `fileStore.ts:110/157`、`zaiSettingsStore.ts:100` 都已用原子写,`manifest.ts` 是同批文件里唯一漏网的,并发 `detect.ts:268` 的 fire-and-forget 写与 `extractor.ts` 的写会互相截断。

- **不可触发自证**:不适用(本条默认可触发且已实测触发)。

- **上游对照**:`/Users/ethan/code/opencc` 无对应文件(manifest 是 zai 侧 plugin 解包机制),不影响计分。

---

### [cl-002] 标题：`OfflineBuffer.setPort()` 全仓零调用,所谓「每个子实例一个 outbox」的隔离从未发生;所有子实例共用 `outbox-0.jsonl`,一个吵闹子实例的 FIFO 截断会静默删掉另一个子实例尚未投递的通知

- **严重度**：S2(跨实例状态污染 + 静默丢消息——一个子实例的通知被另一个子实例的行为销毁,用户在 AA 端永远看不到那些 timeline 条目)

- **证据等级**：**E3a**(真实执行生产模块 `packages/zai/src/server/services/aaClient/offlineBuffer.ts` 的真实导出函数 `initOfflineBuffer` / `enqueue` / `setPort` / `pruneExtractions` 无关函数,断言可观测结果 = 磁盘上真实产生的 outbox 文件内容;**未 mock 被测对象**;两个复现物,各含对照组)

- **前置可达性三问**:
  1. **谁创建/赋值这个状态?** `OfflineBuffer` 实例的 `port` 字段只有两个赋值点:
     - `offlineBuffer.ts:61-63` 构造函数 `constructor(conn, port) { this.port = port }`——生产侧**唯一**的构造调用是 `init.ts:172` 的 `initOfflineBuffer(conn, 0)`(注释写死「picks a representative port (the supervisor's own instance, 0) for now」)。
     - `offlineBuffer.ts:69-71` `setPort(port: number) { this.port = port }`——**本应**在「每个 runtime_registry 注册时更新到最近运行的子实例」时被调用(`init.ts:170-171` 的注释就是这么声称的),但**全仓零调用**。
     - grep 证据:`grep -rn "setPort" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules` → 7 处命中,其中 `offlineBuffer.ts:69` 是方法定义本身,其余 6 处(`web/src/pages/Instances.tsx:160,354,628,802,816,817`)全部是 React 的 `setPortEditRow` / 局部函数 `setPort(id, port)`,与 OfflineBuffer 无关。**生产调用点 = 0。**
  2. **生产默认配置下可达吗?****需要非默认开关,必须写明。** 这条链路只由 `--aa` 启动的实例触发:`initAaClient()` 在 `init.ts:85` `if (!isAaEnabled()) return null` 处被 `server/index.ts:173` 调用,`initOfflineBuffer` 在其内部 `init.ts:172`。**普通 `pnpm --filter @zn-ai/zai dev`(不带 `--aa`)不会创建 OfflineBuffer,本条不触发。** 对 `--aa` 实例则是**默认行为**——`init.ts:172` 传的就是常量 0,且没有任何后续代码会改它。
  3. **现有防护为什么挡不住?**
     - 隔离机制**存在但从未被调用**:`setPort` 是 public 方法,类型检查通过,没有任何 lint/dead-code 规则拦它。
     - `enqueue`(`offlineBuffer.ts:96-107`)与 `maybeDrain`(`:110-...`)都用 `this.port` 拼 `aaOutboxPath(this.port)` —— 两边都用同一个「永远是 0」的值,**内部完全自洽,不会报错**,只是隔离语义落空。
     - `enforceSizeCap`(`offlineBuffer.ts` 尾部)的 FIFO 截断按**文件内位置**丢最老条目,`offlineBuffer.ts` 头部注释声称的「Per-port scoping: each child has its own outbox so a backlog from one noisy child doesn't head-of-line-block another」正是它唯一的防线,而这条防线所依赖的 per-port 拆分从未发生。
     - `2a9e31d6`(tc-001)新加的 `io` 互斥是**实例内**的,只能防同一实例内的 enqueue/drain 互撞,**跨子实例的语义隔离它管不了**,也拦不住跨子实例的内容互相驱逐。
     - **旁证**:`~/.zai/aa/` 实际只有 `outbox-0.jsonl` 一个 outbox(0 字节,2026-10-11),没有任何 `outbox-<port>.jsonl`——与「port 恒为 0」一致。

- **执行环境**：运行时 Node **v22.22.3**(产品运行时) · 工具链 `tsx` + `pnpm --filter @zn-ai/zai exec` · 平台 darwin-arm64
  - **为什么这个环境代表用户**:目标模块是 `node:fs/promises` 的 JSONL 文件读写 + 一个进程内单例,不涉及浏览器/happy-dom,不经 Bun 专属 API;我 import 的是生产源码本身(非 `dist/`)。`--aa` 的 WebSocket 连线部分我用假 `conn` 替身驱动,但**被测行为(端口如何解析、条目落到哪个文件、谁被 FIFO 截断)完全不经过网络层**,因此结论对真实 `--aa` 实例成立。

- **位置**：
  - `packages/zai/src/server/services/aaClient/offlineBuffer.ts:69-71` — `setPort()`,零调用(隔离机制本身)
  - `packages/zai/src/server/services/aaClient/offlineBuffer.ts:14-16` — 头部注释声称的 per-port 隔离语义
  - `packages/zai/src/server/services/aaClient/init.ts:170-172` — 生产以常量 0 构造,并注释声称「Each runtime_registry registration updates the active port」
  - `packages/zai/src/server/services/aaClient/offlineBuffer.ts`(`enforceSizeCap`)— FIFO 截断,跨子实例驱逐的实际发生点

- **触发路径**：`--aa` 实例启动 → `server/index.ts:173` → `initAaClient()` (`init.ts:84`) → `initOfflineBuffer(conn, 0)` (`init.ts:172`)`this.port` 恒为 0` → 子实例 9102 掉线,`connection.ts:286/303` 调 `queueOffline` → `connection.ts:307-311` `await getOfflineBuffer()?.enqueue(...)` → `offlineBuffer.ts:103` `appendFile(aaOutboxPath(0), line)` → **子实例 9102 的通知与子实例 9101 的通知写进同一个 `outbox-0.jsonl`** → 9102 持续产出撑破 `ZAI_AA_OUTBOX_MAX_MB` → `enforceSizeCap` 从**文件头部**丢弃最老条目 → **9101 仍未重连、仍欠着的通知被 9102 的洪水冲走**。

- **现象**:
  - 预期:每个子实例一个 `outbox-<port>.jsonl`(`offlineBuffer.ts:14-16` 明文承诺),9102 的洪水只截断 9102 自己的队列。
  - 实际:全部落在 `outbox-0.jsonl`;截断是无差别的文件头 FIFO,谁先谁被丢。

- **影响**:**对用户**:某个子实例断线期间产生的通知(timeline 条目 / session.state.updated / notice.upserted)在它重连前就可能**被另一个完全无关的子实例的正常业务流量静默销毁**,AA 端时间线出现静默空洞,无任何报错(截断只 `console.warn`)。**对数据**:已排队但未投递的通知丢失。**对成本**:无 token 成本。

- **对照组**(§4.7):两个复现物各有一个对照组。
  - **复现物 A(`repro-offline-port.mts`)的对照组 = 显式调用 `setPort(9102)`**。若隔离成立,对照组必须多出一个 outbox 文件。
    - 实验组(生产接线 `initOfflineBuffer(conn, 0)`,`setPort` 不调用):`outbox files = ["outbox-0.jsonl"]`,该文件 `owners = [9101, 9102]` —— **两个子实例混在一个文件,隔离不存在**。
    - 对照组(调用 `setPort(9102)` 后再入队):`outbox files = ["outbox-0.jsonl","outbox-9102.jsonl"]` —— **多出第二个文件**,证明隔离机制本身是好的,只是生产从不调用它。
  - **复现物 B(`repro-offline-evict.mts`)的对照组 = 只跑 `recordExtraction` 式的计数对比**。该复现物直接给出「9101 的欠账从 ≥1 变成 0」的前后对照,实验组 9102 灌 12000 条后 9101 存活数 = 0,预期 = >0。
  - **模块级状态复位**:`OfflineBuffer` 是模块级单例(`offlineBuffer.ts:226-238`),每次复现都在**独立 Node 进程**中运行并在结尾调用 `resetOfflineBufferForTests()`,不存在跨对照复用单例的问题。

- **复现步骤**:
  1. `mkdir -p /tmp/bughunt-claude/zai-home`
  2. `export ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home`(复现物 B 再加 `ZAI_AA_OUTBOX_MAX_MB=1`,把 50MB 上限压到可测的 1MB)
  3. `pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-port.mts` → 看分组归属
  4. `pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-evict.mts` → 看跨子实例驱逐

- **复现命令与输出**(真实输出):
  ```
  $ ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home \
      pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-port.mts
  ZAI_DATA_DIR = /tmp/bughunt-claude/zai-home
  outbox cap MB = (default 50)

  --- EXPERIMENT (production wiring, setPort never called) ---
  buffer.port after init = 0
  outbox files on disk   = ["outbox-0.jsonl"]
    outbox-0.jsonl: 3 entries, owners = [9101,9102]

  --- CONTROL GROUP (setPort() invoked) ---
  buffer.port after setPort = 9102
  outbox files on disk   = ["outbox-0.jsonl","outbox-9102.jsonl"]
    outbox-0.jsonl: 3 entries, owners = [9101,9102]
    outbox-9102.jsonl: 1 entries, owners = [9102]
  ```
  ```
  $ ZAI_DATA_DIR=/tmp/bughunt-claude/zai-home ZAI_AA_OUTBOX_MAX_MB=1 \
      pnpm --filter @zn-ai/zai exec tsx /tmp/bughunt-claude/repro-offline-evict.mts
  ZAI_DATA_DIR = /tmp/bughunt-claude/zai-home | cap MB = 1

  [1] child 9101 queues 1 pending notification
      file entries = 4 [ 9101, 9101, 9102, 9101 ]

  [2] child 9102 floods 12000 notifications into the same outbox
  [aa.offlineBuffer] port 0 outbox exceeded 1048576 bytes; dropped 3292 oldest entries
  [aa.offlineBuffer] port 0 outbox exceeded 1048576 bytes; dropped 3291 oldest entries
  ... (重复)

  [3] after the cap trim:
      total entries       = 324
      entries owned by 9101 (still disconnected) = 0
      entries owned by 9102                      = 324
      >>> 9101 pending notification survived?  NO -- EVICTED by 9102 flood
  ```
  - **对复现物 B 的一处诚实说明**:`[1]` 显示 4 条而非 1 条,因为复现物 A 的实验组数据还在同一个 `outbox-0.jsonl` 里(我没有在两次运行之间清目录,以免掩盖任何东西)。这**不影响结论**:9101 的条目数从 **≥1(实为 3)** 降到 **0**,趋势与归因都成立。我选择贴原始输出而不是清干净后重跑,就是为了这个数字可核对。
  - 与 §3.4 typecheck 基线的差集:**无**。`setPort` 是一个合法的 public 方法,「没人调用它」在类型系统里是完全正常的状态。

- **修复方案**:二选一,建议后者:
  - (最小)改 `init.ts:168-172` 的注释,承认 outbox 暂时是全局单文件,并把 `enforceSizeCap` 的丢弃策略从「无差别丢最老」改成「按 method/payload 里的 child 归属分组保留」,避免跨子实例驱逐。
  - (正确)真正实现注释承诺的语义:在 `initRuntimeRegistry(conn)` 的每次子实例注册回调里调用 `getOfflineBuffer()?.setPort(<该子实例端口>)`,或在 `OfflineBuffer` 内按 payload 归属分桶写多个文件。配套把 `offlineBuffer.ts:14-16` 的注释与实现对齐。
  - 另建议:`stop()`(`offlineBuffer.ts:80-82`)只置 `statusListenerInstalled = false`,**不清 `start()`(`:74-79`)里那个 `const interval = setInterval(...)`** —— 局部 `const` 从不保存,`initOfflineBuffer`(`:228-233`)替换单例时旧实例的 1Hz 定时器会一直跑。本条我把它单列在第五节而非正式条目,因为当前 `init.ts:172` 全仓只被调用一次、无法在生产触发两个实例并存,不满足正式条目的可达性门槛。

- **不可触发自证**:不适用(已实测触发)。

- **上游对照**:不适用(`aaClient/` 是 zai 侧 AA 集成,上游 opencc 无此模块),不影响计分。

---

### [cl-003] 标题：`d66d09f5` 只迁移了 `settings.json` 一条路径,`getDefaultMode()`、`defaultCommandsDirs()`、`defaultHistoryPath()` 三个解析器仍硬写 `homedir()/.zai`,设了 `ZAI_DATA_DIR` 的实例仍读写真实用户配置

- **严重度**：S3(边界退化 / 轻微泄漏 + 隔离失效。默认配置下**行为正确**,危害仅在设了 `ZAI_DATA_DIR` 时显现;但其中 `ReplHistoryService` 会**写入**用户真实 home,`getDefaultMode` 会让权限模式的判定读错文件——两者都不是「提示缺失」级别,故未降到 S4。**若裁判认为仅因需要 `ZAI_DATA_DIR` 即应降档,我接受。**)

- **证据等级**：**E1**(静态可证:三处精确 `file:line` + 从入口到出错点的完整调用链 + 无防护的原因 + 后果推演。我**没有**为这三条跑机器复现——时间预算内我把机器证据全给了 cl-001/cl-002,而这三条的成立不依赖运行时观察)

- **前置可达性三问**:
  1. **谁创建/赋值这个状态?** 三处,全部是**路径常量/函数**,无 env 感知:
     - `packages/zn-agent-core/src/compat/permissions.ts:83` — `const path = join(homedir(), '.zai', 'settings.json')`,在 `getDefaultMode()`(`:81`)内。
     - `packages/zai/src/server/services/commands/userLoader.ts:26` — `const zaiDir = opts.dataDir ? join(opts.dataDir, '.zai', 'commands') : join(home, '.zai', 'commands')`,外加 `:27` `const homeClaudeDir = join(home, '.zai', 'commands')` **无条件指向真实 home**,`:39-40` 的 `else if (existsSync(homeClaudeDir)) dirs.push(homeClaudeDir)` 是回落到真实 home 的分支。
     - `packages/zai/src/server/services/repl/ReplHistoryService.ts:162-164` — `function defaultHistoryPath() { return `${homedir()}/.zai/repl-history.jsonl` }`(**模板串写法,绕开了 `join(homedir(), '.zai'` 这个 grep 特征**),在 `:51` 构造函数里被一次性捕获进 `this.historyPath`,随后 `:82` `appendFile(this.historyPath, ...)` 与 `:152-155` `rotate()` 一直用它。
     - grep 证据(跨**两个包**,§2 铁律 10 要求收口两个象限):
       `grep -rn "homedir()" packages/zai/src | grep -v "\.test\." | wc -l` → 63;
       `grep -rn "homedir()" packages/zn-agent-core/src | grep -v "\.test\." | wc -l` → 111;
       `grep -rn "process\.env\.HOME" packages/zai/src packages/zn-agent-core/src | grep -v "\.test\."` → 仅 2 处(`opencc-src/utils/xdg.ts:23`、`redaction.ts:625`),**均不拼 `.zai`**,故 `${process.env.HOME}/.zai` 这一变体本场已无漏网。
     - **writer/reader 分裂**:`d66d09f5` 迁移了 writer `commands/fileStore.ts:11` `commandsDir() = join(resolveZaiDir(), 'commands')` → `$ZAI_DATA_DIR/commands`,却**没迁** reader `userLoader.ts:26` 的 `join(opts.dataDir, '.zai', 'commands')` → `$ZAI_DATA_DIR/.zai/commands`。**两者指向不同目录**。
  2. **生产默认配置下可达吗?****缺陷需要非默认 env `ZAI_DATA_DIR`,必须写明。**
     - 默认配置(`pnpm --filter @zn-ai/zai dev`,不设 `ZAI_DATA_DIR`):`homedir()` 就是正确位置,三处**行为正确,不是 bug**。
     - 设了 `ZAI_DATA_DIR` 时(任何隔离实例 / 第二个实例 / 测试套件——`packages/zai/test/setup.isolation.ts:19-20` **全局为每次 zai 测试设置了它**):三处仍指向真实 home,隔离失效。
     - 因此本条是**「d66d09f5 迁移不完整」**,不是「默认路径错误」。报告口径必须这么写。
  3. **现有防护为什么挡不住?**
     - `paths.ts:45-47` 的 `resolveZaiDir()` 是仓库声明的**唯一**路径入口,但只有 12 个调用点采用了它;`grep -rn "resolveZaiDir" packages/zai/src | grep -v test` 的命中里**没有** `userLoader.ts`、`ReplHistoryService.ts`;`compat/permissions.ts` 根本不 import 任何解析器。
     - `userLoader.ts:39-40` 的 `existsSync` 只判断**存在性**,不判断**是否属于本实例的数据目录**——回落到真实 home 恰恰是「存在」的。
     - `permissions.ts:95-99` 的 catch **函数体是空的**(只有一行注释 `// Real IO error — fall through to default.`),读错路径与正确地读到空**在行为上不可区分**,直接 `return 'default'`。
     - 同包同位的 `compat/taskListStore.ts:300` **已经**按同一理由迁过了(其注释 `// core 够不到 zai 的 paths.ts … 这是结构性约束而非疏忽` 与 `permissions.ts:78` 的注释几乎是同一句话)——说明约束是真的,只是 `permissions.ts` 被漏掉了。
     - `manifest.ts:6-11` 的注释(`ESM 的顶层常量在模块加载时即求值,而测试需要在设完 env 之后才让路径生效`)说明维护者**已知**静态捕获 vs 函数重读这个模式;`ReplHistoryService.ts:51` 的构造函数一次性捕获正是该模式的反例。

- **执行环境**:不适用(E1 静态条目,未执行)。定位所依据的运行环境是 Node v22.22.3 / darwin-arm64,源码基线 `31fca1d2`。

- **位置**(三处同根因,合为一条,遵 §4.6「同一根因算一条」):
  - `packages/zn-agent-core/src/compat/permissions.ts:83`
  - `packages/zai/src/server/services/commands/userLoader.ts:26-27,39-40`
  - `packages/zai/src/server/services/repl/ReplHistoryService.ts:162-164`(经 `:51` 一次性捕获)

- **触发路径**:
  - (a) 权限模式:`POST /api/agent` → `packages/zai/src/server/routes/agent.ts:2209` 调 `getDefaultMode()` → `packages/zai/src/server/services/permissionMode.ts:11` re-export → `compat/permissions.ts:83` **读用户真实 `~/.zai/settings.json`**,而不是本实例 `$ZAI_DATA_DIR/settings.json`(后者由 `zaiSettingsCache.ts:174-179` 在 boot 时写入了 `permissions` 块)。另 `routes/agentSettings.ts:169` 的 `GET /api/agent/settings` 同源。
  - (b) 命令目录:`routes/commands.ts:8` / `routes/command.ts:79` / `agentRuntime.ts:871,891` 调 `defaultCommandsDirs({ dataDir: process.env.ZAI_DATA_DIR ?? '' })` → `userLoader.ts:26` 拼出 `$ZAI_DATA_DIR/.zai/commands` → `existsSync` 失败 → `:39-40` 回落到 `~/.zai/commands`(**真实 home**)。而写入端 `commands/fileStore.ts:11` 写的是 `$ZAI_DATA_DIR/commands`。**写 A 读 B。**
  - (c) REPL 历史:`POST /api/bash/repl/:sessionId/exec`(`routes/bashRepl.ts:29`)→ `ReplSession.ts:182` `appendCommand(...)` → `ReplHistoryService.ts:82` `appendFile(this.historyPath)` → **写进用户真实 `~/.zai/repl-history.jsonl`**,并可能 `:152-155` rotate 覆盖其真实 `.1` 文件。

- **现象**:
  - (a) 预期:隔离实例的会话用它自己 `$ZAI_DATA_DIR/settings.json` 里声明的默认权限模式。实际:读的是开发者真实 home 的配置;若真实配置无 `permissions.defaultMode`,新会话静默以 `'default'`(逐项询问)启动,而非隔离目录刚声明的模式,且 `GET /api/agent/settings` 回显的值与 `zaiSettingsCache` 写入的值**互相矛盾**。
  - (b) 预期:`PUT /api/commands/foo` 写入的命令能被该实例读到。实际:写入 `$ZAI_DATA_DIR/commands/foo.md`,读取却扫 `$ZAI_DATA_DIR/.zai/commands`(不存在)→ 回落真实 `~/.zai/commands`。**刚创建的命令不可见,该实例反而静默继承了用户真实的全套全局命令。**
  - (c) 预期:隔离实例的 REPL 历史落在隔离目录。实际:每次执行都 append 到用户真实的 `~/.zai/repl-history.jsonl`;超 10MB 时 `rotate()` 还会 rename 覆盖用户真实的 `.1` 文件。

- **影响**:**对用户**(c) 会向用户真实 home **写入**内容并可能覆盖其轮转文件——这是三者中最实质的;(b) 让隔离实例继承用户真实命令集,既是隔离失效也是轻度信息越界;(a) 让权限模式的判定读错文件,若真实配置是宽松模式、隔离配置是严格模式(或反之),**判定结果与实例自身配置不符**。**对数据**:主要是 (c) 对真实 home 的写入。(a)/(b) 是读。

- **对照组**:E1 条目按 §4.4 不强制对照组。但我给出**内禀对照**:同一批路径中,`compat/taskListStore.ts:300` 与 `compat/openccInit.ts:220/322/365` 走的是 `process.env.ZAI_DATA_DIR || join(homedir(), '.zai')` 形态,**有 env fallback**,在同一 env 下行为正确。修复时以这些已迁移的兄弟点为模板,差异一目了然。

- **复现步骤**(E1 不适用;若裁判要转成 E3,可按下述静态判据复核):在设了 `ZAI_DATA_DIR` 的前提下,`grep -rn "homedir()" packages/zai/src/server/services/repl/` → 唯一命中 `ReplHistoryService.ts:163`;`grep -rn "resolveZaiDir" packages/zai/src | grep -v test` → 命中列表中无 `userLoader.ts`。两条 grep 即完整复现判据。

- **复现命令与输出**:不适用(E1)。相关的 grep 命令与命中数已列在「前置可达性三问」①中,可直接复跑。

- **修复方案**:三处统一改走已有的 `resolveZaiDir()`(`paths.ts:45-47`):
  - `compat/permissions.ts:83` → 参照同包 `taskListStore.ts:300` 的 `process.env.ZAI_DATA_DIR || join(homedir(), '.zai')` 写法(该处注释已说明「core 够不到 zai 的 paths.ts」的结构性约束)。
  - `userLoader.ts:26` → 改成 `join(opts.dataDir, 'commands')`(去掉多套的一层 `.zai`,与 writer `commands/fileStore.ts:11` 对齐),并**删掉或改写 `:27`/`:39-40` 那条指向真实 home 的回落**(它还残留着上游 `.claude`→`.zai` 重命名的痕迹:`:33-34` 的 `cwdClaude` 与 `cwdZai` 拼出的是同一个字符串,`git blame` 指向 2026-08-26 的 `b08ec5a9`,而 `:17-19` 的文档注释仍在描述重命名前的行为)。
  - `ReplHistoryService.ts:162-164` → 改用 `resolveZaiDir()`,并把 `:51` 构造函数的一次性捕获改成每次 append 现算(否则即使改了 `defaultHistoryPath()`,`:170` 的惰性单例也会把「首次使用 REPL 时的 env」永久冻结)。
  - 建议同时把 `manifest.ts:6-11` 那条「静态常量 vs 函数重读」的检查扩到全仓:凡是 `${homedir()}/.zai` 与 `join(homedir(), '.zai')` 两种写法都要 grep,模板串写法会绕开前者(这正是本场 `d66d09f5` 自己 commit message 里警告过的那一类)。

- **不可触发自证**:不适用——但请注意我已如实标注**需要 `ZAI_DATA_DIR`**,默认配置下三条都不构成缺陷。

- **上游对照**:不适用。

---

## 四、汇总表

| ID | 标题 | 严重度 | 证据等级 | 位置 |
|---|---|---|---|---|
| cl-001 | `updateCachedVersion` 覆盖掉 `extractedVersions`,LRU 清理永久失效,解压产物无上限泄漏 | S3 | **E3a** | `packages/zai/src/server/services/manifest.ts:106` |
| cl-002 | `OfflineBuffer.setPort()` 零调用,per-child outbox 隔离从未发生,跨子实例 FIFO 驱逐未投递通知 | S2 | **E3a** | `packages/zai/src/server/services/aaClient/offlineBuffer.ts:69-71`(经 `init.ts:172`) |
| cl-003 | `d66d09f5` 只迁了 `settings.json`,另三个解析器仍硬写 `homedir()/.zai`,`ZAI_DATA_DIR` 隔离在权限模式 / 命令目录 / REPL 历史上失效 | S3 | **E1** | `packages/zn-agent-core/src/compat/permissions.ts:83`;`packages/zai/src/server/services/commands/userLoader.ts:26-27,39-40`;`packages/zai/src/server/services/repl/ReplHistoryService.ts:162-164` |

**共 3 条**:S2×1、S3×2;E3a×2、E1×1。E0 占比 0%(远低于 §6.2 的 50% 红线)。

**发覆盖面自评**:窄。60 分钟预算下我选择每条都做到可复验,而非铺开交 10 条半成品。按 §8 的口径,一条经裁判亲自核实为真的 S2 优于二十条猜测——我的 cl-002 若被裁为 S2/E3a 即 6 分,cl-001 与 cl-003 各 3 分,合计约 12 分,量级偏低但每条都过了 §4.2 的门槛。

---

## 五、不确定与自我否定清单

> 不参与扣分。以下是我**追到一半自己推翻**、或**无法证实**的线索。严禁把这里的 E0 伪装成正式条目。

| 线索 | 位置 | 为什么站不住 / 为什么没能证实 |
|---|---|---|
| `OfflineBuffer.stop()` 不清 `start()` 的 `setInterval`,`initOfflineBuffer` 换单例时旧实例的 1Hz 定时器永久泄漏 | `offlineBuffer.ts:74-84,228-233` | 机制成立(`interval` 是 `start()` 里的局部 `const`,从不保存,`stop()` 只置 flag)。**但我全仓追过 `initOfflineBuffer` 的调用点,只有 `init.ts:172` 一处,`initAaClient()` 由 `server/index.ts:173` 启动时调用一次,生产下不存在两个实例并存** → 危害不可触发,达不到正式条目的门槛。列为改进建议。 |
| `updateCachedVersion` 的 fire-and-forget 与 `detect.ts:268` 的并发写会让 `readManifest` 读到截断文件,`readManifest` 的裸 `catch` 返回空 manifest,整个版本缓存被清空 | `manifest.ts:64-71,79`;`detect.ts:268`;`extractor.ts:139` | 机制上成立(`writeFile` 非原子 + `catch` 吞掉)。**但我没有构造出能稳定复现的时序**,也没有实测。按 §12 铁律不能写成「已复现」。它与 cl-001 同文件但**根因不同**(非原子写 vs 字段覆盖),若 cl-001 按 §4.6 被并入单条,这条也不宜单列。**未验证。** |
| `headlessPermissionBridge` 改用 ALS 后,`permission.ts` 路由用 `pending.sessionId !== claimedSid` 做 409 拦截,若两者命名空间不一致会导致审批永久卡死 | `opencc-src/server/headlessPermissionBridge.ts:93,137`;`routes/permission.ts:52-58` | **追完后退了。** 我核过写入侧:`bridge.sessionId` 来自 `createOpenccRuntime-impl.ts:1154-1156` 的 `input.sessionId`,ALS 侧来自 `routes/agent.ts:1205` 的 `runWithSessionId(cmd.sessionId, ...)` —— **两者都是 zai 的 sid,同一命名空间**,客户端的 `X-Session-Id` 也是。cc-002 的修复是净收益(它顺带修好了 `permissionRegistry.abortAll(reason, sid)` 匹配不上的老问题)。**证伪。** |
| `subagentReport` / `SpawnAgentTool` / `CliAgentTool` 改走 `__zaiSessionIdResolver` seam 后,`parentSessionId` 可能解析到空的 `''` 而非会话 id | `compat/tools/opencc/subagentReport.ts:31-36` | 代码有 `?? ''` 兜底且 `if (!parent) return { delivered: false }`,不会投错会话。cc-002 的注释已声明与既有行为在单会话下不变。**未发现新缺陷,放弃。** |
| `routes/agent.ts` 的 `deletedSessions` 只在 DELETE 路由 arm;若存在别的会话删除路径,core 侧会 arm 而 zai 侧不会,wb-011 的调度端守卫就只堵了一半 | `routes/agent.ts:2286`(arm)vs `compat/runtime/legacyTranscriptStore.ts:525`、`opencc-src/server/sessionFacade-impl.ts:300` | **追完后退了。** `grep -rn "store\.remove" packages/zai/src`(排除测试)只有 DELETE 路由一处;另一个 `markSessionDeleted` 调用点 `sessionFacade-impl.ts:300` 位于 `removeSession`,而 `sessionFacade` 在 `packages/zai/src` 下**零调用点**(`index.ts:68-69` 与 `agentRuntime.ts:32-33` 的注释都明写了这一点)。**当前无第二条删除路径,守卫是完整的。** |
| `emitQueueChanged(sid)` 在会话已删后仍向该 sid 推 SSE 事件 | `routes/agent.ts:1056-1059` | 只会推一个空队列快照给一个已经不存在的会话,无消费者、无副作用。**证伪。** |
| vendor 侧 `permissions/filesystem.ts` 的 `~/.zai/projects` 权限围栏与 `~/.zai/skills` 白名单,未跟随 `envUtils.ts:20` 已 env 化的写入根迁移 | `opencc-src/utils/permissions/filesystem.ts:126,321`;`opencc-src/utils/envUtils.ts:16-24` | 机制成立(写侧认 `ZAI_DATA_DIR`,读/围栏侧仍硬写 `homedir()`)。**但我没有把 `getProjectsDir()` 的每一个消费者追到 memory writer**,无法确认 auto-memory 的审批豁免真的失效;且与 cl-003 同根因族。**未验证,不单列。** |
| vendor `daemon/roster.ts` / `daemon.ts` / `socket.ts` 等把 `~/.zai` 硬编码在模块顶层 `const` | `opencc-src/utils/daemon/roster.ts:29` 等 | 成立,但入口是 `opencc daemon` **CLI**,不是 zai 服务;且与 cl-003 同根因族。**未验证危害面。** |
| `aaClient` 全链路(`reverseDispatch` / `eventAdapter` / `offlineBuffer`)的交叉印证 | `aaClient/*.ts` | 时间预算内只深挖了 `offlineBuffer` + `noticeStore`,`reverseDispatch.ts:2029-2061` 的 notice 生命周期读了但没追完。**未覆盖,如实列出。** |
| 前端 `useAgentStore` session 切换 | `web/src/store/useAgentStore.ts`(5dedfe4d 有改动) | 按 §3.2 第 7 条,要判前端缺陷必须真实浏览器渲染;本场未起浏览器。**主动放弃,不是查过没问题。** |

**我明确没有做的事**(供裁判核对铁律):
- 未阅读 `docs/bugs/bug-hunt-game-10-16/` 下任何 `bug-hunt-*.md` 与 `hunt-review-*.md`(环节一铁律 6)。也未阅读上届的 `VERDICT.md` / `FIX-PLAN.md`——本场用不上。
- 未运行 `pnpm -r test`。本报告无任何依赖全量测试的证据。
- 未启动任何 zai 服务实例,**未绑定任何端口,未触碰 9201,未执行任何 kill**。
- 未对仓库任何既有文件做 Edit/Write/删除;未执行任何 git 写操作;临时文件全部在 `/tmp/bughunt-claude/`(注:该目录下 14:41–14:47 时间戳的文件属另一位选手,我未打开、未使用)。

---

## 六、给裁判的一句话

本场我只交 3 条,不比覆盖面,比每条能不能被你亲自打开 `file:line` 复验:cl-001 是同一模块内三个写点两种写法导致的字段覆盖(有机器可证的对照组,对照组恰好证明嫌疑收敛到一个函数),cl-002 是一句注释承诺的隔离机制写了却从没被调用过(`setPort` 全仓零调用,连用户真实 `~/.zai/aa/` 里只有 `outbox-0.jsonl` 一个文件都是旁证),cl-003 是上一届那个数据目录迁移只做了 `settings.json` 一条、另外三个解析器漏网——三条全部来自 §8 点名的「新代码没人扫过」与「跨模块契约不一致」两片,两条 E3a 一条 E1,且三条我都明确写清了各自的前置可达性(其中 cl-002 需要 `--aa`、cl-003 需要 `ZAI_DATA_DIR`,我都没有含糊过去)。
