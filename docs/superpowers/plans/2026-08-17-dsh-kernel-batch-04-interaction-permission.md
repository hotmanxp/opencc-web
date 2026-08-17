# Batch 4 — 交互与权限

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> 目标：dsh 轨道的交互能力面对齐——权限审批（approve）、AskUserQuestion、permissionMode 语义。**依赖 B2**（审批触发点在工具执行；审查对主计划 DAG 的修正）。

---

## 1. 目标

- dsh 轨道工具调用触发权限审批时，前端出现与 opencc 轨道一致的审批弹窗（SSE `prompt.ask` / `/api/approve` 流程）。
- AskUserQuestion（用户多选提问）在 dsh 轨道可用，前端交互与 opencc 轨道一致。
- `permissionMode`（bypass / ask / deny 等）在 dsh 轨道语义对齐。
- zai 的 permissionRegistry / approveRegistry / askRegistry 作为统一入口，dsh 交互通过桥接入。

## 2. 前置条件

- **B1a + B2**（dsh 长驻运行时 + 模型桥；审批触发点在工具执行 —— 审查修正：B4 不可早于 B2）。B1b 不阻塞。
- 盘点 zai 交互链路：`approveRegistry.ts`、`askRegistry.ts`、`requestApproveTool`、`routes/approve.ts`、`routes/agent.ts` 的 `prompt.ask` 通道。
- 盘点 dsh 交互 seam：`packages/interaction/` 下 `user-approval`、`tool-ask-user`、`user-questions`、`permission-presets`、`commands` 的 Service Definition / Provider / Consumer 结构。

## 3. 任务清单

### T4.1 交互桥架构

- **做什么**：设计 dsh 交互 → zai registry 的桥：dsh 的 approval / ask-user Consumer 请求回调到 zai `approveRegistry` / `askRegistry`，zai 前端交互结果回传 dsh Provider。
- **文件**：`packages/dsh-bridge/src/interaction/bridge.ts`（接口 + 注册）。
- **验收**：桥接口单测通过（mock 两侧）。

### T4.2 权限审批桥（approval）

- **做什么**：dsh `user-approval` seam 的 Consumer 接入 zai `approveRegistry`；审批弹窗、超时、拒绝、允许 + 记忆规则（"always allow"）语义对齐。
- **文件**：`packages/dsh-bridge/src/interaction/approval.ts`。
- **验收**：dsh 轨道执行需审批的命令时前端弹窗；允许/拒绝/记忆选择均生效。

### T4.3 AskUserQuestion 桥

- **做什么**：dsh `tool-ask-user` / `user-questions` seam 接入 zai `askRegistry` + `/api/agent/answer` 链路；选项、多选、自由输入交互对齐。
- **文件**：`packages/dsh-bridge/src/interaction/askUser.ts`。
- **验收**：dsh 轨道对话中触发 AskUserQuestion，前端问答交互完成并回流模型。

### T4.4 permissionMode 映射

- **做什么**：把 zai 的 `permissionMode`（bypassPermissions 默认等）映射到 dsh 的 permission 策略（`permission-presets` 或自定义补丁）；`agent.kernel` 切换时模式一致。
- **文件**：`packages/dsh-bridge/src/interaction/permissionMode.ts`。
- **验收**：bypass 模式下 dsh 轨道不弹审批（对齐现状）；ask 模式下行为一致。

### T4.5 审批超时与并发

- **做什么**：对齐 zai 的审批超时、并发审批队列语义（`approveRegistry` 现状行为）；dsh 侧桥不破坏现有队列。
- **文件**：`packages/dsh-bridge/src/interaction/`（补丁）。
- **验收**：并发多个审批请求时队列行为与 opencc 轨道一致（单测覆盖）。

## 4. 验收标准

1. dsh 轨道：审批弹窗（allow / reject / remember）全流程可用，SSE 事件与前端一致。
2. dsh 轨道：AskUserQuestion 前端交互可用。
3. permissionMode 双轨语义一致（bypass / ask 场景各验一次）。
4. opencc 轨道回归：approve / ask 相关单测绿。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh 交互 seam 的 Service Definition 与 zai registry 模型不匹配 | 桥层做显式适配（T4.1 先定接口）；不修改 dsh 包本体 |
| 审批弹窗事件时序（dsh 事件流 vs SSE） | 以 zai `prompt.ask` 通道为契约，dsh 事件翻译处对齐时序 |
| dsh 的 remember/规则记忆与 zai permissionRegistry 规则存储冲突 | 规则存储仍走 zai registry；dsh 侧只做请求转发 |
| 超时/取消语义差异 | T4.5 补丁对齐；差异记录到 B6 已知差异清单 |

## 6. 测试策略

- 单测：桥接口、approval 全流程（允许/拒绝/记忆/超时）、askUser 交互、permissionMode 映射。
- 集成：dsh 轨道触发审批命令（如写入受保护目录）验证弹窗回流。
- 回归：opencc 轨道 `approveRegistry` / `askRegistry` 相关单测。
- ego-browser：dsh 轨道审批弹窗 + AskUserQuestion 问答的真实浏览器验证。
