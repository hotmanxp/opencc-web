# dsh 双轨已知差异清单（开放维护中）

> 日期：2026-08-22（与 B6/B7 同步推进）
> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md) §6.1
> 所属批次：B6 T6.5（定稿）/ B7 T7.1（评审）
> 状态：**开放维护** — 任何新发现的差异均按本文件模板登记（含来源 / 影响 / 处置 / 责任 owner）
> 评审：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)

---

## 1. 用途与维护规则

本清单记录 zai 双轨改造（opencc + dsh）过程中所有**未被修复、暂被接受**的行为差异。每条差异必须满足：

- **可追溯**：来源批次（B0-B7）、关联单测 / 用户报告 / dsh 版本。
- **有处置**：补丁 / 文档化 / 上游 PR / 与 dsh 版本绑定 之一。
- **有 owner**：差异责任方（opencc owner / dsh owner / QA）。

G2 评审会议按本清单逐条签字。评审通过后任何新增条目走 PR 流程补登，不允许「静默差异」。

---

## 2. 差异登记表

### KD-01 — dsh 会话事件溯源格式 ≠ zai jsonl

| 字段 | 内容 |
|------|------|
| 来源批次 | B3（首次记录）+ B6（T6.3 迁移工具落地） |
| 影响 | opencc jsonl 历史会话在 dsh 轨道不可直接续读 |
| 可接受性 | 可接受（dsh 设计上 `SESSION_FORMAT_VERSION=0` 无兼容承诺） |
| 处置 | B6 迁移工具（`packages/zai/src/server/services/kernel/migrate.ts`）— 锁定 dsh 版本 + 幂等 + 校验 + 回滚 + dry-run 默认 |
| 责任 owner | TBD（dsh 轨道 owner，评审签字前占位） |
| dsh 版本绑定 | 0.1.0-rc.7 |
| 状态 | **接受** |

### KD-02 — dsh 工具 schema 校验更严格（JSON Schema）

| 字段 | 内容 |
|------|------|
| 来源批次 | B2（T2.x 工具 normalize） |
| 影响 | 非标工具 schema（缺 `required`、`additionalProperties`）被 dsh 拒绝 |
| 可接受性 | 部分可接受（多数工具已 normalize） |
| 处置 | zai 工具 normalize 层（B2 落地）+ 上游 PR（若有通用工具） |
| 责任 owner | TBD |
| dsh 版本绑定 | 0.1.0-rc.7+ |
| 状态 | **修复**（已落地，监控） |

### KD-03 — 模型选择走 `installModelSelection`

| 字段 | 内容 |
|------|------|
| 来源批次 | B1a |
| 影响 | zai 的 provider/model 路由覆盖需要桥接到 dsh |
| 可接受性 | 可接受（已桥接） |
| 处置 | `packages/zai/src/server/services/kernel/factories/dsh.ts` 内模型桥 |
| 责任 owner | TBD |
| dsh 版本绑定 | 0.1.0-rc.7 |
| 状态 | **接受** |

### KD-04 — 双轨引擎要求不同

| 字段 | 内容 |
|------|------|
| 来源批次 | B0（T0.7 引擎检查前置） |
| 影响 | Node < 22.19 用户无法启用 dsh 模式 |
| 可接受性 | 可接受（启动 fail loud，强制升级） |
| 处置 | `createKernel` 启动前 `nodeSupportsDsh()` 检查 + 仓库 `engines` 升至 `^22.19.0 \|\| >=24.0.0` |
| 责任 owner | TBD |
| 状态 | **接受** |

### KD-05 — SESSION_FORMAT_VERSION=0 无兼容承诺

| 字段 | 内容 |
|------|------|
| 来源批次 | B3 + B6（T6.3 迁移器版本锁定） |
| 影响 | 上游 dsh 升级可能拒绝旧格式 log |
| 可接受性 | 有条件接受（升级批次必须验证迁移器重演） |
| 处置 | 迁移器绑定 `installed('@deepseek-ai/dsh-headless')` 版本；版本不一致报错；dsh 升级走独立批次 + 上游 PR |
| 责任 owner | TBD |
| dsh 版本绑定 | 全版本 |
| 状态 | **接受 + 升级流程约束** |

### KD-06 — Cordis 是 vendor 拷贝 + ABI 风险

| 字段 | 内容 |
|------|------|
| 来源批次 | B0（T0.x 风险登记 R9） |
| 影响 | dsh 升级可能带动 Cordis ABI 变化 |
| 可接受性 | 可接受（dsh-bridge 仅用 Cordis 公开 API） |
| 处置 | [maintenance-contract §4](../2026-08-17-dsh-maintenance-contract.md#4-dsh-依赖升级流程) — 升级批次必须做 ABI 风险评估 |
| 责任 owner | TBD |
| 状态 | **接受** |

---

## 3. 其他轻量差异（暂未单独立 ID）

| 差异 | 备注 |
|------|------|
| dsh `state.*` 事件投影 vs opencc 直接订阅 | 订阅面一致，dsh 多走一层 Translator（B1b 落地） |
| 嵌套子 agent 路径：dsh 用 ScopedLayers，opencc 用 BackgroundRuntime | 行为对等（B5 验收通过） |
| 插件元数据加载：双轨复用 `~/.zai/plugins/` + `~/.agents/skills/` | 数据源统一 |
| 模型:dsh 走 dsh-tools 的 `installModelSelection` 而非 `env` | KD-03 子集 |

---

## 4. 变更记录

| 日期 | 作者 | 变更 |
|------|------|------|
| 2026-08-22 | B7 owner | 初版占位（B6 T6.5 定稿后由 dsh owner 接手维护） |

---

## 5. 关联文档

- 主计划 §6.1：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md#61-已知差异记录预期允许须显式文档化)
- G2 决策：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)（逐条签字）
- 维护契约：[2026-08-17-dsh-maintenance-contract.md](../2026-08-17-dsh-maintenance-contract.md)
- vendor 退役评估：[2026-08-17-dsh-vendor-retirement.md](../2026-08-17-dsh-vendor-retirement.md)
