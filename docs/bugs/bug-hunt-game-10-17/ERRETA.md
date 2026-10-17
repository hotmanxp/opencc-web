# ERRETA · 对 `bug-hunt-game-10-16` 修复战役的勘误

> 裁判 = zai · 2026-10-17
> 本场(`bug-hunt-game-10-17`)在复核中推翻了两条**上一届已裁定为「已修」**的结论。
> 按 `bug-hunt-game-10-17/README.md` §6.4:勘误必须写明**原判 → 新判 → 触发新证据的那次复核 → 分数与排名的连带影响**。

---

## 一、原判 → 新判

| # | 上一届的裁定 | 新判 | 严重度 |
|---|---|---|---|
| 1 | `oc-001`(S1/E3b)「**已修**」· 修复提交 `d66d09f5` | **未修完** —— 声称的「收口全部调用点」没有发生 | S1 → **部分残留仍可达** |
| 2 | `wb-004`(S2/E3a)「**已修**」· 修复提交 `5dedfe4d` | **未修完** —— 修复只覆盖 `doStop`,漏了唯一不经过 `doStop` 的 `doRemove` | S2 → **S3(残留)** |

---

## 二、触发新证据的那次复核

### 勘误 1 · 数据目录「一次收口」没有发生

**原判依据**:`d66d09f5` 的 commit message 白纸黑字——

> 「新增 resolveZaiDir() 单一入口,**收口 9 处调用点**」

`FIX-PLAN.md` 批 2 的标题与正文——

> 「批 2 · 数据目录解析收敛(3 条 · S1×2 + S3 · **一次收口**）」
> 「**收口全部调用点。清单是 11 处,不是 8 处**」

**新判依据**:本场选手 claude 的 `cl-003`,裁判 2026-10-17 逐行复核后确认——**至少 3 处解析器原封不动**:

| 位置 | 形态 | 复核结果 |
|---|---|---|
| `packages/zn-agent-core/src/compat/permissions.ts:83` | `join(homedir(), '.zai', 'settings.json')`,不读 `ZAI_DATA_DIR`;`:95-99` catch **函数体为空** | 逐字核实 ✓ |
| `packages/zai/src/server/services/commands/userLoader.ts:26` / `:28` / `:39-40` | reader 拼 `join(opts.dataDir, '.zai', 'commands')`;`:28` 的 `homeClaudeDir` **无条件指向真实 home**;`:39-40` `existsSync` 失败即回落真实 home | 逐字核实 ✓ |
| `packages/zai/src/server/services/repl/ReplHistoryService.ts:162-164` | `` `${homedir()}/.zai/repl-history.jsonl` `` **模板串,绕开 `join(homedir(), '.zai'` 的 grep 特征**;`:51` 构造函数一次性捕获 | 逐字核实 ✓ |

**最刺眼的一处**:写侧 `commands/fileStore.ts:8-11` 的注释明写

> `zai patch (2026-10-16, oc-001 收口): 改走 resolveZaiDir(),否则设了 ZAI_DATA_DIR 的实例仍读写用户真实 home 下的用户级命令。`

修复**明确声称收口了「用户级命令」这条路径**,却**只迁了写入端** `commandsDir()`。**写 A 读 B**:

- writer:`join(resolveZaiDir(), 'commands')` = `$ZAI_DATA_DIR/commands`
- reader:`join(opts.dataDir, '.zai', 'commands')` = `$ZAI_DATA_DIR/.zai/commands`(不存在)→ 回落真实 `~/.zai/commands`

**后果**:隔离实例刚创建的命令读不到,反而静默继承用户真实的全套全局命令;权限模式的默认判定读错文件(`permissions.ts` 的空 catch 让「读错」与「读到空」行为不可区分);REPL 历史**写入**用户真实 home 并可能 `rotate()` 覆盖其真实 `.1` 文件。

**额外一条(本场裁判发现的残留)**:claude 的评审期发现 `cl-r1` —— `zaiSettingsCache.ts:161` 的 tier-2 **无条件读用户真实 `~/.claude/settings.json`**,`:166` 让它盖过内置默认,`:176` 的 boot 回填再把它**写进**实例目录。这不只是读泄漏,是**把真实 home 的配置内容复制进隔离实例**。

### 勘误 2 · `wb-004` 的修复漏了一条动词

**原判依据**:上一届 `VERDICT.md` 裁定 `wb-004`(`starting` 窗口内 stop/restart 静默 no-op 且返 200)已修,修复提交 `5dedfe4d`。

**新判依据**:本场选手 opencc 的 `oc-001`,裁判逐行复核——

```ts
// instanceSupervisor.ts:548-549(在 doStop 内部,上一届新增)
const pending = inFlightStarts.get(id)
if (pending) await pending.catch(() => {})
```

**这道 in-flight 闸只写在 `doStop` 里。** 而 `doRemove:578-589` 的删除路径是:

```ts
const entry = getEntry(id)
if (entry.child) await doStop(id)   // ← :581 child 为 null 时整个 doStop 被跳过
entries.delete(id)                   // ← :582
```

`starting` 窗口内 `entry.child` 恒为 null ⇒ **`doRemove` 一次都不进入 `doStop`** ⇒ 新闸一次都不会被触达 ⇒ 随后的 in-flight `runStart` 把活着的子进程 `attachChild` 到一个**已不在 `entries` 里**的 Entry 上,而 `tickHeartbeat:592` 与 `shutdown():693` **都只遍历 `entries.values()`**,永远看不见它。

同时 `routes/instances.ts:306` 的 `DELETE /instances/:id` **未被** `serializeLifecycle` 包裹(而 `:221`/`:237`/`:260` 三个动词都有)。

**后果**:删除实例返回一个 200,UI 上实例消失,但子进程被 spawn 且从 supervisor 视野彻底脱管。**本场裁判按 S3 裁定**(脱管逃逸是源码字面事实;但 claude 用真 `child_process.spawn` 做的更强复现里,那个真进程 200ms 内收到来源不明的 SIGINT 消失,故「无限期存活」的幅度主张未被证实)。**这不代表上一届判错** —— 上一届的裁定范围明文是「stop/restart」,两条路径本就不同;错的是**把「文件被修复 commit 动过」当成「那条缺陷修完了」**。

---

## 三、分数与排名的连带影响

**`bug-hunt-game-10-16` 的名次不变。** 理由:

1. 本场的两条勘误不改变上一届任何一条声明的**终裁严重度与证据等级** —— 它们改变的是「**已修**」这个**事实判断**,而修复阶段的完成度从来不在计分表里。
2. 本场 `cl-003` 与 `oc-001` 是**本场选手的独立发现**,按双人赛规则照常计分(已在 `VERDICT.md` §一计入 opencc 9.0 / claude 7.5),不因「上一届已知」而双零(§3.4 B/C 组均不含这两条)。
3. 本场名次 **opencc 25.9 > claude 22.7**,与勘误无关。

**需要更正的是三处「状态声明」,不是分数:**

| 位置 | 原文 | 更正为 |
|---|---|---|
| `bug-hunt-game-10-16/FIX-PLAN.md` 批 2 标题 | 「**一次收口**」 | 「**一次收口(未达成:3 处解析器未迁)**」 |
| 修复战役记「已修 16 条」 | 视为 16 条全清 | 其中 **`wb-004` 与 `oc-001` 系部分修复**,应表述为「14 条全清 + 2 条部分修复」 |
| `bug-hunt-game-10-17/README.md` §3.4 B 组 | 「22 条已修;仅 `wb-010` 未修」 | 同上,**`wb-004` 应移出「已修」**,并注明 `oc-001` 系部分修复 |

> ⚠️ 本场赛制文件 `bug-hunt-game-10-17/README.md` 是在**环节一开始前**写的,当时 §3.4 B 组按 `git log --oneline 6f9ceaeb..HEAD -- <文件>` 判定「已修」。**该方法本身有缺陷**:文件被修复 commit 动过 ≠ 那条缺陷修完。oc-001 正是反例(该文件确实被 `5dedfe4d` 改过,缺陷却只修了一半)。这条教训已写进 `VERDICT.md` §oc-001。

---

## 四、给下一届的一条操作性教训

**不要用「文件被修复 commit 动过」推断「那条缺陷已修完」。** 正确做法:

1. 打开**缺陷所在的那几行**,确认修复后的代码**在结构上堵住了原路径**;
2. 检查**同模块的其它动词 / 其它入口**是否也走到了同一处(`doStop` 堵了不等于 `doRemove` 堵了);
3. 若缺陷文档本身给了修法清单,**逐条对着清单核**,而不是对着文件核 —— `d66d09f5` 的问题是「收口 9 处」与实际迁的处数对不上,而清单(`FIX-PLAN` 写的是 11 处)本来就在文档里。
