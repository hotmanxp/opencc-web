# 开赛指引 · bug-hunt-game-10-16

> 给**赛场主人**(用户)看的。选手不需要读这一份——他们读 [`README.md`](./README.md)。
> 目标:你在 4 个终端里各起一个 CLI,把下面四段提示词分别粘进去,比赛就开始了。

---

## 一、开赛前检查清单

| # | 检查项 | 状态 |
|:-:|---|---|
| 1 | 工作树干净（`git -C /Users/ethan/code/opencc-web status --porcelain` 的输出**只含** `docs/bugs/bug-hunt-game-10-16/`） | ✅ 开局实测为空，脚手架落盘后只会多出本目录 |
| 1b | 想让工作树彻底干净就先提交脚手架（`git add docs/bugs/bug-hunt-game-10-16 && git commit`），否则按 README §1 的豁免口径判定 | 可选 |
| 2 | typecheck 基线已钉死（两个包 exit 0） | ✅ 裁判 2026-10-16 实测 |
| 3 | 依赖已装、`packages/*/dist/` 已构建 | ✅ |
| 4 | 9201 端口上的正式实例**保持运行**（你的 zai）——选手不会也不该动它 | 选手侧铁律 11 |
| 5 | 你的 `~/.zai/` 已确认完好（比赛期间选手被禁止写入） | 选手侧铁律 10 |

## 二、起选手

四个终端，四段提示词。**只有第一行不同**，其余完全相同——不要给任何一家差异化线索。

```
# 终端 1（claude-code）
cd /Users/ethan/code/opencc-web && 读 docs/bugs/bug-hunt-game-10-16/README.md，你参赛名叫 claude-code，bug ID 前缀 cc-。按规则执行环节一（自主发掘），完成后把报告写到 docs/bugs/bug-hunt-game-10-16/bug-hunt-claude-code.md，等我宣布「环节一结束」。期间不要读其他选手的报告。

# 终端 2（opencc）
cd /Users/ethan/code/opencc-web && 读 docs/bugs/bug-hunt-game-10-16/README.md，你参赛名叫 opencc，bug ID 前缀 oc-。按规则执行环节一（自主发掘），完成后把报告写到 docs/bugs/bug-hunt-game-10-16/bug-hunt-opencc.md，等我宣布「环节一结束」。期间不要读其他选手的报告。

# 终端 3（trae-code）
cd /Users/ethan/code/opencc-web && 读 docs/bugs/bug-hunt-game-10-16/README.md，你参赛名叫 trae-code，bug ID 前缀 tc-。按规则执行环节一（自主发掘），完成后把报告写到 docs/bugs/bug-hunt-game-10-16/bug-hunt-trae-code.md，等我宣布「环节一结束」。期间不要读其他选手的报告。

# 终端 4（workbuddy）
cd /Users/ethan/code/opencc-web && 读 docs/bugs/bug-hunt-game-10-16/README.md，你参赛名叫 workbuddy，bug ID 前缀 wb-。按规则执行环节一（自主发掘），完成后把报告写到 docs/bugs/bug-hunt-game-10-16/bug-hunt-workbuddy.md，等我宣布「环节一结束」。期间不要读其他选手的报告。
```

## 三、叫停话术

环节一收口时，对四个终端说同一句：

```
环节一结束。停止一切新的源码探索，只允许把已在手上的证据整理成文档，10 分钟内提交完毕。
```

环节一收齐后开启环节二，对四个终端说：

```
环节二开始。现在可以读另外三位选手的 bug-hunt-*.md，逐一裁决（枚举见 README §5.2）。
至少抽验 3 条并写下你做了什么；「评审中额外发现」与「交叉洞察」两节都是硬性的。
完成后写到 docs/bugs/bug-hunt-game-10-16/hunt-review-<你的名字>.md，等我宣布「环节二结束」。
```

环节二收齐后：

```
环节二结束。裁判（Claude / zai）开始逐条复核并出 VERDICT.md 与 ANNOUNCEMENT.md。
```

## 四、裁判（Claude / zai）执行清单

1. 收齐 4 份 `bug-hunt-*.md`，核对 ID 唯一性、汇总表与正文的条数是否一致
2. 把每条按模块簇并行复核，逐条给出 `file:line` 铁证；抽验选手引用的行号
3. 独立重跑每条「不可触发」的自证（README §4.2）
4. 对 `docs/bugs/` 22 条已知清单做交集判定，命中项记 `KNOWN` 双零
5. 自己的复核脚本**也要贴对照组输出**（README §4.7，裁判同样受约束）
6. 出 `VERDICT.md` → `ANNOUNCEMENT.md`（含四张裁定卡）
7. 修复阶段结束后出 `ERRETA.md`，并**同步更新公告的分数表**（README §6.5）
