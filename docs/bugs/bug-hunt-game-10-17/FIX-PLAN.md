# 修复计划 · bug-hunt-game-10-17 产出

> 裁判 = zai · 2026-10-17
> 输入：[`VERDICT.md`](./VERDICT.md)(终裁)· [`ERRETA.md`](./ERRETA.md)(对上一届的勘误)
> 上一届同类文档：[`bug-hunt-game-10-16/FIX-PLAN.md`](../bug-hunt-game-10-16/FIX-PLAN.md)

---

## 零、前置动作(必做,否则后面会白干)

### 0.1 本计划所有 `file:line` 都是**裁判实测过的**,但动手前仍要重开一次

裁定阶段逐条核过一遍是**为了判对错**,不是为了照抄。上一届的教训:`FIX-PLAN.md` 里写的修法与实现细节有多处对不上(cc-005 的 `sh -c` 在 macOS 走 exec 优化压根不 fork;tc-001 的「只删已发送前缀」不够),**必须先实测复现,再照计划改**。

**动任何一条之前先做这三件事:**

1. `git rev-parse HEAD` 记下基线;若 HEAD 已不是 `31fca1d2`,先重跑该条的复现物确认现象还在
2. 读该条的**完整上下文**(不只那一行),确认没有后续修复已经把它改掉
3. 若该条的修复会动到上一届已修的代码,**先看上一届的修复注释**(`file:*.md:8-11` 这类 `zai patch (日期, ID)` 标注是本仓库的惯例)

### 0.2 上一届的老债仍在:本场**不包含** `wb-010`

`wb-010`(`WebFetchTool/utils.ts:304-306` 超时 fallback 裸 `fetch` 绕过 SSRF 守卫)是上一届 23 条待修里**唯一从未被修过**的,裁判 2026-10-17 复核仍然成立:

```ts
if (isTimeoutLike && !signal.aborted) {
  const fetchResponse = await fetch(url, { signal, redirect: 'manual', headers: axiosConfig.headers })
```

它不在本场 7 条里,本计划**默认不动它**。但它是本仓库**唯一一条已知 SSRF**,而 `7c32e4da` 之后网络面又扩了(AA 通道)。**建议单列一次修复,不要继续挂。**

### 0.3 本场 7 条里有 2 条是上一届修复的残留

`oc-001` 与 `cl-003` 的真实来历写在 `ERRETA.md`。**这意味着修它们不是「新加功能」,而是「把上一届说已修的修完」**——验收标准要按「承诺兑现」而非「新功能可用」来定。

---

## 一、总表:7 条待修缺陷

按**根因簇**分组,不按严重度排(理由见 §三)。

| ID | 终裁 | 位置 | 一句话 | 簇 |
|---|---|---|---|---|
| **oc-002** | **S2/E3b** | `superTasks.ts:90` ↔ `factorySettings.ts:65` ↔ `FactorySettingsDrawer.tsx:307` | 新增的 `claude` provider 不在 `preferCliAgent` 枚举内,UI 照给、zod 拒收,保存必 400 且粘住 | A 契约不一致 |
| **cl-003** | **S3/E1** | `compat/permissions.ts:83` · `commands/userLoader.ts:26-28,39-40` · `ReplHistoryService.ts:162-164` | `d66d09f5` 声称「一次收口」,实际三处解析器仍硬写 `homedir()/.zai` | B 数据目录 |
| **cl-r1** | **S3/E3b** | `zaiSettingsCache.ts:161,166,174-176` | tier-2 无条件读真实 `~/.claude/settings.json`,并被 boot 回填写进实例目录 | B 数据目录 |
| **oc-001** | **S3/E3a** | `instanceSupervisor.ts:581`(+`routes/instances.ts:306`) | `starting` 窗口内 DELETE 跳过 `doStop`,子进程从 supervisor 脱管 | C 生命周期 |
| **oc-r1** | **S2/E2** | `manifest.ts:79` + `:64-71` | 非原子写 + 裸 catch,撕裂读 → 空 manifest → 下次写回整份清空 | D 数据完整性 |
| **cl-001** | **S3/E3a** | `manifest.ts:106` | `updateCachedVersion` 覆盖掉 `extractedVersions`,LRU prune 永久失效 | D 数据完整性 |
| **cl-002** | **S3/E3a** | `offlineBuffer.ts:69-71`(经 `init.ts:172`) | `setPort()` 全仓零调用,per-child outbox 隔离从未发生 | E AA 远端通道 |

**去重后 5 个根因簇。** 簇 B 跨 `packages/zai` 与 `packages/zn-agent-core` 两个包,**只改一个象限不完整**(上一届踩过)。

---

## 二、五个簇的修法方向(全部标注「需实测验证」)

> ⚠️ 以下是**方向**,不是可直接照抄的补丁。上一届 3 条修法因与实现对不上而返工。**每条动手前先按 §0.1 实测。**

### 簇 A · 契约不一致(oc-002,S2)

**问题**:`CLI_AGENT_NAMES` 有 4 个值,`preferCliAgent` 的 zod 枚举只有 3 个。前端 `:307` 的 `as` cast 把编译期检查关掉,于是运行期 400。

**裁判复核过的关键事实**:取值域全仓是 **6 处**,不是作者说的 5 处 —— 漏了 vendor 侧 `zn-agent-core/src/opencc-src/server/factorySettingsCore.ts:20,53-57`。

**修法方向(二选一,倾向 A)**:
- **A(治本)** 把 `claude` 加进全部 6 处取值域。理由:`7c32e4da` 已把 `claude` 做成正式 provider,**只有枚举不认它才是异常的一方**。**必须含 vendor 侧那 1 处**,否则下次加 provider 会重犯。
- **B(若 `preferCliAgent` 语义上确实只支持那 3 个)** 前端 `:308-312` 的 `options` 过滤成 schema 接受的子集 + **删掉 `:307` 的 `as` cast**(让类型系统重新生效)+ `:134` 改成与其他三项一致的条件展开 + `catch` 里回滚 `draft`。

**无论 A 还是 B,都必须修 `:307` 的 cast 或让它不再需要。** `as` cast 是这条缺陷能一路绿灯通过 typecheck 的唯一原因。

**需实测**:起隔离实例打真实端点,断言 `preferCliAgent=claude` 返回 200 且落盘值正确。

---

### 簇 B · 数据目录隔离(cl-003 + cl-r1,跨两包,S3 ×2 但风险最高)

**这一簇是本场最该先做的** —— 它不是性能问题,是**隔离机制失效 + 向用户真实 home 写入**。

**问题清单(裁判逐行核实)**:

| # | 位置 | 形态 |
|---|---|---|
| 1 | `compat/permissions.ts:83` | `join(homedir(), '.zai', 'settings.json')`;`:95-99` catch **函数体为空** → 读错路径与读到空**行为不可区分** |
| 2 | `commands/userLoader.ts:26` | reader 拼 `join(opts.dataDir, '.zai', 'commands')` —— **多套一层 `.zai`** |
| 3 | `commands/userLoader.ts:28,39-40` | `homeClaudeDir` **无条件指向真实 home**;`:39-40` `existsSync` 失败即回落 |
| 4 | `ReplHistoryService.ts:162-164` | `` `${homedir()}/.zai/repl-history.jsonl` `` **模板串,绕开 `join(homedir(), '.zai'` 这个 grep 特征**;`:51` 构造函数一次性捕获 |
| 5 | `zaiSettingsCache.ts:161,166` | tier-2 **无条件读真实 `~/.claude/settings.json`**,`:166` 让它盖过内置默认 |
| 6 | `zaiSettingsCache.ts:174-176` | boot 回填把它**写进**实例目录 → **不是读泄漏,是把真实 home 的配置复制进隔离实例** |

**writer/reader 分裂(问题 2 的根源)**:
- writer `commands/fileStore.ts:8-11`(注释明写「oc-001 收口」)→ `join(resolveZaiDir(), 'commands')` = `$ZAI_DATA_DIR/commands`
- reader `commands/userLoader.ts:26` → `$ZAI_DATA_DIR/.zai/commands`(不存在)→ 回落真实 `~/.zai/commands`

**修法方向**:
- 问题 1 / 4:改走已有的 `resolveZaiDir()`。`compat/permissions.ts` 在 `zn-agent-core` 包内,**够不到 zai 的 `paths.ts`** —— 这是**结构性约束不是疏忽**(同包 `compat/taskListStore.ts:300` 的注释已写明),照它的 `process.env.ZAI_DATA_DIR || join(homedir(), '.zai')` 形态写
- 问题 2 / 3:reader 与 writer 对齐到 `join(resolveZaiDir(), 'commands')`,并**删掉或改写**指向真实 home 的回落分支。**顺手清掉 `:33-36` 的死代码** —— `cwdClaude` 与 `cwdZai` 拼出完全相同的字符串(`git blame` → 2026-08-26 `b08ec5a9`),两个 `existsSync` 判同一个目录,是上游 `.claude`→`.zai` 重命名的遗留
- 问题 4 附带:`:51` 构造函数一次性捕获 `this.historyPath` 的模式会让「首次使用 REPL 时的 env」永久冻结,即使改了 `defaultHistoryPath()` 也救不回来 —— **要么改成每次现算,要么确保 env 在构造前已定**
- 问题 5 / 6:tier-2 读取要感知隔离。**注意这条不能简单删掉 tier-2** —— 它是「`~/.zai` 缺失时从 `~/.claude` 迁移」的产品特性。**要改成「tier-2 也走 `resolveZaiDir()` 语义」**,并让 boot 回填的写入目标与读取来源一致

**验收(照上一届的哨兵实验,不能省)**:
重定向 `HOME` 到临时目录 + 植入哨兵值 + 设 `ZAI_DATA_DIR`,起真实例,断言:
- `GET /api/agent/settings` 返回**内置默认**而非哨兵值
- `GET /api/commands` 的来源目录在 `$ZAI_DATA_DIR` 下
- boot 后 `$ZAI_DATA_DIR` 出现 settings.json,而**假 HOME 的 mtime 不变**
- REPL 执行一次后,`$ZAI_DATA_DIR/repl-history.jsonl` 出现、真实 home 的**不出现**

**需实测**:上述每一条都要真跑,不能只靠 grep 特征消失。

---

### 簇 C · 实例生命周期(oc-001,S3)

**问题**:`doRemove:581` 的 `if (entry.child)` 在 `starting` 窗口内为假 → 跳过 `doStop` → `:582` `entries.delete(id)` → in-flight `runStart` 照常 `spawn` 并 `attachChild` 到一个**已不在 `entries` 里**的 Entry → `tickHeartbeat:592` 与 `shutdown():693` **都只遍历 `entries.values()`**,永远看不见它。

**上一届已加的闸在哪**:`instanceSupervisor.ts:548-549` 的 `inFlightStarts` 排队**只写在 `doStop` 内部**,`doRemove` 一次都进不去。

**修法方向(三层,建议全做)**:
1. **主修** `doRemove` 先排队再决定,与 `doStop` 对齐:
   ```ts
   const pending = inFlightStarts.get(id)
   if (pending) await pending.catch(() => {})
   const entry = getEntry(id)
   if (entry.child) await doStop(id)
   entries.delete(id)
   ```
2. **加固(防御纵深)** `attachChild` 开头加断言 —— 若 `!entries.has(entry.def.id)` 立即杀掉刚 spawn 的 child 并抛。**这条能挡住将来任何新调用方重犯**
3. **顺带** `routes/instances.ts:306` 的 DELETE 也包进 `serializeLifecycle`(与 `:221`/`:237`/`:260` 三个动词对齐)

**副作用注意**:主修会让「窗口内删除」最多等到 start 结束(一次端口探测),比现在「立即返回但留下孤儿」慢一点,但语义正确。

**需实测**:照 opencc 的三场景对照(`remove` / `stop` / `norace`)跑一遍,`remove` 必须从 `killed=[false]` 变成 `true`。**注意他的复现物要一场景一进程** —— `initInstanceSupervisor` 装的是模块级单例,同进程跑三个场景会污染对照组。

---

### 簇 D · manifest 数据完整性(oc-r1 + cl-001,同一文件,S2 + S3)

**两条缺陷在同一个文件,一次做对,别分两批。**

**oc-r1**:`:79` 裸 `writeFile` 非原子 + `:64-71` 裸 catch 返回空 manifest → 读撞上写中间态 → JSON 撕裂 → catch 吞掉 → 下一次写在空对象上赋值写回 → **整份 manifest 被清空**

**cl-001**:`:106-109` `manifest.packages[pkg] = { latestVersion, cachedAt }` 无 `...existing` 展开,抹掉 `extractedVersions`;而同模块 `:132-135` 与 `:156` 两处**都有**展开。三点补充:
- `detect.ts:268` 的 fire-and-forget 意味着**任何一次 `npm view`** 都会抹掉索引,不只是插件升级
- `extractor.ts:154-162` `getCachedExtraction()` 的 `:159` 也读这个字段 → 索引被抹后**缓存查找恒未命中**,每次都重新解压
- `extractor.ts:139` 是 fire-and-forget(未 `await`),与 `:142` 的 prune 无序 —— **两种交错都导致字段被抹**

**修法方向**:
- `:106` 与另两个写点对齐,补 `...existing`(三处写法统一后建议抽一个 `updateEntry(pkg, patch)` 收敛)
- `:79` 改走 `atomicWriteFile`。**本仓库已有这个工具**(`d66d09f5` 已在 `fileStore.ts:110/157`、`zaiSettingsStore.ts:100` 用过),照抄调用形态即可
- `:64-71` 的裸 catch **至少要把「读失败」与「文件不存在」分开**:当前把撕裂读当成「没有 manifest」返回空对象,是 oc-r1 会「整份清空」而不是「这次读不到」的直接原因。**更稳的做法是损坏时抛错或返回明确标记,让写回路径不会拿空对象覆盖**

**需实测**:构造撕裂态跑一遍(oc-r1 的复现物可直接参考 `/tmp/bughunt-opencc/oc-new-manifest-loss.mts`),以及 4 次升级的 prune 计数(对照组的数学期望是「4 个版本 keep=3 → drop 恰好 1」)。

---

### 簇 E · AA outbox per-child 隔离(cl-002,S3)

**问题**:`offlineBuffer.ts:69-71` 的 `setPort()` **全仓零调用**(其余 6 处 grep 命中全是 `Instances.tsx` 里 React 的 `setPort`/`setPortEditRow`),生产在 `init.ts:172` 传字面量 `0`。而 `:489-490` 的 `childEnv = { ...process.env, ... }` 说明**子实例继承父进程全部 env**,故所有 zai 进程解析到**同一个** `outbox-0.jsonl`。`enforceSizeCap:197-223` 的 FIFO 截断**无 child 归属概念**。

**三层门(裁判复核)**:① `--aa` flag → ② `ZAI_AA_ENABLED==='1'`(`cli/index.ts:68/90` 是生产唯一写入点)→ ③ **必须已 pairing**(否则 `init.ts:119-126` 早退,buffer 压根不创建)。

**修法方向(二选一)**:
- **A(治本)** 真正实现 `:14-16` 承诺的语义:在子实例注册回调里调 `setPort(该子实例端口)`,或按 payload 归属分桶写多文件
- **B(最小)** 承认 outbox 暂为全局单文件:改 `:14-16` 的注释,并把 `enforceSizeCap` 的丢弃策略从「无差别丢最老」改成**按 child 归属分组保留**

**这一条本场判 S3 而非 S2 的原因**:默认 50MB 上限(`:32-33`),最重的 `timeline.itemUpsert` 单条 1733 字节,需 **~3 万条**积压才触发第一次驱逐。所以**不是紧急项,排最后**。

**需实测**:要么构造 ≥2 子实例 + 撑破 cap,要么退一步只验证「修完之后不同实例写不同文件」。

---

## 三、建议执行顺序

**排序依据不是严重度,是「一次收口能收掉几条」+「验证成本」**:

| 批 | 内容 | 条数 | 为什么这个顺序 |
|---|---|---|---|
| **批 1** | 簇 B(数据目录隔离) | 2 | **风险最高**(向用户真实 home 写入)+ 一次收口 2 条 + **上一届说已修但没修完**。验收要用哨兵实验,成本最高,放最前面拿完整时间 |
| **批 2** | 簇 D(manifest 完整性) | 2 | 同一文件、互相纠缠,一次做对;oc-r1 是 S2 |
| **批 3** | 簇 A(契约不一致) | 1 | S2,且是 `7c32e4da` 引入的**新特性走不通**,用户可感知;改动面小、验证便宜 |
| **批 4** | 簇 C(实例生命周期) | 1 | 有上一届的现成复现物可复用;但要小心别与上一届已修的 `doStop` 打架 |
| **批 5** | 簇 E(AA outbox) | 1 | 三层门,离默认用户最远,放最后 |

**每批一个独立 commit**,不要混。上届的教训是修复裹进无关 commit 后按 commit 追溯找不到归属。

---

## 四、验收纪律

1. **每条动手前先实测复现**(§0.1)。修法与实现对不上是上一届最贵的返工。
2. **每批修完跑**:两个包 typecheck(基线 `31fca1d2` 均为 exit 0)+ 该条相关的单文件测试。**不跑全量**(`pnpm -r test` 520+ 文件 / 4.5 分钟,AGENTS.md 明令禁止),且全量跑出来的红一律不算数。
3. **簇 B 必须跑哨兵实验**(§二),不能只看 grep 特征消失 —— **模板串写法会绕开 `join(homedir(), '.zai'` 的 grep**,上一届 `tc-002` 就是这么漏网的。
4. **修完把本文件勾掉**,并在 `VERDICT.md` 记一条「哪些条目已修 / 哪些仍归档」。
5. **修复阶段结束后出 `ERRETA.md`**(若终裁有变更),并同步更新 `ANNOUNCEMENT.md` 的分数表。

---

## 五、三条不该丢的观察

### 1. 本场 7 条里有 3 条来自「修复本身」

`oc-001`(上届 `5dedfe4d` 漏了 `doRemove`)、`oc-002`(`7c32e4da` 加 provider 漏了 zod 枚举)、`cl-003`(`d66d09f5` 声称一次收口实际漏三处)。**修复引入/遗漏的缺陷是本仓库当下最高产的缺陷面**,而它不在任何静态审计的覆盖范围内 —— 静态审计扫的是「当前长什么样的代码」,而这一类要扫「上一版改了什么」。

### 2. 「承诺」本身是一等线索

`d66d09f5` 写「收口 9 处调用点」、`FIX-PLAN` 批 2 写「一次收口」、`5dedfe4d` 把闸加在 `doStop` —— **这些具体到数字的承诺,比任何模糊注释都更值得逐条核**。承诺越具体,验起来越便宜,而且落空时证据越硬。

### 3. 两条缺陷是「跨模块契约不一致」,不是单点 bug

簇 A(前端类型 / zod 枚举 / provider 白名单 / vendor 侧副本 = 6 处取值域)和簇 B(writer 迁了 reader 没迁)都是同一个形状:**同一个取值域或同一个路径被抄在多处,改了其中一处**。

**建议当架构约束处理**:新增 provider 名或数据目录解析器时,取值域应当**从一个源头派生**,不允许手抄第 N 份。否则每次加 provider 都要重犯。
