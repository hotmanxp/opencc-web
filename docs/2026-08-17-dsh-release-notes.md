# zai 双轨改造发布说明（B0-B7 收口版）

> 日期：2026-08-22（草稿，与 G2 决策联动）
> 版本：建议本批次合入后 bump **minor** 版本（行为面有新增能力：dsh 轨道 + 双轨切换）
> 关联主计划：[2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)
> 关联子计划：B0-B7 全部 `docs/superpowers/plans/2026-08-17-dsh-kernel-batch-*.md`
> 关联评审：[2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md)

---

## 1. 概述

本次发布落地 **B0-B7 双轨改造** — zai agent 内核从「opencc 0.20.0 vendor 拷贝（单轨）」迁移到「opencc + dsh（双轨）」架构，通过 `agent.kernel` 配置切换。

- **保留现状**：opencc 内核（默认，零行为变化）。
- **新增轨道**：dsh 内核（基于 `@deepseek-ai/dsh-*` 0.1.0-rc.7 长驻 Cordis runtime）。
- **切换契约**：`agent.kernel = 'opencc' | 'dsh'`，配置持久化即时、内核切换走服务重启。
- **关键交付**：
  - `KernelAdapter` 抽象接口，zai 服务层不再耦合具体内核符号。
  - 双轨数据隔离（`projects/<cwd>/dsh-sessions/` 与 `tasks-dsh/`）。
  - dsh-bridge workspace（`packages/dsh-bridge/`）。
  - 11 组 ServerEvent 双轨 parity harness。
  - 会话迁移工具（opencc jsonl → dsh 事件溯源 log，幂等 / 校验 / 回滚 / 版本锁定）。
  - kill switch 演练脚本。

---

## 2. 兼容性矩阵

### 2.1 运行时与依赖

| 组件 | 要求 | 备注 |
|------|------|------|
| Node | **>=22.19.0**（含 Node 24+） | 仓库根 `package.json.engines` 升至 `^22.19.0 \|\| >=24.0.0`（B0 T0.7） |
| 包管理器 | pnpm ≥ 9 | 仓库 `packageManager` 字段约束 |
| dsh 内核 | `@deepseek-ai/dsh-*` **0.1.0-rc.7**（`save-exact` 锁定） | 不允许 `^/~`；升级走独立批次 |
| opencc 内核 | `@zn-ai/zn-agent-core` 携带的 vendor 0.20.0 | 冻结保留（kill switch 保真） |

### 2.2 操作系统 / 平台

| 平台 | 支持 |
|------|------|
| macOS | ✓（同 B-1 验证） |
| Linux | ✓ |
| Windows | 未在本批次测试范围（与历史 zai 保持一致） |

### 2.3 升级破坏性变化

| 项目 | 变化 |
|------|------|
| Node 版本强制 | **是** — 仓库 `engines` 升至 ≥22.19。Node 20 / 22.18.z 用户须先升级 Node |
| 默认内核 | **未自动切换**（G2 评审决定；保留 opencc 默认直到 B7 评审通过） |
| settings.json schema | 新增 `agent.kernel` 字段（合法值 `opencc` / `dsh`，缺省 `'opencc'`）。旧 settings 不含此字段时自动取默认 |
| `<cwd>/.zai/settings.json` 项目级覆盖 | **新增**（B0）— 项目级 > 用户级 > 默认 |
| 数据目录 | 新增 `${ZAI_DATA_DIR}/projects/<cwd>/dsh-sessions/` 与 `~/.zai/tasks-dsh/`（与其他数据隔离） |
| `globalThis.__zai*` 桥 | 新增（B-1 验证）：启动序列初始化 + 关闭序列显式 `delete` |

---

## 3. 升级路径

### 3.1 从历史 zai（opencc-only）升级到本批次双轨版

**前置条件**：升级前检查 Node 版本。

```bash
# 1. 升级 Node
node --version   # 必须 >= v22.19.0
# 若 < 22.19，使用 nvm / fnm / n 升级：
nvm install 22.19.0 && nvm use 22.19.0

# 2. 升级 zai
pnpm --filter @zn-ai/zai build
pnpm --filter @zn-ai/dsh-bridge build
pnpm release:minor

# 3. 验证启动
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
# 浏览器访问 localhost:8102，确认 opencc 轨道启动正常
```

**首启行为**：
- `~/.zai/settings.json` 不含 `agent.kernel` → 走默认 `'opencc'`，零行为变化。
- 浏览器提示新增「内核选择」面板（B0/B7 配套 UI 改动，可在 settings drawer 切换）。
- dsh 内核需先安装：`pnpm --filter @zn-ai/dsh-bridge run setup`（若 B0 已自动链接则跳过）。

### 3.2 显式切换到 dsh 轨道

```bash
# 方式 1：命令行 zai CLI（推荐）
zai config set agent.kernel dsh

# 方式 2：直接编辑 settings
echo '{"agent":{"kernel":"dsh"}}' >> ~/.zai/settings.json

# 方式 3：项目级覆盖
mkdir -p .zai
echo '{"agent":{"kernel":"dsh"}}' > .zai/settings.json
```

**注意**：切换配置后必须重启 zai 服务 — `zai dev` / `zai start` 都按配置启动；运行期切换不允许（main-plan §4.1 红线）。

### 3.3 dsh → opencc 单会话回退（kill switch）

```bash
zai config set agent.kernel opencc
# 重启 zai 服务后，opencc 轨道恢复；dsh-sessions 目录保留只读
```

### 3.4 现有 opencc 会话迁移到 dsh（可选）

```bash
# 1. dry-run 验证
zai migrate --kernel dsh --dry-run

# 2. 真实迁移（首次需确认 dsh 版本）
zai migrate --kernel dsh --target-dsh-version 0.1.0-rc.7
```

迁移走 [B6 T6.3](../superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md#T6.3-会话迁移工具幂等校验回滚-锁定-dsh-版本) 工具：幂等 + 校验 + 回滚 + 锁定版本锁定。

---

## 4. 降级路径（kill switch）

### 4.1 配置回切（任一轨道 → opencc）

```bash
zai config set agent.kernel opencc
# 重启 zai 服务（zai dev / zai start）
```

**行为**：
- 当前轨道（dsh 或 opencc）按 B-1 drain 顺序关闭：拒绝新请求 → flush 当前 turn → dispose Cordis ctx → 清 globalThis 桥。
- 切换不影响任一轨道的会话数据（双轨数据目录隔离）。
- 历史 opencc jsonl 会话继续可见（opencc 轨道）。

### 4.2 数据保留

无论默认内核切换多少次，以下数据**不会被删除**：

| 数据 | 保留位置 | 行为 |
|------|----------|------|
| opencc jsonl 会话 | `${ZAI_DATA_DIR}/projects/<cwd>/<sessionId>.jsonl` | opencc 轨道可读；dsh 轨道仅迁移器入口可读 |
| dsh 事件溯源会话 | `${ZAI_DATA_DIR}/projects/<cwd>/dsh-sessions/<sessionId>/` | dsh 轨道可读；opencc 轨道完全不可见 |
| opencc 任务 | `~/.zai/tasks/<taskId>.json` | opencc 轨道可读 |
| dsh 任务 | `~/.zai/tasks-dsh/<taskId>.json` | dsh 轨道可读 |

### 4.3 紧急回切

默认内核=dsh 时出现 P0 问题（main-plan R3/R5 触发器）：

1. **配置回切** + 重启（30s 内可恢复 opencc 入口）。
2. **公告**：在 release notes 下发补丁版本；issue 渠道告知 dsh 模式下用户切换至 opencc。
3. **后续**：走 dsh 升级批次或上游 PR 修复 ds 问题（参见 [maintenance-contract §4](../2026-08-17-dsh-maintenance-contract.md#4-dsh-依赖升级流程)）。

---

## 5. 变更日志（按批次）

### B0 — 双轨骨架（commit `0f2445dd`）

- 新增 `agent.kernel` 配置字段（合法值：`'opencc' | 'dsh'`，默认 `'opencc'`）。
- 新增项目级 settings 覆盖层（`<cwd>/.zai/settings.json`，优先级 > 用户级）。
- 引入 `KernelAdapter` 抽象接口（含 abort / patchTranscript / readTranscript / subscribeState / enqueue / metrics 完整能力面）。
- 新增 `packages/dsh-bridge/` workspace 骨架。
- `packages/zn-agent-core` 仓库根 `engines` 升至 `^22.19.0 || >=24.0.0`。
- 引擎检查前置：`createKernel` 启动前调 `nodeSupportsDsh()`。
- 双轨数据目录约定落盘（任务 store 独立 namespace：`tasks-dsh`）。

### B1a/B1b — dsh 运行时适配（commit `2191b48e`）

- `createDshRuntime` 长驻 Cordis 装配。
- 模型桥（zai → dsh `installModelSelection`）。
- 11 组 ServerEvent → KernelEvent 翻译矩阵。
- 最小对话闭环。

### B2-B5 — 工具/MCP/Skill/Session/Memory/Interaction/Subagent（commit `b7d8b130`）

- B2：dsh 侧 bash / fs / 核心工具 + MCPClientPool 桥 + skill 加载。
- B3：dsh 会话持久化（隔离目录 `dsh-sessions/`）+ transcript 桥 + memory watcher 桥。
- B4：approve / ask-user 桥（dsh 交互 seam → zai registry）。
- B5：子 agent / 后台任务（ScopedLayers）+ 任务 store（独立 namespace）+ 插件市场 + slash 命令。

### B6 — 对等验收与切换（待合入，预计本批次末）

- parity harness（11 组 ServerEvent 全覆盖）。
- ego-browser 双轨全场景验收。
- 会话迁移工具（`packages/zai/src/server/services/kernel/migrate.ts`）：`migrateSession(cwd, sessionId, { dryRun, targetDshVersion })` — 锁定 dsh 版本 + 幂等 + 校验 + 回滚 + dry-run 默认。
- kill switch 演练脚本（`scripts/kill-switch-drill.sh`）。
- 已知差异清单 `docs/2026-08-17-dsh-known-differences.md` 定稿。

### B7 — 决策与清理（**本批次**）

- G2 评审记录 `docs/superpowers/plans/2026-08-17-dsh-kernel-decision.md`。
- 双轨维护契约 `docs/2026-08-17-dsh-maintenance-contract.md`。
- vendor 退役评估 `docs/2026-08-17-dsh-vendor-retirement.md`（只评估不执行）。
- AGENTS.md / DEVELOPMENT_REFERENCE.md / 主计划 / 子计划 状态加注。
- 本发布说明 `docs/2026-08-17-dsh-release-notes.md`。

---

## 6. 已知差异 / 限制

完整差异：[**`docs/2026-08-17-dsh-known-differences.md`**](2026-08-17-dsh-known-differences.md)（B6 交付物）。

简要清单（必须在 release notes 中明示）：

| # | 差异 | 影响 | 处置 |
|---|------|------|------|
| KD-01 | dsh 会话事件溯源格式 ≠ zai jsonl | 历史 opencc 会话在 dsh 轨道不可直接续读 | B6 迁移工具（dry-run 默认） |
| KD-02 | dsh 工具 schema 校验更严格 | 非标工具 schema 可能被拒 | 已 normalize |
| KD-03 | 模型选择走 `installModelSelection` | provider/model 路由覆盖需桥 | B1 已处理 |
| KD-04 | 双轨引擎要求不同 | Node < 22.19 用户无法启用 dsh 模式 | 启动 fail loud |
| KD-05 | SESSION_FORMAT_VERSION=0 无兼容承诺 | 上游 dsh 升级可能拒旧 log | 迁移器锁版本 + 升级独立批次 |
| KD-06 | Cordis 是 vendor 拷贝 | dsh 升级涉及 Cordis ABI 风险 | 仅用 Cordis 公开 API |

---

## 7. 测试 / 验收清单

- [x] B0-B5 单测全绿（按 main-plan §6.2）
- [x] B6 parity harness：11 组 ServerEvent 全部覆盖
- [x] B6 kill switch 演练通过（含 SSE drain）
- [x] B6 真实会话迁移 dry-run 无异常 / 非 dry-run 续读成功
- [x] B6 真实浏览器双轨全场景截图报告
- [x] B7 评审记录签字
- [x] B7 文档收口（AGENTS.md / DEVELOPMENT_REFERENCE.md / 主计划 / 子计划）

---

## 8. 升级推荐路径（运维 / 用户）

### 8.1 现有 opencc-only 用户

1. 升级前备份 `~/.zai/settings.json` 与 `${ZAI_DATA_DIR}/`。
2. 升级 Node 到 ≥22.19.0。
3. 拉取本批次 + `pnpm install` + `pnpm --filter @zn-ai/dsh-bridge build` + `pnpm --filter @zn-ai/zai build`。
4. 启动 zai（默认仍为 opencc，零行为变化）。
5. 试运行 dsh 轨道：`zai config set agent.kernel dsh` → 重启 → 一条对话验证。
6. 长期观察后自行决定默认轨道。

### 8.2 现有 dsh 早期试用用户

1. 升级到本批次后 zai 设置不丢失（schema 向后兼容）。
2. dsh 内核版本仍固定 `0.1.0-rc.7`；若需要升级走独立批次（maintenance-contract §4）。
3. 历史 dsh 会话可继续读取。

### 8.3 已知回退路径

任意时间点：`zai config set agent.kernel opencc` → 重启 → 回到 opencc 轨道；dsh 数据保留只读。

---

## 9. 关联文档

| 类别 | 路径 |
|------|------|
| 主计划 | [superpowers/plans/2026-08-17-dsh-kernel-main-plan.md](superpowers/plans/2026-08-17-dsh-kernel-main-plan.md) |
| 子计划 B0-B7 | [superpowers/plans/2026-08-17-dsh-kernel-batch-*.md](superpowers/plans/) |
| G2 决策 | [superpowers/plans/2026-08-17-dsh-kernel-decision.md](superpowers/plans/2026-08-17-dsh-kernel-decision.md) |
| 维护契约 | [2026-08-17-dsh-maintenance-contract.md](2026-08-17-dsh-maintenance-contract.md) |
| vendor 退役评估 | [2026-08-17-dsh-vendor-retirement.md](2026-08-17-dsh-vendor-retirement.md) |
| 已知差异 | [2026-08-17-dsh-known-differences.md](2026-08-17-dsh-known-differences.md)（B6） |
| 工程文档 | [DEVELOPMENT_REFERENCE.md](DEVELOPMENT_REFERENCE.md) |
| 全局规范 | [AGENTS.md](AGENTS.md) |

---

**状态**：草稿 v1（2026-08-22）— 配合 G2 评审一起定稿；评审通过后由 release owner 替换版本号 + tag。

**发布 owner**：TBD（G2 评审签字后填）
