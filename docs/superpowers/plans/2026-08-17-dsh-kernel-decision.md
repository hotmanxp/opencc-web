# G2 决策评审记录 — 默认内核选择（opencc vs dsh）

> 日期：2026-08-22
> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> 所属子计划：[2026-08-17-dsh-kernel-batch-07-flip-cleanup.md](2026-08-17-dsh-kernel-batch-07-flip-cleanup.md)（T7.1）
> 关联交付：B6 验收报告 `docs/2026-08-17-dsh-known-differences.md`、B6 迁移工具、kill switch 演练记录
> 状态：**草稿 v1，待维护团队签字**

---

## 1. 决策时机与触发条件

### 1.1 触发条件（满足才进入本评审）

| # | 条件 | 状态 | 来源 |
|---|------|------|------|
| C1 | B-1 可行性尖峰通过（Node ≥22.19 / packed install / headless peers / Cordis teardown / globalThis 桥） | 已通过（2026-08-15，合入 `b7d8b130` 之前的 B2-B5 链路前提） | [main-plan §5](../plans/2026-08-17-dsh-kernel-main-plan.md#5-批次划分总览) |
| C2 | B0-B5 全部合入,无悬挂修复项 | 合入 commit `b7d8b130`（feat(dsh): B2-B5 — tools/MCP/skill/session/memory/interaction/subagent bridges） | git log |
| C3 | B6 双轨对等验收通过（parity harness 11 组事件全覆盖、ego-browser 双轨全场景、迁移工具 4 项守卫绿、kill switch 演练通过） | **进行中**（本评审基于 B6 工件定稿，预计合入时间 2026-08-22 之后） | [B6 plan §4](../../superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md#4-验收标准G2-决策门输入) |
| C4 | 已知差异清单 `docs/2026-08-17-dsh-known-differences.md` 完整、可追溯 | **B6 交付物**，与本记录同期定稿 | B6 T6.5 |
| C5 | dsh 版本锁（`save-exact` `0.1.0-rc.7`），升级不混批次 | 已锁定（package.json 中 `@deepseek-ai/dsh-*` 系列固定版本） | [main-plan R1](../plans/2026-08-17-dsh-kernel-main-plan.md#7-风险登记册) |

> **进入条件**：C1-C5 全部 ✓；当前 C3、C4 仍在 B6 收口中。本记录的最终结论待 C3/C4 落盘后由维护团队评审盖戳。

### 1.2 不进入本评审的兜底

若 C3 (B6 全绿) 或 C4 (差异清单定稿) 未达成，按 [main-plan §8 G2 未通过时的兜底](../plans/2026-08-17-dsh-kernel-main-plan.md#8-决策门Gate) 处理：
- 默认内核**保留 opencc**（零行为变化）。
- dsh 轨道**保留为可选**（`agent.kernel = 'dsh'` 显式启用）。
- B7 仅做文档收口与维护策略调整，不做翻转。

---

## 2. 评审参与方与维护责任

### 2.1 评审参与方

| 角色 | 名单（占位，按实际签字人填） | 责任 |
|------|------------------------------|------|
| 评审召集人（chair） | TBD | 主持评审、汇总结论、签字 |
| 维护工程师（opencc 轨道 owner） | TBD（opencc 兼容垫片维护者） | opencc 行为对等基线、kill switch 保真 |
| 维护工程师（dsh 轨道 owner） | TBD（dsh-bridge 维护者） | dsh 轨道适配、迁移工具、上游协同 |
| QA / 验收 owner | TBD（B6 验收报告作者） | 解释 parity harness / ego-browser 结论 |
| 版本发版 owner | TBD（release 流程 owner） | 翻转发版、kill switch 演练复核 |

### 2.2 维护团队责任（评审通过后生效）

- **默认轨道优先原则**（main-plan R6）：评审通过时决定的默认轨道为「合规修复优先 / 新功能可选」的基准轨道；非默认轨道仅维护必要修复与 kill switch 通路。
- **dsh 升级冻结窗口**：维护团队在评审前承诺未来 N 个 minor 版本内的 dsh 升级节奏（参见 `docs/2026-08-17-dsh-maintenance-contract.md`）。
- **kill switch 保真性**：评审通过后，无论默认轨道选哪条，另一条都必须在 1 次配置重启内可切换且无数据损坏（演练即 [B6 T6.4](../../superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md#T6.4-kill-switch-演练含-SSE-drain)）。
- **降级预案**：若默认翻转后 30 天内出现 R3/R5 类高风险触发（事件翻译偏差、权限模型冲突），自动回切默认轨道 — 评审记录中必须列入降级预案并指定 owner。

---

## 3. 已知差异清单引用

完整差异定稿存档于：[**`docs/2026-08-17-dsh-known-differences.md`**](../2026-08-17-dsh-known-differences.md)（B6 T6.5 交付）。

评审会议按差异逐条过，按下表给出处置：

| 差异 ID | 摘要 | 来源批次 | 影响范围 | 处置（接受 / 修复 / 驳回） | 责任 owner |
|---------|------|----------|----------|----------------------------|------------|
| KD-01 | dsh 会话事件溯源格式 ≠ zai jsonl | B3 | 历史会话不可直接续读 | 接受（B6 迁移工具 4 项守卫+ dry-run 默认） | TBD |
| KD-02 | dsh 工具 schema 校验更严格 | B2 | 非标工具可能被拒 | 修复（zai 工具 normalize 层） | TBD |
| KD-03 | 模型选择走 `installModelSelection` | B1 | provider/model 路由覆盖需桥 | 接受（已桥接） | TBD |
| KD-04 | 双轨引擎要求不同（Node ≥22.19 vs ≥20） | B0 | Node < 22.19 用户不可启 dsh | 接受（启动时 fail loud） | TBD |
| KD-05 | SESSION_FORMAT_VERSION=0 无兼容承诺 | B3 / B6 | 上游 dsh 升级可能拒旧 log | 接受（迁移器锁版本 + 升级独立批次） | TBD |
| KD-06 | Cordis 是 vendor 拷贝 + ABI 风险 | B0 | dsh 升级可能带动 Cordis ABI | 接受（仅用公开 API） | TBD |

> 评审会议逐条签字留痕（签字列在评审记录附页）。

---

## 4. 双轨维护契约

评审通过后下述契约一并生效，详细条款见 [docs/2026-08-17-dsh-maintenance-contract.md](../2026-08-17-dsh-maintenance-contract.md)（B7 T7.3 交付）。

### 4.1 默认轨道优先原则

- **无论 G2 选哪条作默认**，合规修复（H1 缺陷、安全 CVE、kill switch 通路）必须同时合入双轨。
- **新功能开发**默认在新非默认轨道不强制实现；若只在一轨实现，需在另一轨 stub 并文档化为「已知未支持」。
- **能力面对齐矩阵**（main-plan §4.4）是双轨支持的硬基线，降级需走评审，不允许无记录降级。

### 4.2 过渡期限

- **过渡态定义**：B7 合入后 90 天作为「双轨过渡期」。过渡期末维护团队复审，决议是否：
  - (a) 保留双轨（默认不动），进入「长期双轨」。
  - (b) 把另一轨退役（基于 [vendor 退役评估](../2026-08-17-dsh-vendor-retirement.md)）。
- 过渡期内不允许「静默弃轨道」：任何一轨若 90 天内无任何代码改动与可用性测试，必须显式标注 `maintenance-frozen` 并提供 kill switch 演练脚本。

### 4.3 版本锁定流程

- **dsh 依赖升级**：走独立批次（不混入 B 方案的工作），由 dsh 轨道 owner 单独提交 PR；批次内含：
  - `save-exact` 锁版本回写（含 `@deepseek-ai/dsh-*` 全系列）。
  - parity harness 重新跑全场景对比报告。
  - 若 SESSION_FORMAT_VERSION 改变或有破坏性 API，迁移器版本号必须联动。
- **opencc vendor 冻结**：opencc 0.20.0 vendor 拷贝已不再升级；只接受 zai 侧补丁（类型修复、zai 适配），不引入新特性。补丁走主仓库常规 PR。
- **关键原则**：上游 PR（向 dsh 仓库提）是修复高风险差异（KD-02 / KD-05）的优先路径；若上游短期不接受，本地 patch-version 兜底并文档化链接。

---

## 5. 决策选项矩阵

下表三选项为 G2 评审主线，**选其一**作为 zai `agent.kernel` 默认值。

### 5.1 选项 A — 保留 opencc 默认（**保守**）

| 维度 | 内容 |
|------|------|
| 默认值 | `agent.kernel = 'opencc'`（零行为变化） |
| 升级影响 | 无（兼容现状安装） |
| 默认轨道承诺 | opencc 仍是「合规修复+安全补丁」的主战场 |
| dsh 角色 | 可选内核（显式配置启用），保留为 R&D 中线 |
| vendor | opencc 0.20.0 vendor 冻结保留；不退役 |
| 过渡期限 | 双轨长期并存；以 90 天过渡期节奏复审 |

**优势**：
- **零升级回归**：所有现有用户（含 920x 正式服务）自动继续，零迁移成本。
- **风险最小**：不引入任何默认行为变化；与 main-plan §8 「G2 未通过时的兜底」同形。
- **保留 dsh 投资**：B0-B6 工作成果不撤销，作为可选项供追求新能力的用户启用。

**劣势**：
- **技术债延续**：opencc vendor 维护成本不降低（类型修复、compat 适配仍要跟 opencc 上游）。
- **dsh 投入回报低**：默认仍是旧轨，dsh-bridge workspace 活跃度取决于少数用户的自觉使用，可能逐步冷冻结。
- **长期路线不清**：用户无法感知 dsh 是过渡还是默认，故事讲不清楚。

### 5.2 选项 B — 切 dsh 默认（**激进**）

| 维度 | 内容 |
|------|------|
| 默认值 | `agent.kernel = 'dsh'`（行为变化） |
| 升级影响 | **需要 Node ≥22.19**；zai 设置一次性迁移提示 |
| 默认轨道承诺 | dsh 主战场；opencc 保留为 kill switch |
| dsh 角色 | 默认内核 + 唯一活跃开发轨道 |
| vendor | 评估退役路径（单独计划，[vendor-retirement eval](../2026-08-17-dsh-vendor-retirement.md)） |
| 过渡期限 | 翻转发版后 30 天观察期；触发降级预案回切 opencc |

**优势**：
- **技术债一次性清掉**：默认轨道引入独立 npm 依赖替代 vendor 拷贝，升级路径清晰。
- **能力扩展**：用户立刻享受 dsh 内核的事件溯源 Session、显式 hook、ScopedLayers 等能力。
- **战略一致**：与 main-plan §0 TL;DR「最终决策门：是否把默认内核切到 dsh」的预期方向一致。

**劣势**：
- **升级摩擦**：现有 920x 正式服务需升级 Node 到 ≥22.19；正式发版需走 minor（行为变化）。
- **dsh rc.7 风险**：dsh 是 rc.7 预发布，API/SESSION_FORMAT_VERSION 无兼容承诺；上游升级可能让用户的会话 log 失效（迁移器已兜底）。
- **回退成本**：一旦线上爆 R3/R5 等问题，需紧急回切默认轨道（kill switch 已演练，但要做变更公告）。

### 5.3 选项 C — 保留双轨 + kill switch 保真（**现状延寿**）

| 维度 | 内容 |
|------|------|
| 默认值 | `agent.kernel = 'opencc'`（保守默认） |
| 双轨承诺 | 两条都是「合规修复+安全补丁」必须同步支持 |
| vendor | opencc 0.20.0 vendor 冻结保留；dsh-bridge 维持 |
| 过渡期限 | 90 天过渡期；每季度复审 |

**优势**：
- **左右逢源**：不强制用户迁移，又能保证 dsh 投资持续可启用。
- **回退通道天然**：默认是 opencc，dsh 出问题只需 kill switch 切回，无需发版。
- **CI/试运行友好**：CI 可同时跑双轨 parity harness，bug 早期发现。

**劣势**：
- **维护成本最高**（main-plan R6）：双轨都得到 CI 全绿、单测全绿，否则任一条单测红都阻塞默认轨道。
- **能力增长慢**：新功能开发必须设计「双轨是否都做」决策，否则默认轨天然落后。
- **决策延期**：本质上是「再观察 90 天」，若 dsh 上游版本演进快，则短期内不切会累积更多迁移债。

### 5.4 决策选项对照

| 维度 | A 保留 opencc | B 切 dsh | C 延寿双轨 |
|------|--------------|----------|-----------|
| 升级摩擦 | 无 | minor 行为变化 + Node ≥22.19 强制 | 无 |
| 技术债清账 | 不清 | 一次性清 | 不清但有路径 |
| 维护成本 | 中（仅 opencc）| 中（仅 dsh）| 高（双轨） |
| 战略一致性 | 与 R6 兜底同 | 与 TL;DR 同 | 与 R6 过渡态同 |
| 回退速度 | N/A（默认即稳）| 中（kill switch 演练过）| 快（默认即 opencc） |
| 发版节奏 | 维持现状 | minor bump | 维持现状 |
| 用户感知 | 零变化 | 一次性迁移提示 + 行为变化 | 零变化 |

---

## 6. 推荐选项与理由

**初步建议：选项 C（保留双轨 + kill switch 保真，90 天后再复审）**。

理由：
1. **dsh rc.7 仍预发布**：kd-05 SESSION_FORMAT_VERSION=0 无兼容承诺；过早切默认会放大未来升级时的数据迁移风险。
2. **公开发版可控**：选项 B 是 minor 行为变化，需要写降级预案 + 一次性迁移提示；选项 C 不发版、零用户感知。
3. **dsh 进度可见化**：双轨 CI（parity harness）持续跑是收集真实数据的最佳手段，比决策会议拍板更可靠。
4. **决策可推迟、不可逆延**：90 天过渡期是硬节奏，到期必须二选一（保留为长期双轨 / 杀 opencc vendor / 切 dsh 默认）。

> 此推荐为评审输入之一，最终结论由评审会议按签字人意见敲定。**若评审组内出现 KD-05 级别上游承诺变化（例如 dsh 升 GA 并给出兼容承诺），可重新评估选项 B**。

---

## 7. 决策结论（评审会议填写）

> **本节留空白给评审会议填写**。

### 7.1 决议草案

- 选项：A / B / C / 其他（请填）
- 生效发版：占位标签（评审通过后由 release owner 填）
- 配套措施（强制项）：见 [maintenance-contract §5](../2026-08-17-dsh-maintenance-contract.md#5-配套执行项)（评审通过后维护团队按表执行）

### 7.2 签字栏

| 角色 | 姓名 | 签字 | 日期 |
|------|------|------|------|
| 评审召集人 |  |  |  |
| opencc 轨道 owner |  |  |  |
| dsh 轨道 owner |  |  |  |
| QA / 验收 owner |  |  |  |
| 版本发版 owner |  |  |  |

### 7.3 遗留项 / 豁免项

评审通过后任何未关闭遗留项按以下模板登记：

| ID | 描述 | 影响 | 责任 owner | 关闭条件 |
|----|------|------|------------|----------|
| LD-01 | TBD | TBD | TBD | TBD |

---

## 8. 关联文档索引

- 主计划：[2026-08-17-dsh-kernel-main-plan.md](../plans/2026-08-17-dsh-kernel-main-plan.md)
- B7 子计划：[2026-08-17-dsh-kernel-batch-07-flip-cleanup.md](../plans/2026-08-17-dsh-kernel-batch-07-flip-cleanup.md)
- B6 验收计划：[2026-08-17-dsh-kernel-batch-06-parity-acceptance.md](../plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md)
- 已知差异清单：[2026-08-17-dsh-known-differences.md](../2026-08-17-dsh-known-differences.md)（B6 交付）
- 维护契约：[2026-08-17-dsh-maintenance-contract.md](../2026-08-17-dsh-maintenance-contract.md)（B7 T7.3 交付）
- vendor 退役评估：[2026-08-17-dsh-vendor-retirement.md](../2026-08-17-dsh-vendor-retirement.md)（B7 T7.4 交付）
- 发版说明：[2026-08-17-dsh-release-notes.md](../2026-08-17-dsh-release-notes.md)（B7 T7.6 交付）

---

**版本**：v1（2026-08-22 草稿）
**维护**：dsh-bridge owner 维护评审签字栏；评审通过后此文档只追加 §7，不修改 §1-§6。
