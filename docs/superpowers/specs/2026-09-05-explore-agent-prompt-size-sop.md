# Explore Agent 派单 Prompt 收敛 SOP

> **zai supervisor · 派单 SOP**(2026-09-05)
>
> supervisor 给 Explore 类型子代理写 prompt 时遵守本文档的「小 scope + 短 prompt」原则,避免 Anthropic API 400 `invalid params, context window exceeds limit (2013)`。

## 1. 背景

2026-09-05 supervisor 派 Explore 子代理做「opencc-web 集成现状 + 前端 explore」时,**首次派单** prompt 写了 6 大段完整说明 + 完整 JSON 输出字段定义(包含每个字段的类型、约束、示例)。prompt token 数估算 ~2500-3000,加上系统提示词 / 工具描述 / 历史后,**整体 context 触发 Anthropic API 400**(`invalid params, context window exceeds limit (2013)`)。

- 失败 2 次后才意识到是 prompt 自身过大;
- 第三次用「收窄版」重试成功:scope 收窄到 4 个具体目录、输出格式只给「返回 JSON array,每条 1 个发现,带 file:line + evidence + problem + suggested_fix」、禁止段落只保留 2 行(禁 side-effect 命令 + 禁编造证据) → 8 条发现正常返回。
- 这不是模型智商问题,是 prompt 体积问题;Anthropic API 不会因为「prompt 内容正确」就放宽 context window 上限。

**所以**:prompt 收敛是派单方的责任,不是模型的责任。下次派 Explore 默认按本 SOP 起手,失败再二分 scope。

## 2. SOP(派单 Explore 子代理时遵守)

### 2.1 体积预算

- **默认 prompt 目标:≤ 800 tokens**(粗略经验:800 tokens ≈ 600 中文字符 ≈ 2400 英文单词)。
- 第一次派单就按这个预算写;**不要**先写大全版再失败后才发现。

### 2.2 Scope 限制

- 最多 **2-4 个目录**(具体到 `packages/zai/src/web/src/components/...` 这种路径级)。
- 第一次派单不知道哪个目录时,先 `ls` / `Glob` 探查,**不要**写「全仓扫一遍」。
- scope 内可列出关键文件路径作为 hint,但不要列具体函数名 / 行号 —— 让 Explore 自己去探。

### 2.3 输出格式只给「形态说明」,不写完整字段定义

正确写法(收窄版,实测成功):

```
返回 JSON array,每条 1 个发现:
- file:line
- evidence(原文 ≤ 80 字)
- problem(一句话)
- suggested_fix(一句话)
```

错误写法(大全版,触发 400):

```
返回 JSON 数组,每个元素包含以下字段:
- file: string,文件路径(绝对路径)
- line: number,行号(1-based)
- evidence: string,原文片段(≤ 200 字,UTF-8)
- problem: string,问题描述(必须基于 evidence 推导,不允许编造)
- suggested_fix: string,建议修复方案(具体到改动哪一行)
- confidence: 'high' | 'medium' | 'low',...
- category: 'bug' | 'refactor' | 'perf' | 'a11y' | ...
... (以下省略 30 行 zod schema + 示例)
```

**原则**:模型知道 JSON 怎么写,你只告诉它「每条要哪几个 key」+「一句话约束」即可;具体 schema 让模型自己生成。

### 2.4 「禁止」段落 ≤ 2 行

只保留**真正危险**的两条:

```
禁止:跑 side-effect 命令(写文件 / 装依赖 / 启服务);编造 file:line 或 evidence(无法验证的引用)。
```

不要把「禁止用 Read 之外工具」「禁止输出 Markdown」「禁止超过 10 条发现」「禁止同一文件多条发现」等「软约束」全堆进 prompt —— 这些会让 prompt 膨胀且对结果无害。

## 3. 失败检测与收敛策略

派单失败时按以下顺序收敛(每次失败只做**一项**调整,不要同时改 scope + 改格式):

1. **收到 400 context overflow** → 立即用「收窄版 prompt」重试,scope 从 N 个目录降到 4 个、输出格式按 §2.3 简写。
2. **收窄版再失败** → 二分 scope 至 **1 个目录** 重试;成功后再考虑是否分两批派。
3. **二分仍失败** → 拆成更细的「按文件派」(例如单个 component 文件),一次只 explore 1-3 个文件。
4. **三次仍失败** → 停止重试,在 process.md 记录:Explore 不可用,改为 supervisor 自己用 `codegraph_explore` / `Read` 手动探;**不要**无限重试浪费 token。

**Why 一次只改一项**:同时改 scope 和格式,失败时无法判断哪个改动生效(也无从回滚)。顺序收敛可以保留「已知能 work 的部分」。

## 4. 成功案例(2026-09-05,正面)

**第一次(失败)**:6 大段完整说明 + 完整 JSON 字段定义 + 长禁止列表,触发 400 两次。

**第二次(成功)**:收窄到 4 个目录(`packages/zai/src/web/src/components/`、`packages/zai/src/web/src/pages/`、`packages/zai/src/web/src/lib/`、`packages/zai/src/web/src/store/`),输出格式只写「返回 JSON array,每条 1 个发现,带 file:line + evidence + problem + suggested_fix」,禁止段 2 行。**8 条发现**正常返回,均带 file:line + evidence,无编造。

**经验**:

- 模型不需要「完整字段说明」也能输出合规 JSON;**冗余说明 = 浪费 context window**。
- scope 收窄后,**单次 explore 的目标更明确**,返回的发现也更聚焦(8 条都是具体文件 / 行号 / 改法,无「建议大范围重构」之类的口水发现)。
- 禁止段只保留硬约束(防副作用 + 防编造)就够了;软约束交给 supervisor 在合并发现时过滤,不必全塞进 prompt。

## 5. 反例对照

| 维度 | 失败派单(6 大段版) | 成功派单(收窄版) |
|------|---------------------|-------------------|
| Prompt tokens | ~2500-3000 | ~600-800 |
| Scope | 「全仓扫前端代码」 | 4 个具体目录 |
| 输出格式定义 | 30+ 行 zod schema + 示例 | 4 行「每条要哪些 key」 |
| 禁止段落 | 8 条混合(硬 + 软) | 2 条(只防 side-effect + 防编造) |
| 触发 400 | 是(2 次) | 否 |
| 返回发现数 | — | 8 条,全部带 file:line |

## 6. 适用范围

- **适用**:task-factory supervisor 派 Explore 子代理、`AgentTool spawn_agent` 任意 Explore 类型子任务、`/ego-browser` workflow 里调 Explore agent。
- **不适用**:非 Explore 类型子代理(Implement / Verify / Test 等可能需要更详细 prompt,不在本文档范围)。

## 7. 相关文档

- `docs/superpowers/specs/2026-09-01-task-factory-design.md` —— Task Factory 总体设计(supervisor + 子代理派单)
- `docs/superpowers/specs/2026-09-02-supervisor-task-state-transition-tools-design.md` —— supervisor 工具集
