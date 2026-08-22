# opencc vendor 退役评估（dsh 升默认后路径评估）

> 日期：2026-08-22
> 所属批次：B7（[2026-08-17-dsh-kernel-batch-07-flip-cleanup.md](superpowers/plans/2026-08-17-dsh-kernel-batch-07-flip-cleanup.md) T7.4）
> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)
> 维护契约：[2026-08-17-dsh-maintenance-contract.md](2026-08-17-dsh-maintenance-contract.md)
> G2 决策：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)
> 状态：**只评估不执行** — 当前批次为评估报告；**执行另立计划**
> 责任 owner：dsh-bridge owner（评审通过后）

---

## 0. TL;DR

opencc vendor（`packages/zn-agent-core/src/opencc-src/`）与 zai compat 垫片（`packages/zn-agent-core/src/compat/`）当前承载 zai 的所有默认内核行为。本评估报告的目的是 **盘点 vendor 退役路径**，给出影响面与分步移除计划。**当前决策：仅评估不执行**；G3 决策（vendor 退役）需要单独评审，且执行需走独立大工程批次。

- **影响面广**：6 大子系统 + 14+ 受影响文件 + 2 个数据目录交叉。
- **不建议立即移除**：opencc 仍是 G2 评审前/通过的默认候选 A；vendor 退役是默认翻转为 dsh **之后**才有意义。
- **必须保留 kill switch 保真**：即使决定退役，也必须留 `agent.kernel='opencc'` 配置兼容窗口。

---

## 1. vendor 现状盘点

### 1.1 文件级影响面

| 路径 | 角色 | 依赖 opencc? | 退役影响 |
|------|------|--------------|----------|
| `packages/zn-agent-core/src/opencc-src/` | opencc 0.20.0 verbatim 拷贝（un-stripped） | — | 必须直接处置 |
| `packages/zn-agent-core/src/compat/` | zai 专属兼容垫片（兼容 vendor 符号） | 强 | 全部重写 |
| `packages/zn-agent-core/src/bundle-entry.ts` | esbuild bundle 入口（聚合 vendor + compat re-export） | 强 | 重写入口 |
| `packages/zn-agent-core/scripts/bundle-opencc.ts` | esbuild 打包脚本（产出 `dist/opencc-core.mjs`） | 强 | 删除 / 改 dsh-bundle |
| `packages/zn-agent-core/src/opencc-src/server/*.d.ts` | bundle-entry 引用的 server types | 弱 | 仅 d.ts |
| `packages/zai/src/server/services/kernel/factories/opencc.ts` | opencc 轨道的 KernelAdapter 工厂 | 强 | 删除或冻结 |
| `packages/zai/src/server/services/kernel/globalThisBridge.ts` | globalThis 桥（`__zaiEventBus` 等） | 强 | 删除或冻结 |
| `packages/zai/src/server/services/agentRuntime.ts` | zai 顶层 runtime 装配 | 强 | 简化 |
| `packages/zai/src/server/services/transcript/persistence.ts` | transcript 持久化（jsonl） | 强 | dsh 路径替代 |
| `packages/zai/src/server/services/compact/` | 会话压缩 | 强 | dsh 路径替代 |
| `packages/zai/src/cli/index.ts` | CLI 入口 | 强 | 可能简化 |
| `packages/zai/src/server/services/zaiSettingsStore.ts` | settings 路径（含 agent.kernel schema） | 弱 | 仅保留 schema |
| `packages/zai/src/web/src/`（前端组件） | UI / store | 弱 | 仅 kernel 标识符渲染 |
| `packages/zai/test/kernel/parity/` | parity harness（11 组 ServerEvent） | 强 | 仅保留 dsh 单跑 |

### 1.2 数据目录影响面

| 路径 | 现状 | 退役后 |
|------|------|--------|
| `${ZAI_DATA_DIR}/projects/<cwd>/<sessionId>.jsonl` | opencc 会话 | 保留只读迁移器入口 |
| `${ZAI_DATA_DIR}/projects/<cwd>/dsh-sessions/<sessionId>/` | dsh 会话 | 唯一活跃 |
| `~/.zai/tasks/<taskId>.json` | opencc 任务 | 保留只读迁移器入口 |
| `~/.zai/tasks-dsh/<taskId>.json` | dsh 任务 | 唯一活跃 |
| `~/.zai/settings.json` | kernel 标识符 | 保留（kernel schema 不变） |

### 1.3 构建链路影响面

- `pnpm run build:core` 包含 `bundle-opencc` 步骤（产出 `dist/opencc-core.mjs` + `dist/bundle-entry.d.ts` + `dist/opencc-src/server/*.d.ts`）。
- `pnpm run build:zai`（tsc + vite）依赖 core bundle 的存在。
- `pnpm run build` 链式：core → zai。
- `scripts/verify-server-types-self-contained.mjs` 守护 server types self-contained。

---

## 2. 选项分析

### 2.1 选项 R1 — 完全移除 vendor

| 维度 | 内容 |
|------|------|
| 移除范围 | `packages/zn-agent-core/src/opencc-src/` 全部 + `compat/` 中 opencc 相关部分 + `bundle-opencc.ts` |
| 保留 | `factories/opencc.ts` 可删除（默认不启用）；保留 `agent.kernel` schema 仅取合法值 `'dsh' \| 'opencc'`，但运行时仅 dsh |
| 影响 | 大（影响面盘点全表） |
| 回退难度 | **极高**（移除即不可逆） |

**优势**：技术债彻底清零，构建链路简化。

**劣势**：
- 用户升级后无法再用 opencc（即便升级前一秒）。需要双发版 + 双分叉 window。
- 任何 dsh 上游问题 = zai 默认链路灾难（无 kill switch）。
- 风险最高，需独立大工程批次验证。

**建议时机**：dsh GA + opencc 上游至少 18 个月不活跃 + dsh 已正式 track ≥ 2 个 minor 版本无回归。

### 2.2 选项 R2 — 冻结 vendor（保留为 kill switch）

| 维度 | 内容 |
|------|------|
| 移除范围 | 无（vendor 保留） |
| 保留 | 全部 vendor + compat + bundle-opencc 链路；`factories/opencc.ts` 保留并维持显式启动路径 |
| 影响 | 无（仅文档化） |
| 回退难度 | **低**（配置 + 重启即切回） |

**优势**：
- 零代码风险。
- 给 dsh 默认切换做兜底保障。
- 与 [maintenance-contract §5](2026-08-17-dsh-maintenance-contract.md#5-opencc-vendor-冻结节奏) 自然对齐。

**劣势**：
- vendor 维护成本仍在（即便少量）。
- bundle 构建步骤保留，`pnpm run build:core` 不简化。

**建议时机**：B7 评审通过 + G2 默认选项为 B / C 时。

### 2.3 选项 R3 — 双轨长存

| 维度 | 内容 |
|------|------|
| 移除范围 | 无 |
| 保留 | 双轨全功能 |
| 影响 | 无 |
| 回退难度 | 中（默认轨道切换走配置 + 重启） |

**优势**：双轨都享有完整 active 维护，迁移风险最低。

**劣势**：main-plan R6 — 维护成本最高；与「双轨是过渡态，不是终态」精神相悖。

**建议时机**：仅在评审明确「双轨是终态」时。

### 2.4 选项对照

| 维度 | R1 完全移除 | R2 冻结保留 | R3 双轨长存 |
|------|------------|------------|------------|
| 维护成本 | 极低（无 vendor） | 低（最小补丁） | 高（双轨 active） |
| 回退能力 | 无（移除即不可逆） | 高（即配即切） | 高 |
| 与 main-plan R6 一致性 | 与「双轨过渡态」一致 | 一致 | 不一致 |
| 风险等级 | 极高 | 低 | 中 |
| 适合时点 | dsh GA + ≥ 2 minor 稳定窗口 | G2 评审通过 | G2 选 C 时 |

---

## 3. 风险登记

| ID | 风险 | 概率 | 影响 | 缓解 |
|----|------|------|------|------|
| VR-01 | vendor 移除破坏既有 opencc 单测 | 高 | 高 | 单批变更 + 单测先绿；CI 留证 |
| VR-02 | bundle 链路移除导致 zai 构建失败 | 中 | 高 | 重写 `bundle-entry.ts` + esbuild 替换为 dsh-bundle；新增构建验证单测 |
| VR-03 | transcript 路径移除导致历史 jsonl 不可读 | 中 | 高 | 保留只读迁移入口 + B6 迁移器升级为「读 opencc jsonl 写 dsh log」单向 |
| VR-04 | compact 模块移除导致会话压缩失败 | 中 | 中 | 默认切 dsh 后，压缩走 dsh cordis plugin；fallback 保留 |
| VR-05 | settings 中 kernel 标识符渲染（UI）受影响 | 中 | 低 | UI 仅渲染标识符文本，不耦合 vendor 路径 |
| VR-06 | `globalThis.__zai*` 桥移除导致回归 | 中 | 中 | B-1 已验证 drain 顺序；移除后跑全量回归 |
| VR-07 | 用户隐性依赖 vendor 类型（`@zn-ai/zn-agent-core` subpath 调用点） | 中 | 高 | 已废 subpath（B0 已切主入口）；再次审计 |
| VR-08 | 移除后 Cordis ABI 漂移导致 dsh-bridge 受影响 | 低 | 中 | 监控 dsh 上游版本；移除与 dsh 升级解耦 |

---

## 4. 分步移除计划（若 G3 决策为 R1「完全移除」）

> **本节是 R1 选项的具体执行路径，仅在评审通过 R1 后启用**。每步独立 PR、独立可回滚。

### 步骤 P1 — vendor 同步冻结标记

- **做什么**：
  - 在 `packages/zn-agent-core/src/opencc-src/` 根添加 `README-FROZEN.md`，明示不再升级。
  - CI 加 assertion：vendor 内容哈希必须与基线一致（防止误改）。
- **验证**：`pnpm -r test` 全绿。
- **回滚**：移除标记文件即可。

### 步骤 P2 — compat 适配层收紧

- **做什么**：
  - `packages/zn-agent-core/src/compat/` 中只保留 zai 专属别名，不再对外暴露 vendor 符号。
  - `bundle-entry.ts` 改为「仅暴露 plugin DTO + compat 公共面」。
- **验证**：单测 + egde-case 兼容（dsh 工厂不依赖 compat）。
- **回滚**：compat 路径可独立回滚。

### 步骤 P3 — 数据迁移器升级（B6 迁移器单向化）

- **做什么**：
  - `migrate.ts` 升为「opencc 只读 + dsh 写」单向工具，禁止写回 opencc 路径。
  - `sessions/<sessionId>.jsonl` 暴露为只读归档（前端不展示迁移前的会话，仅可手动迁移）。
- **验证**：迁移 1 个真实会话到 dsh；续读成功。
- **回滚**：迁移器版本回退 + 会话保留原 jsonl。

### 步骤 P4 — 构建链路简化

- **做什么**：
  - `bundle-opencc.ts` 删除。
  - `bundle-entry.ts` 不再 import opencc-src。
  - `pnpm run build:core` 改为只编译 compat + dsh bridge 共用类型。
  - `scripts/verify-server-types-self-contained.mjs` 守护更新。
- **验证**：`pnpm run build` 全绿 + bundle 体积显著下降（预期去除 vendor bundle ≈ 7MB）。
- **回滚**：保留 git tag 标记的回滚点。

### 步骤 P5 — opencc KernelAdapter 工厂冻结

- **做什么**：
  - `packages/zai/src/server/services/kernel/factories/opencc.ts` 改为「显式启动入口」，启动即 `console.warn('opencc is frozen, please migrate to dsh')` 并继续工作。
  - `KernelAdapter` 接口保留开放。
- **验证**：kill switch 演练（`agent.kernel='opencc'` 仍可启 zai）。
- **回滚**：恢复 OpenccKernelAdapter 行为不变。

### 步骤 P6 — 设置 schema 收口

- **做什么**：
  - `zaiSettingsStore` 的 `agent.kernel` enum 改为 `['dsh']`（移除 `'opencc'`），但保留读取兼容（读到 `'opencc'` 时启动自动迁移 + 警告）。
  - 老用户 settings 升级路径：首次启动时若值为 `'opencc'` 自动改写 `'dsh'` 并 backup。
- **验证**：settings 单元测试覆盖旧值升级路径。
- **回滚**：schema 还原为 enum 双值。

### 步骤 P7 — vendor 路径实际删除

- **做什么**：
  - 删除 `packages/zn-agent-core/src/opencc-src/` 全部。
  - 删除相关 `compat/opencc/*`（保留 zai 专属部分）。
  - 更新所有引用文件。
  - README / 文档移除 vendor 引用。
- **验证**：`pnpm -r test` 全绿 + dsh 端到端 smoke + bundle 体积再降。
- **回滚**：vendor git 路径完整保留可恢复（git revert P7）。

### 步骤 P8 — 文档与发版说明

- **做什么**：
  - 更新 `AGENTS.md` 移除 vendor 章节。
  - 更新 `docs/DEVELOPMENT_REFERENCE.md` 移除 vendor 双轨说明。
  - [release-notes](../2026-08-17-dsh-release-notes.md) 增补「vendor 退役条目」。
- **验证**：文档评审通过 + 链接全部有效。
- **回滚**：文档 PR revert。

### 4.1 总览时间线（每步 ≥ 1 个 minor 版本间隔）

```
P1（冻结标记） → P2（compat 收紧） → [1 个 minor 版本观察]
                                           ↓
                                      P3（迁移器单向化） → P4（构建简化）
                                           ↓
                                      P5（工厂冻结） → P6（schema 收口）
                                           ↓
                                      P7（删除 vendor） → P8（文档收口）
```

---

## 5. 当前结论

- **本批（B7）只评估不执行**：所有分步移除（P1-P8）不进入本批次；执行另立计划，走 main-plan §8 G3 决策门。
- **建议默认决策**：G2 默认选 B（切 dsh 默认） + G3 选 R2（冻结保留 vendor 作为 kill switch）；R1（完全移除）延后至 dsh GA + 稳定 ≥ 2 minor 后再评审。
- **强制兜底**：无论 G3 选 R1/R2，kill switch 保真（`agent.kernel='opencc'` 启动兼容）必须保留到 dsh GA + ≥ 6 个月用户平稳期。

---

## 6. 关联文档

- 主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)（§4.4 能力面、§7 风险登记册）
- 评审记录：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)
- 维护契约：[2026-08-17-dsh-maintenance-contract.md](2026-08-17-dsh-maintenance-contract.md)（vendor 冻结节奏）
- B6 计划：[2026-08-17-dsh-kernel-batch-06-parity-acceptance.md](superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md)（迁移工具原型）
- B7 计划：[2026-08-17-dsh-kernel-batch-07-flip-cleanup.md](superpowers/plans/2026-08-17-dsh-kernel-batch-07-flip-cleanup.md)（T7.4）

---

**版本**：v1（2026-08-22 草稿）
**评审通过触发器**：G3 决策门评审（G2 通过 + 无未解高风险）
**执行 owner**：dsh-bridge owner（评审通过后）
