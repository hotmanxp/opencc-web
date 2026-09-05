# Task-Intake 内联 brainstorming / writing-plans skill 设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 task-intake / task-factory 两个核心 agent 通过 SkillTool 触发的 brainstorming / writing-plans / writing-specs 流程改为内联到 systemPrompt 中,避免每次新建任务都要加载 SKILL.md 全文,并消除"Skill 触发"环节带来的额外 round-trip。

**Architecture:**
1. 新建独立模块 `prompts/intakeSkillsInlined.ts` 存放 SKILL 完整内容(单一来源)。
2. `mainAgents-taskIntake.ts` 的 systemPrompt 在原数组里 spread 内联常量,删除"invoke SkillTool to run the brainstorming skill"措辞。
3. `mainAgents-taskFactory.ts` 第 1 步兜底分支同样改造。
4. Skill 工具保留在白名单,但末尾纪律段明确"不要重新触发已内联 skill"。

**Tech Stack:** TypeScript + Vitest;不引入新依赖。

## Global Constraints

[项目级约束 — 从 opencc-web AGENTS.md 摘录]

- 系统提示词一律用英文;所有写入代码的 prompt 字符串必须英文(Why:跨模型稳定性 + tokenizer 兼容;How to apply:每个新 prompt 字段检查一遍)。
- core 改动后必须先 `pnpm run build:core` 再用 `/ego-browser` 验证 — 本任务为 prompt 文本改动,build:core 仍必跑(改的是 vendor 内 `src/opencc-src/`,属于 core 源)。
- 测试粒度:功能改动后只跑直接受影响的测试文件,禁止 `pnpm -r test`(Why:全量 190+ 测试 30s+ 解析 + 数十秒执行,日常反馈太慢;How to apply:用文件路径过滤)。
- 任务仓库 cwd:**绝对**路径(`/Users/ethan/code/opencc-web`),executor agent: `opencc`,priority: `P1`,dependsOn: `[]`(本次讨论确认)。
- Intake gate 三件套契约不变:`<task_dir>/docs/spec.md` + `docs/plan.md` + `docs/brainstorm.md` 全部必须 substantive,骨架 placeholder 算 MISSING。

---

## 设计要点

### 1. 新模块 — `prompts/intakeSkillsInlined.ts`

**目的**:把 superpowers:brainstorming 和 superpowers:writing-plans 两个 SKILL.md 全文复制为字符串常量,单一来源,SKILL 升级时改一处两个 agent 同步生效。

**文件路径**:`packages/zn-agent-core/src/opencc-src/prompts/intakeSkillsInlined.ts`(相对 cwd `/Users/ethan/code/opencc-web`,绝对路径 `/Users/ethan/code/opencc-web/packages/zn-agent-core/src/opencc-src/prompts/intakeSkillsInlined.ts`)。

**导出**:
```ts
export const INLINED_BRAINSTORMING_SKILL: string[]
export const INLINED_WRITING_PLANS_SKILL: string[]
export const INTAKE_SKILL_DISCIPLINE: string[]
```

**注释标注**:
- 来源 superpowers 6.2.0:`~/.zai/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/brainstorming/SKILL.md` 与 `.../writing-plans/SKILL.md`。
- 复制时间(YYYY-MM-DD),便于识别 SKILL 升级时是否 drift。
- 与 `mainAgents-promptSections.ts` 的关系(后者只抽象通用编码段;本模块覆盖完整 SKILL)。

### 2. task-intake prompt 改造 — `mainAgents-taskIntake.ts`

**当前第 1 步**(摘):
```
1. Requirement discussion: invoke SkillTool to run the brainstorming skill,
   and work out the task goal, acceptance criteria, and scope boundaries with
   the user step by step. ...
```

**改为**(摘):
```
1. Requirement discussion: read the inlined brainstorming flow below
   (look for "## Brainstorming Ideas Into Designs" — already inlined into this
   system prompt at startup, no SkillTool invocation required). Walk the
   user through the brainstorming checklist (explore context → clarifying
   questions → propose approaches → present design → write spec doc →
   self-review → user review) step by step. During the discussion collect:
   title, project cwd (absolute path), executor agent, priority, dependsOn.
```

**`systemPrompt` 数组拼接**:
```ts
systemPrompt: (origin) => [
  ...TASK_INTAKE_SYSTEM_PROMPT,
  ...INLINED_BRAINSTORMING_SKILL,
  ...INLINED_WRITING_PLANS_SKILL,
  ...taskIntakeSettingsSection(),
  ...INTAKE_SKILL_DISCIPLINE,
  ...stripCodingSections(origin, ['codegraph']),
],
```

**tools 白名单**:`TASK_INTAKE_TOOL_ALLOWLIST` 保留 `'Skill'`(用户已确认);用法约束放在 `INTAKE_SKILL_DISCIPLINE` 段。

### 3. task-factory prompt 改造 — `mainAgents-taskFactory.ts`

**当前第 1 步兜底分支**(摘):
```
1. Requirement discussion: by default, ... if the user proposes a new task
   directly to you, first invoke SkillTool to run the brainstorming skill
   and clarify the requirements and acceptance criteria.
```

**改为**(摘):
```
1. Requirement discussion: by default, ... if the user proposes a new task
   directly to you, follow the inlined brainstorming flow below (look for
   "## Brainstorming Ideas Into Designs" — already inlined into this system
   prompt; do NOT trigger it via SkillTool).
```

**`systemPrompt` 数组拼接**:同 task-intake,末尾加 `...INTAKE_SKILL_DISCIPLINE,`。

**tools 白名单**:`SUPERVISOR_DROP_TOOLS` 不变;`Skill` 工具本来就在 origin 默认池里,白名单不动。

### 4. 纪律段 — `INTAKE_SKILL_DISCIPLINE`

新增常量,内容:
```
Skill-tool discipline: the brainstorming and writing-plans flows above are
already inlined into this system prompt. Do NOT re-invoke them via SkillTool
— you already have the full checklist inline. The Skill tool is reserved for
skills that are NOT pre-loaded here (e.g. user-invoked third-party skills).
```

放在两个 agent 的 systemPrompt 末尾,作为强约束。

## 关键决策 + 取舍

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 内联粒度 | 全量 / 只内联 brainstorming | **全量内联** | 用户原始诉求是"都内置到 agent 的提示词中",writing-plans 也属内联范围 |
| Skill 工具 | 删除 / 保留 | **保留** | 用户明确"保留 Skill 工具但不触发" — 不删白名单,靠纪律段约束 |
| 内容存储 | 单文件 / 独立模块 | **独立模块** | 跟 `mainAgents-promptSections.ts` 抽象一致;SKILL 升级时改一处两 agent 同步 |
| 执行细节裁剪 | 去掉 / 保留 | **保留** | 用户澄清阶段反转了原始口头诉求;task-intake 落 plan.md 是给 executor 看的,plan 内 TDD / commit / sub-skill 指令是 executor 的执行骨架,去掉会损害执行质量 |
| 改造范围 | task-intake / task-factory / quick | **task-intake + task-factory** | 用户确认;task-intake-quick 本就剥离 brainstorming,不在 scope |

## 范围边界(明确不做)

- `task-intake-quick` agent **不在 scope**:它早就完全剥离 brainstorming 流程,只走 `mode: 'quick'` 落盘,没有 SkillTool 触发,本次无需改动。
- `agent-creator` / `office` / `default` agent **不在 scope**:它们不需要 brainstorming / writing-plans 流程。
- 不删除 superpowers:brainstorming / superpowers:writing-plans SKILL 文件本身 — 它们仍可能在其他 agent(比如 zai 主 agent 的 brainstorming-only 场景)被触发。
- 不改 SuperTasksCreate / SuperTasksList 等 taskFactoryTools 工具签名 — 工具签名不变,只是 prompt 内容调整。
- 不改 intake gate 程序校验逻辑 — `<task_dir>/docs/spec.md` + `docs/plan.md` + `docs/brainstorm.md` 三件套契约保留。
- **不引入新依赖**(TypeScript + Vitest 已覆盖)。

## 文件清单

**新建**:
- `packages/zn-agent-core/src/opencc-src/prompts/intakeSkillsInlined.ts`
- `packages/zn-agent-core/test/unit/intakeSkillsInlined.test.ts`
- `packages/zn-agent-core/test/unit/mainAgents-taskIntake-prompt.test.ts`
- `packages/zn-agent-core/test/unit/mainAgents-taskFactory-prompt.test.ts`

**修改**:
- `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskIntake.ts`(替换第 1 步措辞 + systemPrompt spread)
- `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts`(替换第 1 步兜底分支 + systemPrompt spread)

## 用户确认字段(本次讨论)

| 字段 | 值 | 备注 |
|------|---|------|
| 任务标题(暂定) | task-intake 内联 brainstorming / writing-plans skill | 实施时由 executor 起最终名 |
| 项目 cwd | `/Users/ethan/code/opencc-web` | executor 工作目录 |
| Executor agent | `opencc` | 默认 |
| Verifier agent | (同 executor,即 `opencc`) | 默认 |
| Priority | `P1` | 用户确认 |
| DependsOn | `[]` | 用户未提及 |
| Mode | `full`(完整任务,非 quick) | 涉及多文件 + 测试 |

## 验收标准

1. ✅ 新模块 `prompts/intakeSkillsInlined.ts` 导出三个常量,常量非空且含 SKILL 标题字符串。
2. ✅ `mainAgents-taskIntake.ts` 的 systemPrompt 拼接后含"## Brainstorming Ideas Into Designs"标题,**不**含"invoke SkillTool to run the brainstorming skill"字面字符串。
3. ✅ `mainAgents-taskFactory.ts` 第 1 步兜底分支同上断言。
4. ✅ `TASK_INTAKE_TOOL_ALLOWLIST` 仍含 `'Skill'`(用户确认保留)。
5. ✅ `pnpm run build:core` 通过(因为改动位于 `src/opencc-src/`)。
6. ✅ 相关单测全绿:`pnpm --filter @zn-ai/zn-agent-core test test/unit/intakeSkillsInlined.test.ts test/unit/mainAgents-taskIntake-prompt.test.ts test/unit/mainAgents-taskFactory-prompt.test.ts test/unit/mainAgents-taskIntake.test.ts`。
7. ✅ 现有 `mainAgents-taskIntake.test.ts` 不变(白名单 / 去重断言与本次正交)。
8. ✅ task-intake-quick 的"严禁出现 brainstorming 字面字符串"单测仍通过(本次未触及 quick 文件)。

## 不在 scope 但已记录的 follow-up

- (后续可选)同步检查 `agent-creator` 是否需要类似内联(`agent-creator` 的 `validateMainAgentFile` 工具允许用户在 LLM 创作时调用 skill,如果该 agent 也有类似 Skill 触发,可能需要类似内联 — 但本次不在 scope)。
- (后续可选)把内联 SKILL 内容做成 build-time 注入而非运行时 import,允许 tree-shake — 但目前 600 行级别不需要。