# Batch 7 — 决策与清理

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> 关联：**B-1 可行性尖峰**是本批前置决策门（G-1）；B6 验收通过是本批主要前置（G2）。
> 目标：G2 决策门的正式评审、默认内核切换（或保留双轨）的落地、vendor 退役（可选）、文档与维护策略收口。**本批不引入新功能，只做决策与收尾。**

---

## 1. 目标

- 依据 B6 验收报告正式评审 G2/G3 决策门，输出明确结论。
- 若切默认内核：`agent.kernel` 默认值翻转为 `'dsh'`，保留 `'opencc'` 作为 kill switch（双轨仍在，只是默认变化）。
- 若保留双轨：明确双轨维护策略与过渡期限。
- 文档收口：主计划/子计划标记终态、AGENTS.md 更新、开发手册更新。
- 可选：opencc vendor（`opencc-src/` + compat）退役路径评估与执行。

## 2. 前置条件

- **G-1 已通过**（B-1 可行性尖峰：节点引擎要求 + packed install + headless peers + 长驻 Cordis teardown + globalThis 清理协议 + dsh 版本兼容性）—— 验证 dsh 集成在工程层面可行。
- B6 全部验收通过、验收报告完成。

## 3. 任务清单

### T7.1 G2 决策评审

- **做什么**：召集评审（维护者），逐条过 B6 验收报告 + 已知差异清单；对每条差异给「接受 / 修复 / 驳回」结论。
- **产出**：`docs/superpowers/plans/2026-08-17-dsh-kernel-decision.md`（决策记录：结论、理由、遗留项）。
- **验收**：决策记录落盘，无悬而未决的高风险项。

### T7.2 默认内核翻转（若决策为切）

- **做什么**：`zaiSettingsStore` 默认值 `'opencc'` → `'dsh'`；迁移提示：已有 opencc 用户/会话在启动时给一次性提示（可一键回 `'opencc'`）。
- **文件**：`packages/zai/src/server/services/zaiSettingsStore.ts`、迁移提示逻辑。
- **验收**：全新安装默认 dsh；`agent.kernel='opencc'` 仍完整可用（kill switch 保真）。

### T7.3 双轨维护策略（若保留双轨）

- **做什么**：定义双轨维护契约：默认轨道、每条轨道的能力面基线、dsh 依赖升级流程（版本锁定 + 独立批次）、opencc vendor 冻结节奏。
- **文件**：`AGENTS.md` 增补 + 决策记录。
- **验收**：维护契约文档化，评审确认。

### T7.4 opencc vendor 退役评估（可选，G3）

- **做什么**：若 G2 切默认，评估 `opencc-src/` + compat 退役路径：完全移除 vs 冻结保留；影响面（bundle-entry、build:core、transcript、compact 等）；退役后 `pnpm run build` 链路简化。
- **文件**：退役评估 `docs/2026-08-17-dsh-vendor-retirement.md`（结论 + 影响清单 + 分步移除计划）。
- **验收**：评估报告完成；若执行移除，按报告分步进行且每步回归绿。
- **注意**：vendor 退役是独立大工程，本批允许「只评估不执行」，执行另立计划。

### T7.5 文档收口

- **做什么**：
  - 主计划/子计划文档标记状态（已完成/废弃/调整）。
  - `AGENTS.md`：新增 `agent.kernel` 配置说明、双轨数据目录、dsh-bridge 构建命令。
  - `docs/DEVELOPMENT_REFERENCE.md`：双轨开发指南（切轨调试、parity harness 用法）。
- **验收**：文档评审通过；命令可执行（干跑一遍）。

### T7.6 发版

- **做什么**：按仓库 `release:patch/minor` 流程发布；变更日志记录双轨能力。
- **验收**：发布成功，本地 `opencc`/zai 可运行。

## 4. 验收标准（G3 决策门）

1. 决策记录落盘，结论明确。
2. 默认内核翻转（如决策）可用且 kill switch 保真。
3. 双轨维护契约（如保留）文档化。
4. 文档收口完成，命令干跑通过。
5. 发版成功。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 默认翻转后 opencc 用户流失（行为变化） | 一次性迁移提示 + kill switch；默认翻转放在 minor 版本并写 changelog |
| vendor 退役评估不足导致事故 | 退役「只评估不执行」兜底；执行另立计划并逐批回归 |
| 双轨长期并存导致维护成本失控 | 维护契约明确定义过渡期限与默认轨道优先原则（主计划 R6） |
| 文档与实现漂移 | T7.5 干跑验证；AGENTS.md 规则可执行 |

## 6. 测试策略

- 回归：`pnpm -r test` 全量一次（默认翻转后）。
- 构建：`pnpm run build` + dsh-bridge build。
- 浏览器：默认内核下核心路径 smoke（ego-browser 1-2 场景）。
- kill switch 演练复核（翻转后 `'opencc'` 仍可用）。
