# zn-harness 项目改造工作文档

> 目标:把任一项目改造成「AI Agent 友好」工程,产出一套可持续维护的知识工程资产 + 工作流装备。

---

## 0. 总览

| 阶段 | 章节 | 自动化 | 人工介入点 |
|------|------|--------|-----------|
| 一 | 知识工程建设 | agents-md skill、pa-sdd skill、codegraph | AGENTS.md 终审、规则补充、文档校对 |
| 二 | 工作流装备 | codegraph install、agent 插件市场 | SOP 走查 |

**核心原则**:
- AI 出第一稿 + 人工做"价值判断与边界划定"
- 改造产物要可回滚(全在 git 跟踪内)
- 一次接入一个项目,不要跨项目批量复制配置

**资源安装前置**:所有 skill / CLI / 插件的安装命令,不在本文档重复,各资源有独立 README:

| 资源 | 入口 | 安装入口 |
|------|------|----------|
| agents-md / pa-sdd / superpowers 等 skills | `assets/skills/<ns>/` | publisher,详见 [`packages/publisher/README.md`](../packages/publisher/README.md) |
| codegraph CLI | npm global | `npm install -g @colbymchenry/codegraph@latest` |
| publisher(发布工具) | `packages/publisher/` | `npm install -g @zn-ai/plugin --registry=http://maven.paic.com.cn/repository/npm/`,详见 `packages/publisher/README.md` |

---

## 1. 知识工程建设

### 1.1 AGENTS.md 的生成、评估、修改、优化

**目标**:产出 ≤200 行、命中模板的 `AGENTS.md`,让 AI Agent 在加载后能正确工作。

#### 1.1.1 实施步骤

1. 确认 `agents-md` skill 已安装(见 §0)
2. 在 agent 内触发 `/agents-md`,对话中追加 "create a new AGENTS.md for this project"
3. skill 自动扫描项目结构,按 `assets/skills/zn-harness/agents-md/template.md` 生成第一稿
4. 人工按 §1.1.4 必做 3 件事补充

#### 1.1.2 评估阈值

| 检查项 | 阈值 | 不达标处理 |
|--------|------|-----------|
| 行数 | 100-200 行 | >200 → 拆 docs/*; <100 → 补 Tech Stack / Project Rules |
| 章节完整 | 7 个必备章节齐 | 缺哪补哪 |
| 重复内容 | 0 行与 CLAUDE.md 重合 | 删 AGENTS.md 重复段,只留引用 |
| 路径 | 全部相对路径 | 改绝对路径 → 改 `./` 形式 |
| 命令 | 全部可执行 | 干跑一遍 `pnpm dev`、`pnpm test` |
| 规则 | 3-8 条 imperative | 删"愿景式"句子 |

**操作**:在 agent 内调用 `/agents-md` 并说 "review this project's AGENTS.md against the iron rules"。

#### 1.1.3 优化(>200 行时)

触发条件:`wc -l AGENTS.md` 输出 >200。

操作:在 agent 内说"trim AGENTS.md to 150 lines, move detail to docs/structure.md"。

产物:`docs/structure.md`、`docs/conventions.md` 等。

#### 1.1.4 人工审查必做 3 件事

1. **价值规则补足** — AI 容易漏的"项目硬约束"必须手写,例如:
   - 内部域名规则(必须用 `code.paic.com.cn`,不能走外网)
   - 性能红线(首屏 < 2s,接口 P99 < 200ms)
   - 合规要求(用户数据脱敏、敏感字段加解密)
2. **业务术语词典** — 在 Project Rules 末尾追加 `### Glossary`,列 3-10 个项目专属术语
3. **"先验错"清单** — 列出 3-5 条历史踩坑案例,AI 改这块代码时会被警告

#### 1.1.5 提交

```bash
docs: add AGENTS.md for <project>  # 首次
refactor(agents): trim AGENTS.md to 150 lines, link to docs/*  # 优化时
```

---

### 1.2 docs 文档生成

#### 1.2.1 规范/编码/code-review/how-to 文档(PA-SDD 加速)

PA-SDD 提供 6 个 skill,按需在 agent 内触发对应命令即可(本节不列安装命令,见 §0):

| Skill | 触发命令 | 职责 | 输出位置 |
|-------|----------|------|----------|
| `SDD-init` | `/SDD-init` | 框架初始化(自动装包) | 仓库根 |
| `SDD-requirement-analysis` | `/SDD-requirement-analysis` | 用户故事/需求分析 | `ai_workspace/requirements/` |
| `SDD-code-spec-init` | `/SDD-code-spec-init` | 4 个 L2 spec(架构/命名/风格/安全) | `ai_workspace/code-specification/` |
| `SDD-design-analysis` | `/SDD-design-analysis` | 架构设计、影响范围 | `ai_workspace/extends/` |
| `SDD-implementation-test-review` | `/SDD-implementation-test-review` | 代码 + 测试 + 审查 | 仓库内 |
| `SDD-project-how-to-bootstrap-java` | `/SDD-project-how-to-bootstrap-java` | Java 项目 how-to | `ai_workspace/project-how-to/` |

**典型流程**:

1. `/SDD-init` — 初始化 `ai_workspace/`
2. `/SDD-code-spec-init` — 扫描仓库实情(不脑补),生成 4 个 L2 spec,每个 ≤ 50-150 行
3. 按语言选分支:
   - Java 项目 → `/SDD-project-how-to-bootstrap-java`
   - 其他语言 → `/SDD-design-analysis`
4. 基于 spec 派生 `docs/code-review.md` 和 `how-to-xxx.md`(见下)

**code-review 规范生成**(派生自 spec):

- 内容来源:
  - `security-spec.md` 的硬性规则 → 必查项
  - `naming-convention-spec.md` → lint 必跑
  - 团队历史 PR review comments(可选)→ 风格项
- 模板:`assets/skills/pa-sdd/SDD-design-analysis/references/code_review_checklist.md`
- 输出:`docs/code-review.md`

**how-to-xxx 文档结构**:

- 适用场景(一句话)
- 前置条件(命令 / 权限 / 文件)
- 操作步骤(命令 + 预期输出)
- 排错(3-5 个常见错 + 解法)
- 写入 `ai_workspace/project-how-to/abilities/<name>.md`
- 索引写入 `ai_workspace/project-how-to/abilities-index.md`

**人工校验清单**:

- [ ] `wc -l ai_workspace/code-specification/*.md` 全部 ≤ 150 行
- [ ] spec 里每条规则在仓库能找到证据(grep 出 ≥1 处)
- [ ] how-to 文档走通一遍,命令无 paste 错
- [ ] code-review 规范与 `.eslintrc` / `.prettierrc` / `tsconfig.json` 不冲突

#### 1.2.2 业务流程文档(codegraph 查询 + 人工校验)

**目的**:把"代码隐含的业务流程"沉淀为可读文档,便于新人 onboarding + AI 理解。

**实施步骤**:

1. 确认 codegraph 已初始化(见 §1.3)
2. 在 agent 内调用 `mcp__codegraph__codegraph_explore`,问业务问题:
   - "describe the user login flow end-to-end"
   - "what happens when a request hits /api/orders?"
   - "list all background jobs and their triggers"
3. 对每个核心 service / event / state machine,做 trace(用 `mcp__codegraph__codegraph_callers` / `codegraph_callees`)
4. 拿到上下游链路,贴到 `docs/business-flows/<flow>.md`

**业务流程文档模板**(`docs/business-flows/<flow>.md`):

```markdown
# <业务流名称>

## 触发条件
- <入口 1>:<HTTP 路径 / 事件名 / 定时任务>
- <入口 2>:

## 核心链路
| 步骤 | 节点 | 路径 | 关键逻辑 |
|------|------|------|----------|
| 1 | <Class.method> | ./src/.../X.ts:42 | <一句话> |
| 2 | <Class.method> | ./src/.../Y.ts:88 | <一句话> |

## 数据流
请求 → <DB/Redis/MQ> → 响应
或:事件 → 消费者 → 副作用

## 异常分支
- 步骤 3 失败 → 走 <重试 / 降级 / 死信>

## 反向追踪
codegraph_callers 起点:<symbol>
codegraph_callees 终点:<symbol>
```

**人工校验 3 件套**:

1. **跑一遍 trace** — 在测试环境真触发一次,对比文档与日志
2. **画图核对** — 用 mermaid 画时序图,贴到文档末尾,与代码对照
3. **补充隐式约束** — 文档里要加"未在代码中体现的约束",例如:
   - 业务上要求"重复请求 5 分钟内只处理一次"(代码靠 Redis TTL,需说明)
   - 业务上要求"金额字段禁止负数"(代码无 assert,需说明)

**提交**:

```bash
docs(business): add order-creation flow document
docs(specs): bootstrap L2 specs from pa-sdd
```

---

### 1.3 项目代码知识图谱工具(CodeGraph)初始化

#### 1.3.1 插件库全局安装

| 工具 | 安装命令 | 详见 |
|------|----------|------|
| codegraph CLI | `npm install -g @colbymchenry/codegraph@latest` | npmjs |
| publisher(发布工具) | `npm install -g @zn-ai/plugin --registry=http://maven.paic.com.cn/repository/npm/` | [`packages/publisher/README.md`](../packages/publisher/README.md) |

**目标产物**:

- 全局命令 `codegraph` 可用
- 全局命令 `zn-agent-plugin` 可用(发布工具)

#### 1.3.2 当前代码库索引初始化 + .gitignore

1. 进入目标项目:`cd <target-project>`
2. 初始化 + 建索引:`codegraph init`
   - 默认:在 `<project>/.codegraph/` 下生成 `codegraph.db`,首次启动 file watcher
   - 产物:`daemon.pid`(守护进程)、`daemon.sock`(Unix Socket)、`daemon.log`(启动日志)
3. 检查状态:`codegraph status`,期望 `Indexed files > 0, Symbols > 0`
4. 同步(后续文件改动自动触发,如需手动):`codegraph sync`

**.gitignore 提交**:

- 在 `.gitignore` 追加 `.codegraph/`
- 验证:`git check-ignore .codegraph/` 退出码 0
- 提交:`chore: gitignore .codegraph/`

#### 1.3.3 插件配置 + MCP + AGENTS.md 说明

**目标**:让所有支持的 agent(Nova CLI / OpenCode / OpenCC)都能通过 MCP 协议调用 codegraph。

**Nova CLI / OpenCC (Claude Code) 配置**:

项目级 `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_explore",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status",
      "mcp__codegraph__codegraph_files"
    ]
  }
}
```

用户级 `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**OpenCode 配置**:

`~/.config/opencode/opencode.json` 或 `<project>/.opencode/settings.json`:

```json
{
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

**AGENTS.md 补充说明**(在 §1.1 生成的 AGENTS.md 末尾追加):

```markdown
## Code Intelligence

This project is indexed by [CodeGraph](https://...). Before reading large
files, prefer:

| Need | Tool |
|------|------|
| Find a symbol | `mcp__codegraph__codegraph_search "<term>"` |
| Read a function body | `mcp__codegraph__codegraph_node "<symbol>"` |
| Understand call flow | `mcp__codegraph__codegraph_explore "<symbols>"` |
| Impact of a change | `mcp__codegraph__codegraph_impact "<symbol>"` |

Refresh the index manually: `codegraph sync`. Full reindex: `codegraph init`.
```

**commit**:

```bash
chore(mcp): wire up codegraph MCP server
docs(agents): document codegraph tools in AGENTS.md
```

---

## 2. 工作流装备

### 2.1 Claude Code (CC):superpowers 插件安装

**安装**:编辑 `~/.claude/settings.json` 的 `enabledPlugins`,添加 `"superpowers@zn-plugins-market": true`。详见 superpowers 插件市场文档。

**验证**:启动 CC,看到 superpowers 提供的 `/brainstorm`、`/tdd` 等命令即成功。

### 2.2 OpenCode: superpowers skills 安装

**安装**:用 publisher 把 `superpowers-sets` 安装到 `~/.agents/skills/`,详见 [`packages/publisher/README.md`](../packages/publisher/README.md)。

**验证**:`ls ~/.agents/skills/superpowers-sets/`,期望 14 个子目录:

```
brainstorming
dispatching-parallel-agents
executing-plans
finishing-a-development-branch
receiving-code-review
requesting-code-review
subagent-driven-development
systematic-debugging
test-driven-development
using-git-worktrees
using-superpowers
verification-before-completion
writing-plans
writing-skills
```

**OpenCode 端启用**:`~/.config/opencode/opencode.json`:

```json
{
  "skills": {
    "paths": ["~/.agents/skills"]
  }
}
```

**双平台差异**:

| 项 | Claude Code | OpenCode |
|----|-------------|----------|
| 加载方式 | 插件市场(`superpowers@zn-plugins-market`) | skills 目录(`~/.agents/skills/`) |
| 命令前缀 | `/` | `/` |
| 配置文件 | `~/.claude/settings.json` | `~/.config/opencode/opencode.json` |
| 共享 skills 目录 | 否(走插件) | 是(与 Nova CLI 共享) |

### 2.3 SOP 工作流(从 /brainstorm 开始)

**核心 SOP:从创意到合并的完整链路**

```
/brainstorm
  ↓ 明确意图 + 需求结构化
/write-plan
  ↓ 产出可执行计划
/git-worktree (隔离工作区)
  ↓
/test-driven-development (TDD 红绿重构)
  ↓
/requesting-code-review (提交前自查)
  ↓
/receiving-code-review (收到反馈时)
  ↓
/finishing-a-development-branch (合并/开 PR/清理)
```

#### 阶段 1:头脑风暴 — `/brainstorm`

**触发**:"想做 XX 功能" / "要改 XX 行为" / "要不要引入 XX"。

**执行**:

1. 在 CC / OpenCode 任意 agent 中输入 `/brainstorm`
2. skill 会主动发问,覆盖:
   - 真正要解决的问题
   - 替代方案与 trade-off
   - 边界条件 / 异常路径
   - 验收标准
3. 输出:User Story 或 RFC 草稿

**产物**:对话内文档 + `docs/proposals/<name>.md`(可选落盘)

#### 阶段 2:写计划 — `/writing-plans`

**触发**:`/brainstorm` 完成后,用户同意进入实施。

**执行**:

1. `/writing-plans` 触发,skill 要求输入:
   - 目标(spec 链接或 User Story)
   - 任务粒度(每步 < 30 分钟)
   - 验收标准
2. 产出:`docs/plans/<name>.md`,结构按 superpowers 模板

**产物**:`docs/plans/<name>.md`,可作为 PR 描述底稿

#### 阶段 3:隔离工作区 — `/using-git-worktrees`

**触发**:动手写代码前。

**执行**:

1. `/using-git-worktrees` 或直接 `git worktree add ../<project>-<feature> -b feat/<name>`
2. 进入 worktree 后,所有改动只发生在 feature 分支

**注意**:OpenCC / CC 也可走 worktree,无平台差异

#### 阶段 4:TDD — `/test-driven-development`

**触发**:写实现前。

**执行**:

1. `/test-driven-development` 触发红绿重构循环
2. 红:写一个失败的测试
3. 绿:最小代码让测试通过
4. 重构:消除重复,保持测试绿

**关键**:测试覆盖率作为完成度的硬指标,目标 ≥ 80%

#### 阶段 5:请求代码审查 — `/requesting-code-review`

**触发**:本地测试绿、准备 commit 前。

**执行**:

1. `/requesting-code-review` 触发,自动 spawn 一个 reviewer sub-agent
2. reviewer 独立审查,产出报告
3. 用户对报告做去伪存真

#### 阶段 6:接收代码审查 — `/receiving-code-review`

**触发**:收到 reviewer / 同事的反馈时。

**执行**:

1. `/receiving-code-review` 触发,skill 要求:
   - 区分"必改" / "讨论" / "忽略"
   - 验证每条建议的技术正确性,不盲从
2. 输出:action list,逐条执行

#### 阶段 7:完成分支 — `/finishing-a-development-branch`

**触发**:所有测试绿、review 通过、准备合并。

**执行**:

1. `/finishing-a-development-branch` 触发
2. skill 询问交付方式:
   - merge 到 main?
   - 推 PR 等团队 review?
   - 仅本地保留?
3. 执行选定的 git 命令,清理 worktree

#### 可选辅助 skills(按需调用)

| 场景 | Skill | 说明 |
|------|-------|------|
| 性能/复杂 bug | `/systematic-debugging` | 复现 → 缩小 → 假设 → 验证 |
| 多任务并行 | `/dispatching-parallel-agents` | 拆 2+ 独立任务并行 |
| 多文件实现 | `/subagent-driven-development` | 在当前会话内派 sub-agent 执行 |
| 跨任务执行 | `/executing-plans` | 跨会话执行写好的 plan |
| 自验证 | `/verification-before-completion` | 提交/开 PR 前必跑 |
| 创建新 skill | `/writing-skills` | 含评估与命名规范 |

**所有 skill 的元规则**:`/using-superpowers` 是入口,所有 SOP 开头第一动作是调用它。

---

## 3. 验收清单(项目改造完毕前必跑)

| 项 | 命令 / 检查 | 期望 |
|----|-------------|------|
| AGENTS.md 长度 | `wc -l AGENTS.md` | 100-200 行 |
| AGENTS.md 7 章节齐 | grep 标题 | 7 个全在 |
| L2 spec 生成 | `ls ai_workspace/code-specification/` | 4 个 md 文件 |
| 业务流程文档 | `ls docs/business-flows/` | ≥1 个核心流 |
| codegraph 索引 | `codegraph status` | files>0, symbols>0 |
| .gitignore | `git check-ignore .codegraph/` | 退出码 0 |
| MCP 配置 | `cat ~/.claude/settings.json` | 含 codegraph server |
| superpowers(CC) | CC 内 `/brainstorm` 可见 | 命令出现在补全 |
| superpowers(OC) | `ls ~/.agents/skills/superpowers-sets/` | 14 个目录 |
| 提交记录 | `git log --oneline -20` | 见 docs/chore/docs/refactor 5+ 条 |

---

## 4. 附录

### A. 关键路径速查

| 资源 | 本仓库路径 | 安装后位置 |
|------|-----------|-----------|
| agents-md skill | `assets/skills/zn-harness/agents-md/` | `~/.agents/skills/agents-md/` |
| pa-sdd 6 skills | `assets/skills/pa-sdd/` | `~/.agents/skills/<skill>/` |
| superpowers 14 skills | `assets/skills/superpowers-sets/` | `~/.agents/skills/<skill>/` |
| codegraph | npm global | `codegraph` |


### B. 改造一个项目的标准 PR 顺序

1. `chore(mcp): wire up codegraph MCP server` —— 不改代码,只改 `.gitignore` + 配置文件
2. `chore: gitignore .codegraph/` —— 忽略本地索引
3. `docs(agents): bootstrap AGENTS.md from agents-md skill` —— 第一版 AGENTS.md
4. `docs(specs): add L2 specs from pa-sdd` —— 4 个 spec
5. `docs(business): add <flow> business document` —— 业务流程
6. `refactor(agents): trim AGENTS.md + add glossary` —— 优化(若 >200 行)
7. `chore(skills): install superpowers-sets for opencode` —— 工作流装备

### D. 故障排查

| 现象 | 原因 | 处置 |
|------|------|------|
| `codegraph: command not found` | npm global bin 不在 PATH | `export PATH="$(npm config get prefix)/bin:$PATH"` |
| `codegraph serve` 端口被占 | 残留 daemon | `cat .codegraph/daemon.pid \| xargs kill` |
| publisher install 后 skills 不在 | 平台未指定 | 加 `--platform all` 或 `--platform opencode`,详见 publisher README |
| `/brainstorm` 命令不在 CC | 插件未启用 | 编辑 `~/.claude/settings.json` 的 `enabledPlugins` |
| `git diff` 显示 `.codegraph/` 改动 | `.gitignore` 未生效 | `git rm -r --cached .codegraph/` + `git add .gitignore` |
| OpenCode 找不到 skill | 路径未配 | 编辑 `opencode.json` 的 `skills.paths` |
