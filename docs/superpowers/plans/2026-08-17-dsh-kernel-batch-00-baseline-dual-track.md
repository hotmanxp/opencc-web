# Batch 0 — 基座与双轨骨架

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> **状态**：✅ 已合入（commit `0f2445dd`，2026-08-15）— G0 决策门验证通过
> 前置：**B-1 可行性尖峰**（主计划 §5）必须通过——节点引擎要求、packed install、headless peers、长驻 Cordis teardown、globalThis 清理协议验证。尖峰失败 → 本批阻塞。
> 目标：搭建双轨骨架——配置开关、KernelAdapter 接口、工厂分叉、opencc 轨道原样封装、dsh-bridge workspace 空骨架。**本批不改任何内核行为。**

---

## 1. 目标

- `agent.kernel: 'opencc' | 'dsh'` 配置可解析，`'opencc'`（默认）路径行为与现状完全一致。
- 项目级覆盖层（`<cwd>/.zai/settings.json`）实现——**当前 `zaiSettingsStore` 只支持用户级**（无实现），B0 需新增或简化为只用用户级。
- `KernelAdapter` 接口定型（含 abort / patchTranscript / readTranscript / state 订阅 / metrics，§3.1 主计划），zai 服务层不再直接 import vendor 符号（渐进替换）。
- `packages/dsh-bridge` workspace 骨架就位（可 build、可 `import()`、`agent.kernel='dsh'` 时有明确报错或最小桩输出）。
- 引擎检查前置：`createKernel` 之前检查 `process.version`，Node < 22.19 + `kernel='dsh'` 立即 fail loud。
- 双轨数据目录约定落盘（文档 + 常量），含任务 store 独立 namespace。

## 2. 前置条件

- **B-1 尖峰通过**（主计划 §5 + G-1 决策门）。
- 确认 dsh 仓库可访问：`pnpm dsh --profile headless "say hello"` 能在本地跑通（验证 dsh headless bundle 可用）。

## 3. 任务清单

### T0.1 配置 schema 扩展 + 项目级覆盖层

- **做什么**：
  1. `zaiSettingsStore` 增加 `agent.kernel`（`z.string().enum(['opencc','dsh']).default('opencc')`）。
  2. **新增项目级覆盖层**：`loadSettings()` 在用户级之上合并 `<cwd>/.zai/settings.json`（deep merge，单测覆盖）。最简实现：项目级存在则浅合并到用户级副本上。
  3. 非法值显式报错（fail loud），不静默回落。
- **文件**：`packages/zai/src/server/services/zaiSettingsStore.ts`（及对应 zod schema 文件，按现状位置）。
- **验收**：`~/.zai/settings.json` 与 `<cwd>/.zai/settings.json` 均可配置；项目级 > 用户级 > 默认 `'opencc'`；非法值 fail loud；单测覆盖三种优先级与非法值。

### T0.2 KernelAdapter 接口定型（完整能力面）

- **做什么**：定义 `KernelAdapter`，**完整能力面**（不能过薄——见审查 R9/改进 5）：
  - 生命周期：`start()` / `shutdown()`（shutdown 必须显式 drain 顺序：B-1 验证）
  - 会话：`createSession` / `resumeSession` / `listSessions` / `deleteSession`
  - 驱动：`run()` / `abort()`
  - transcript：`patchTranscript()` / `readTranscript()`（替代现有 `compat/transcript/persistence.ts` 入口）
  - 回调：`onAsk()` / `onApprove()`
  - 状态：`subscribeState()`
  - 队列/metrics：`enqueue?()` / `metrics()`
  - 后台任务：`startBackgroundTask()` / `notifySubagentDone()`
- **文件**：`packages/zai/src/server/services/kernel/kernelAdapter.ts`（新增目录 `services/kernel/`）。
- **验收**：类型编译通过；接口只依赖 zai 自有类型（不 import vendor / dsh 符号）。

### T0.3 opencc 轨道封装（OpenccKernelAdapter）

- **做什么**：把现有 `initAgentRuntime` 里对 `createOpenccRuntime` 的调用封装成 `OpenccKernelAdapter` 实现，行为不变——内部仍是 `createOpenccRuntime`，只是包一层接口。**T0.3 不迁移事件翻译**（沿用 `translateRuntimeEvents`），T0.3 只包外壳；事件翻译的迁移分批进行（B1b 11 通道对齐）。
- **文件**：`packages/zai/src/server/services/kernel/factories/opencc.ts`；`agentRuntime.ts` 改为通过 `createKernel(config)` 分叉；新封装需 wrap `getRuntime()` 全部调用面（审查 R9：`agentRuntime.ts:411-425` 等位置仍返回 `OpenccRuntime`，不能"仅包外壳"）。
- **验收**：`pnpm --filter @zn-ai/zai dev` 行为与改造前一致；相关单测绿；`getRuntime()` 调用面盘点清单。

### T0.4 工厂分叉 createKernel（含引擎检查）

- **做什么**：
  1. `createKernel(cfg)` 依据 `agent.kernel` 返回对应 adapter。
  2. **引擎检查前置**：在分叉之前，`if (cfg.kernel === 'dsh' && !nodeSupportsDsh())` 立即报错（含修复指引）。`nodeSupportsDsh()` = `process.versions.node` 满足 `^22.19.0 || >=24.0.0`。
  3. `'dsh'` 时动态 `import('@zn-ai/dsh-bridge')` 并调用其 `createDshRuntime`（本批 dsh-bridge 只提供「未实现」桩，抛 `NotImplementedError` 或启动报错）。
- **文件**：`packages/zai/src/server/services/kernel/factories/index.ts`；`agentRuntime.ts:334` 处改为调用 `createKernel`。
- **验收**：
  - `agent.kernel='dsh'` + Node ≥22.19：启动到达 dsh-bridge 路径并显式失败（预期）。
  - `agent.kernel='dsh'` + Node < 22.19：启动在引擎检查阶段立即 fail loud，**不到达 import dsh-bridge**。
  - `agent.kernel='opencc'`：行为零变化。

### T0.5 dsh-bridge workspace 骨架

- **做什么**：新建 `packages/dsh-bridge/`：
  - `package.json`：name `@zn-ai/dsh-bridge`，deps `@deepseek-ai/dsh-headless`（`save-exact` 锁定 `0.1.0-rc.7`）+ 必需 core 包（B-1 决定清单）；engines `node: ^22.19.0 || >=24.0.0`，ESM。
  - 处理 headless 的 peerDependencies（`@deepseek-ai/dsh-cmdline`、`@deepseek-ai/dsh-code-runtime-worker-thread`、`@deepseek-ai/schemastery` 等）：B-1 尖峰结果定（`pnpm peerDependencyRules.allowAny` 或显式列在 dependencies）。
  - `tsconfig.json`（沿用仓库 base）、`src/index.ts`（导出 `createDshRuntime` 桩 + 类型）。
  - 加入根 workspace 列表；`pnpm install` 通过。
  - `package.json.engines` 同时声明 `^22.19.0 || >=24.0.0`，并对 headless 的 peer deps 做兼容处理。
- **验收**：`pnpm --filter @zn-ai/dsh-bridge build` 绿；`pnpm -r exec tsc --noEmit` 绿；peer deps 安装后无 unresolved；Node < 22.19 环境下 install 时 engines 警告但允许（T0.4 引擎检查在运行期兜底）。

### T0.6 双轨数据目录常量 + 任务 namespace

- **做什么**：
  1. 定义 dsh 轨道会话目录常量（`${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/`），与 opencc 轨道 `<sessionId>.jsonl` 并存。
  2. **任务 store namespace**：dsh 任务走独立子目录（`~/.zai/tasks-dsh/` 或 `~/.zai/tasks/dsh-<taskId>.json` 前缀）——禁止与 opencc 共用 `~/.zai/tasks/<taskId>.json`（主计划 §4.2 + R4）。
  3. 写入 `paths.ts` 或 kernel 常量文件；主计划 §4.2 表格落代码。
- **文件**：`packages/zai/src/server/services/paths.ts`（或 kernel 常量）。
- **验收**：常量导出，单测覆盖路径拼接；任务 store 双 namespace 在常量层有显式区分。

### T0.7 仓库级 engines 升级

- **做什么**：根 `package.json.engines` 升至 `^22.19.0 || >=24.0.0`（主计划 §4.3 关键约束——zai 主服务与 dsh-bridge 同步）。opencc 内核在 Node ≥22.19 下行为兼容（验证 opencc 单测在 Node 22 下全绿后再合）。
- **验收**：根 `package.json.engines` 升级；opencc 单测在 Node ≥22.19 下全绿；B-1 尖峰已验证此变更可行。

### T0.8 globalThis 桥清理协议

- **做什么**：盘点 `agentRuntime.ts:75-88, 397-404` 等位置的 `globalThis.__zai*` 写入点（`__zaiEventBus`、`__zaiBridgeCtx`、`__zaiCurrentSessionId`、background runtime 桥），定义显式初始化序列（启动时设值）+ 关闭序列（shutdown 时 `delete`），B-1 尖峰验证。
- **验收**：清理协议文档化（注释 + 一段小文档）；单测覆盖「启动后存在 / shutdown 后不存在」。

### T0.9 文档与 gate 记录

- **做什么**：把双轨约定写入 `AGENTS.md`（配置项、目录约定、动态 import 规则、引擎要求）；记录 G0 决策门结果。
- **验收**：AGENTS.md 增补段落 review 通过。

## 4. 验收标准（修订版：G0 仅验证可达）

1. 默认 `'opencc'`：dev/start 行为与合入前无差异；`pnpm -r test` 全绿。
2. `'dsh'` + Node ≥22.19：启动到达 dsh-bridge 桩路径并显式失败（B1 前预期）。
3. `'dsh'` + Node < 22.19：启动在引擎检查阶段立即 fail loud（**修复指引清晰**）。
4. KernelAdapter 类型编译通过（含 abort / patchTranscript / readTranscript / state / metrics），zai 服务层不再有新增的 vendor 直接引用。
5. dsh-bridge build 绿；peer deps 安装无 unresolved。
6. 项目级配置覆盖可用（用户级 + 项目级 + 默认 三层）。
7. globalThis 桥清理协议文档化 + 单测覆盖。
8. opencc 单测在 Node ≥22.19 下全绿。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| KernelAdapter 过早定型导致后续返工 | 接口按完整能力面（§3.1 主计划）定义，T0.2 含 abort / transcript / state / metrics |
| 工厂分叉引入 import 时序问题 | 动态 import 保持与现 `createOpenccRuntime` 同款 `await import('@zn-ai/zn-agent-core')` 模式（agentRuntime.ts:334 已有先例） |
| dsh 依赖安装拉爆 pnpm 锁文件或 peer deps 未解析 | B-1 尖峰定 peer 处理策略；T0.5 显式处理 |
| 仓库 engines 升级破坏现有 Node 20 用户 | **接受 breaking change**——本计划是 dsh 模式准入条件；AGENTS.md 公告；用户级 `~/.zai/settings.json` 临时设 `agent.kernel='opencc'` 不受影响 |
| `getRuntime()` 调用面盘点遗漏 | T0.3 显式列出全部调用点；grep 完整覆盖 |

## 6. 测试策略

- 单测：zaiSettingsStore 三层优先级 + 非法值；createKernel 分叉选择 + 引擎检查；dsh-bridge 桩；globalThis 桥清理协议。
- 回归：`pnpm --filter @zn-ai/zai test src/server/services/agentRuntime.test.ts`（若存在）及受影响文件；合入前 `pnpm -r test` 一次（**在 Node ≥22.19 下**）。
- 不跑 ego-browser（本批无用户可见行为变化）。
