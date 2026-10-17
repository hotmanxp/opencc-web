# 跑场手册 · bug-hunt-game-10-17（裁判视角）

> 给**裁判 / 赛场主人**（本场是 zai 自己）看的。选手读 [`README.md`](./README.md)。
> 本场只有 2 位选手，用 **CliAgent** 拉起（`subagent_type: opencc` / `claude`），各自独立进程、无继承上下文。

---

## 一、开赛前基线（裁判 2026-10-17 实测）

| 项 | 值 |
|---|---|
| HEAD | `31fca1d2`（`main`，工作树干净） |
| Node | `v22.22.3` |
| `pnpm --filter @zn-ai/zai run typecheck` | **exit 0**，0 条 `error TS` |
| `pnpm --filter @zn-ai/zn-agent-core run typecheck` | **exit 0**，0 条 `error TS`（含 `[verify-server-types] OK — 5 d.ts file(s) self-contained`） |
| 上一届已知清单存活率 | 22 条里 7 条仍需动手（对账文档：15 修 / 2 部分 / 5 成立） |
| 上一届 23 条待修在本基线下的状态 | 22 条已修；**仅 `wb-010`**（`WebFetchTool/utils.ts:304-306` 裸 fetch 绕过 SSRF 守卫）实测仍未修 |

**基线核对方法（留给日后复现）**：`git log --oneline 6f9ceaeb..HEAD -- <文件>` 看是否被修过 —— 上届 19 个缺陷文件里有 17 个能被这条命令筛掉，另外 6 个要靠关键行复查（`cc-002` 是在**消费端** `headlessPermissionBridge.ts:93` 改的，`createOpenccRuntime-impl.ts` 本身没动，只查生产者会误判成「未修」）。

---

## 二、环节一：起选手

两个 CliAgent，**提示词只有第一行不同**，其余完全相同——不给任何一家差异化线索。

```
读 /Users/ethan/code/opencc-web/docs/bugs/bug-hunt-game-10-17/README.md 全文，它是本场规则，你必须逐条遵守。你参赛名叫 <opencc|claude>，bug ID 前缀 <oc-|cl->，评审期新发现前缀 <oc-r|cl-r>。现在执行环节一（自主发掘）：先按 §3.3 做基线快照，然后按 §4 挖缺陷，最终把报告写到 docs/bugs/bug-hunt-game-10-17/bug-hunt-<名字>.md（结构照 TEMPLATE-bug-hunt.md）。写完即结束，不要等待任何信号。环节一期间禁止阅读对方的 bug-hunt 报告，也禁止读 docs/bugs/bug-hunt-game-10-16/ 下的任何 bug-hunt-*.md 与 hunt-review-*.md（那是上一届的，只能读 VERDICT.md / FIX-PLAN.md 做避坑参考）。时间预算 60 分钟，时间不够时宁可少交几条也要保证每条证据经得起复验。
```

**开场前必须确认的事**：

1. 裁判自己的进程不碰选手的数据目录。选手用 `/tmp/bughunt-<名字>/`，裁判用 `/tmp/bughunt-10-17/referee/`。
2. 9201 端口上的正式实例保持运行，选手被禁止触碰（铁律 11）。
3. `~/.zai/` 不写。裁判复核时若起实例，**必须** `ZAI_DATA_DIR` 隔离 —— 但记住上届实测：设了隔离变量仍可能写用户真实 settings.json（`oc-001`），所以裁判起实例前先确认要跑的代码路径。

---

## 三、环节一收口

两阶段之间由裁判统一宣布「环节一结束」。收齐后裁判自查：

- [ ] 4 份文档（2 份报告）齐全，ID 无撞号，汇总表条数与正文一致
- [ ] `git status --porcelain` 只多出 `docs/bugs/bug-hunt-game-10-17/` 下的文件
- [ ] `~/.zai/settings.json` 的 mtime 未变（选手未隔离就写盘的检测点）
- [ ] 每条 E1 是否答完 §4.2.1 三问 —— 裁判要**自己独立判断**,不能只抄「答了/没答」

---

## 四、环节二：起评审

同一个 CliAgent 另起一次（新进程、无记忆，这样它必须真的去读对方报告而不是凭印象）：

```
环节二开始。现在可以读 docs/bugs/bug-hunt-game-10-17/bug-hunt-<对方名字>.md，对对方的每一条逐一裁决（枚举见 README §5.2）。至少抽验 3 条并写下你做了什么；「评审中额外发现」与「交叉洞察」两节都是硬性的，各自至少 1 条；注意两栏互斥、同一事实只在一栏计分。另：认真核查对方每条 E1 的前置可达性三问（§4.2.1）是否答完，答不完的要明确指出来。完成后写到 docs/bugs/bug-hunt-game-10-17/hunt-review-<你的名字>.md（结构照 TEMPLATE-hunt-review.md），写完即结束，不要等待任何信号。时间预算 30 分钟。
```

---

## 五、环节三：裁判清单

1. 收齐 2 份 `hunt-review-*.md`，核对裁决是否逐条覆盖
2. 把每条按模块簇并行复核，逐条给出 `file:line` 铁证；**抽验选手引用的行号**
3. 独立重跑每条「不可触发」的自证（README §4.2）
4. 对 §3.4 的 A/B/C 三组做交集判定，命中项记 `KNOWN` 双零 —— **以当前源码为准，不由清单文档的说法决定**
5. 裁判自己的复核脚本**也要贴对照组输出**（§4.7）
6. 按 §6.2 的判定表逐条判「一致/不一致」，再算分
7. 出 `VERDICT.md` → `ANNOUNCEMENT.md`（各含一张裁定卡）
8. 如有错判 → `ERRETA.md`，并**同步更新** `ANNOUNCEMENT.md` 的分数表

**裁判本场的额外负担**（上一届的教训）：两个包 16 条修复刚落盘，本场报上来的条目有相当概率是「修复引入的新缺陷」或「修复只堵了一半」。这类条目裁判必须**同时看 diff 与现行源码**，不能只看现行源码的单点逻辑。
