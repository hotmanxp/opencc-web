# 双轨维护契约 — opencc + dsh 长存期维护策略

> 日期：2026-08-22
> 所属批次：B7（[2026-08-17-dsh-kernel-batch-07-flip-cleanup.md](superpowers/plans/2026-08-17-dsh-kernel-batch-07-flip-cleanup.md) T7.3）
> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)
> G2 决策评审：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)
> 状态：草稿 — 与 G2 评审同步推进
> 维护：本文件由 dsh 轨道 owner 维护；评审通过后任何变更必须保留 git 提交记录

---

## 1. 背景与目标

### 1.1 为何需要此契约

B7 决策评审（[decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)）结束后，无论默认内核选哪条，**只要双轨仍存在**，就需要明文定义维护责任以避免：

- **冷冻结（Cold-Freezing）**：非默认轨道长期不维护导致 kill switch 不可用。
- **静默弃轨**：未走评审就放弃某条轨道的合规修复。
- **升级混乱**：dsh 升级与 zai 主线 PR 混批，导致 SESSION_FORMAT_VERSION 漂移、迁移器版本不同步。

### 1.2 覆盖范围

- 默认轨道选择与变更流程（必须由评审重审）。
- 每条轨道的能力面基线（与 main-plan §4.4 矩阵对齐）。
- dsh 依赖升级流程（`save-exact` 锁定 → 独立批次 → patch 兜底 → 上游 PR）。
- opencc vendor 冻结节奏。
- 紧急回切与降级预案。

**不覆盖**：
- 默认轨道是否切换（属于 G2 决策评审范围）。
- vendor 是否退役（属于 G3 / [vendor-retirement.md](2026-08-17-dsh-vendor-retirement.md)）。

---

## 2. 默认轨道

### 2.1 决定路径

| 状态 | 默认值 | 来源 |
|------|--------|------|
| B7 评审前 | `opencc` | 历史默认 |
| B7 评审通过后 | 以 [decision.md §7.1](superpowers/plans/2026-08-17-dsh-kernel-decision.md#7-决策结论评审会议填写) 结论为准 | 评审签字栏 |
| 评估变更时 | 走新一轮评审（不走单人 PR） | main-plan §8 决策门 |

### 2.2 默认优先级原则

- **默认轨道优先**：合规修复（H1 缺陷 / 安全 CVE / kill switch 通路）必须**双轨合入**，但**默认轨道优先落地**——即默认轨道的合并窗口先开放，非默认轨道的合入排同窗口或下个窗口。
- **新功能开发**：
  - 默认允许仅在某一轨道实现。
  - 若仅在一轨实现，另一轨需在 `compat/*` 或 `dsh-bridge/src/*` 提供显式 stub，并文档化为「已知未支持」（链接到本文件附录）。
  - 两轨都支持是更好的产品结果，但**不强制双轨同步开发**。

### 2.3 默认轨道的红线

默认轨道**禁止**：

- 删除非默认轨道的代码路径（仅可冻结）。
- 修改 `KernelAdapter` 接口语义（接口修改走双轨同步合入）。
- 移除 kill switch（即 `agent.kernel` 配置项必须永远保留两条合法值）。

---

## 3. 能力面基线（与 main-plan §4.4 矩阵对齐）

| zai 用户可见能力 | opencc 轨道 | dsh 轨道 | 双轨基线 | 降级流程 |
|---|---|---|---|---|
| 对话流式输出（11 组 ServerEvent） | ✓ | ✓ | **必须同时支持** | 走评审（不允许无记录降级） |
| 工具调用（bash / fs / edit / write） | ✓ | ✓ | **必须同时支持** | 走评审 |
| MCP 服务器工具 | ✓ | ✓ | **必须同时支持** | 走评审 |
| Skill 动态加载 | ✓ | ✓ | **必须同时支持** | 走评审 |
| 权限审批 / AskUserQuestion | ✓ | ✓ | **必须同时支持** | 走评审 |
| 会话持久化 / 历史列表 | ✓ | ✓ | **必须同时支持** | 走评审 |
| 后台任务 / 子 agent | ✓ | ✓ | **必须同时支持** | 走评审 |
| 插件市场 | ✓ | ✓ | **必须同时支持** | 走评审 |
| 记忆（AGENTS.md / rules watcher） | ✓ | ✓ | **必须同时支持** | 走评审 |
| Slash 命令 | ✓ | ✓ | **必须同时支持** | 走评审 |

### 3.1 降级流程

若任一用户可见能力在某一轨道不可用（或需 stub），必须：

1. 在 `docs/2026-08-17-dsh-known-differences.md` 维护一条差异记录（含来源批次、影响、可接受性、处置）。
2. 在评审中显式签字「接受 stub」。
3. stub 必须有清晰错误信息（不能沉默），含修复指引（仓库 issue 链接、迁移计划）。

---

## 4. dsh 依赖升级流程

### 4.1 锁定约定（`save-exact`）

- `packages/dsh-bridge/package.json` 中 `@deepseek-ai/dsh-*` 全部子包（含 `dsh-headless` / `dsh-session` / `dsh-tool` / `dsh-cordis` / `dsh-subagent` 等）**必须用 `"x.y.z"`，不加 `^/~`**。
- 升级时手动编辑 package.json + `pnpm install`，禁止 `pnpm add -E` 之外的隐式升级。

### 4.2 升级批次流程（独立 PR）

每次升级独立提交 PR，**不允许混入主仓库其他改动**：

```
PR 标题示例：
  dsh: 升级 0.1.0-rc.7 → 0.1.0-rc.8（kill switch 全绿）

强制包含：
  1. package.json / pnpm-lock.yaml — 严格 save-exact
  2. parity harness 重新跑全场景报告（11 组 ServerEvent 全覆盖）
     — 必须 CI 留 link/截图
  3. 若 SESSION_FORMAT_VERSION 改变：
     - 迁移器版本号（packages/zai/src/server/services/kernel/migrate.ts 顶层版本常量）联动更新
     - 旧 SESSION log 在新版本下处理策略写明（接受 / 拒绝 / 自动转换）
  4. kill switch 演练脚本（scripts/kill-switch-drill.sh）必须仍全绿
  5. 依赖 ABI 风险评估：
     - 若 dsh 升级涉及 Cordis ABI（main-plan R9），必须列出影响范围与 dsh-bridge 依赖收敛报告
```

### 4.3 patch 兜底

- 若升级后发现某个 dsh API 与 zai 期望不兼容，**首选**：向 dsh 上游提 PR（按 §4.4）。
- 短期兜底（≤ 7 天）：本地 patch（`pnpm patch` + commit 进仓库或 fork 镜像），CI 加注 `PATCHED_DEPENDENCY`。
- 长期兜底（> 7 天）：fork 镜像；评估是否回滚到上次升级前版本。
- patch 不允许私下分发，必须 commit 进仓库，便于审计。

### 4.4 上游 PR 优先

- 涉及通用能力差异（如 KD-02 工具 schema 兼容性）默认走上游 PR 路径。
- 优先 dsh-headless / dsh-cordis（这两是 zai 集成最紧密的包）。
- 上游 PR 链接必须登记到本文件附录。

---

## 5. opencc vendor 冻结节奏

### 5.1 冻结原则

- **不升级 opencc 上游版本**：当前 vendor 是 opencc 0.20.0 拷贝，再升级需重新走 vendor 同步流程，且 zai 已经不再用 mainline vendor。
- **允许修改范围**：仅 zai 侧补丁（类型修复、zai 适配、bug fix），不动 vendor runtime 行为。
- **补丁提交**：走主仓库常规 PR；CI 验证 compat 与 opencc 单测全绿。

### 5.2 vendor 包生命周期

| 阶段 | 时间窗口 | 维护强度 | 升级路径 |
|------|----------|----------|----------|
| 活跃（默认轨道期间） | 默认内核为 opencc 期间 | 持续 | 评审驱动升级（已冻结） |
| 冻结（kill switch 保真期） | opencc 退为 kill switch 起 | 最小 | 仅安全补丁 |
| 退役候选期 | G3 评审通过「退役」决议后 | 仅评估 | 走 [vendor-retirement.md](2026-08-17-dsh-vendor-retirement.md) 分步移除 |
| 退役完成期 | vendor 已移除 | 无 | 全部能力走 dsh |

> B7 当前阶段：opencc 处于**冻结（kill switch 保真期）**，除非 G2 选 A 则 opencc 仍是活跃。

### 5.3 vendor 冻结期维护红线

- 不得修改 vendor 内部 runtime 行为（仅做 compat/zai 侧适配）。
- 不得新增依赖（vendor 不应吸收更多 patch）。
- 改动必须包含 `vendor/*` 路径的注释，标注「zai 适配 only，上游勿拿」。

---

## 6. 紧急回切与降级预案

### 6.1 触发条件（任一）

- 默认轨道在生产出现 R3（事件翻译遗漏）/ R5（权限模型冲突）级别问题。
- dsh 上游发布**带 SESSION_FORMAT_VERSION 不兼容变更**且降级修复 ≥ 14 天未能合入。
- 默认轨道在 30 天内 P0 / P1 bug 数 ≥ 3（按 issue label 统计）。

### 6.2 回切动作（kill switch 演练路径）

1. **配置回切**：`agent.kernel` 写入对偶轨道值（opencc ↔ dsh）。
2. **数据安全**：
   - 两条轨道的数据目录不共享（main-plan §4.2 隔离），回切不会破坏任一轨道数据。
   - 当前轨道未保存的 in-flight turn 在切换时按 B-1 尖峰定义的 drain/dispose 顺序清空（主计划 R8）：
     - 拒绝新请求
     - flush 当前 turn
     - dispose Cordis ctx
     - 清 `__zaiEventBus / __zaiBridgeCtx / __zaiSessionInbox / __zaiCurrentSessionId` globalThis 桥
3. **重启 zai 服务**：配置回切必须配 zai 重启（运行期切换不允许，B0 红线）。
4. **公告**：通过 release notes / changelog / 内部 IM 通知用户回切。

### 6.3 演练要求

- **季度演练**：每季度 1 次，按 [B6 T6.4 演练脚本](superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md#T6.4-kill-switch-演练含-SSE-drain) 执行；结果存档 `docs/superpowers/plans/<date>-kill-switch-drill-report.md`。
- **强制场景**：含 SSE 长连接活跃 + 进行中 turn + 后台任务存在；验证无数据损坏、无孤儿进程、globalThis 桥清空。
- **演练 owner**：opencc / dsh 双 owner 共同签字确认。

---

## 7. 配套执行项

> 本节是评审通过后的工作清单（与 [decision.md §7](superpowers/plans/2026-08-17-dsh-kernel-decision.md#7-决策结论评审会议填写) 决议联动）。

| ID | 执行项 | 触发条件 | 责任 | 截止 |
|----|--------|----------|------|------|
| X-01 | 若评审选 B（切 dsh 默认）：执行 B7 T7.2 默认内核翻转（`zaiSettingsStore` 默认值变更 + 一次性迁移提示逻辑） | 评审通过 + 选项 B | dsh-bridge owner | 发版前 |
| X-02 | 若评审选 B：执行 B7 T7.4 vendor 退役评估 + 后续退役批次启动 | 评审通过 + 选项 B | dsh-bridge owner | 发版后独立批次 |
| X-03 | 90 天过渡期满复审会议 | 过渡期 90 天整 | 评审召集人 | 固定日程 |
| X-04 | 季度 kill switch 演练 | 每季度首月 | opencc/dsh 双 owner | 周期 |
| X-05 | dsh 依赖升级 PR（每次升级独立批次） | dsh 上游 GA / 升级窗口 | dsh 轨道 owner | 即时 |
| X-06 | vendor 补丁合入（仅 zai 侧适配） | 内部需求触发 | opencc 轨道 owner | 即时 |

---

## 8. 附录

### 8.1 关键链接

- 主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)
- G2 决策记录：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)
- 已知差异：[2026-08-17-dsh-known-differences.md](2026-08-17-dsh-known-differences.md)
- vendor 退役评估：[2026-08-17-dsh-vendor-retirement.md](2026-08-17-dsh-vendor-retirement.md)
- 能力面对齐矩阵：主计划 §4.4
- kill switch 演练：每季度 1 次，存档于 `docs/superpowers/plans/`

### 8.2 历史 dsh 升级记录（评审通过后开始维护）

| 日期 | 从版本 | 到版本 | 来源 | parity 报告链接 | 备注 |
|------|--------|--------|------|----------------|------|
| YYYY-MM-DD | 0.1.0-rc.7 | (待) | (待) | (待) | (待) |

### 8.3 上游 PR 登记（评审通过后开始维护）

| 仓库 | PR 链接 | 标题 | 关联差异 | 状态 |
|------|---------|------|----------|------|
| `@deepseek-ai/dsh-*` | (待) | (待) | (待) | (待) |

---

**版本**：v1（2026-08-22 草稿）
**维护 owner**：dsh 轨道 owner（默认）
**变更规则**：本文件变更必须配 PR 描述 + 影响评估；不允许单独修改附录历史 / PR 登记。
