# 实施计划归档:移除 repl 以外链路 — 阶段 3(完全清理 runtimeCore 概念)

> **Plan agent**: MiniMax-M3
> **生成时间**: 2026-09-12 22:45
> **执行时间**: 2026-09-12
> **完整 plan 文件**:`/tmp/deep-research/repl-link-remove-plan-phase3.md`(824 行,执行前只读参考)
> **基于终稿**:`/tmp/deep-research/repl-link-remove-final.md`(612 行 §6.2 类型面收窄评估 + §11 总改动清单)
> **基于阶段 1 报告**:`/tmp/deep-research/repl-link-remove-execution.md`(224 行)
> **基于阶段 2 报告**:`/tmp/deep-research/repl-link-remove-execution-phase2.md`(370 行)
> **仓库 HEAD(阶段 2 收尾)**:`f67542ae` on `main`(阶段 2 已合 main,领先 origin 5 commit)
> **Worktree**:`/Users/ethan/.zai/task-factory/worktrees/repl-link-unify-phase3`(已建,分支 `feat/repl-link-unify-phase3`,基于 `main@f67542ae`)
> **本计划范围**:阶段 3 = 完全删 `runtimeCore` 概念(类型面 `'default' | 'repl'` → 单态 `'repl'`,server 字段、PUT 端点、per-instance 字段、CLI flag、前端 UI 全部删除)。**用户接受中风险**:
> - 旧 `settings.json` 写 `'default'` / `'inproc'` / `'spawn'` 字段 → 类型面删除后落 "未声明字段",不影响行为
> - 旧 instance def 持久化 `runtimeCore` 字段无害(supervisor 不再读)
> - 旧 `--runtimeCore default` flag → commander unknown option 报错

---

## 0. 范围与目标

阶段 3 把阶段 1+2 已收敛的"运行时永远 'repl'"语义推到**所有公共 API 面**:
公共类型 `RuntimeCore` 删 + `ZaiSettings.runtimeCore` 字段删 + `InstanceDefinition.runtimeCore` 字段删 + PUT 端点删 + CLI flag 删 + 前端 UI 删 + 8 个测试清理 + minor bump。

### 0.1 终稿 vs 用户决策(§6.2 推荐 B → 用户决定激进删除)

| 冲突点 | A 立场 | B 立场 | C 立场 | 终稿采纳 | **阶段 3 采纳(用户)** |
|--------|--------|--------|--------|---------|----------------------|
| 类型面收窄 | 倾向简化 | 保留 `'default'` alias | 类型单值 + boot 迁移 | B | **激进:删除 RuntimeCore 类型** |
| `ZaiSettings.runtimeCore` 字段 | 倾向删 | 保留兼容 | 删 | B | **激进:删除字段** |
| `RuntimeCore` import | 倾向删 | 保留 | 删 | B | **激进:删除全部 import** |
| `isValidRuntimeCore` / `RUNTIME_CORE_VALUES` | 没发现 | 没发现 | 没发现 | — | **激进:删除** |
| PUT 端点 | 保留兼容 | 保留兼容 | 删 | B | **激进:删除端点** |
| `--runtimeCore` CLI flag | 简化 | 保留 | 删 | B | **激进:删除 flag + 整模块** |
| per-instance `runtimeCore` 字段 | 保留 | 详细覆盖 | 没发现 | B | **激进:删除字段** |
| SettingsDrawer "运行时" section | 改只读 | 改只读 | 删 | B | **激进:删除整行** |
| ConversationInfoCard "运行时" 行 | 简化 | 简化 | 删 | B | **激进:删除整行** |
| `useConversationInfo` runtimeCore 字段 | 保留 | 保留 | 删 | B | **激进:删除字段** |

**结论**:阶段 3 = 终稿三方一致认为应激进删除、但出于兼容性阶段 1+2 保留的所有项,在用户确认后**全部激进删除**。

---

## 1. 8 commit 实际执行记录

| # | hash | commit message |
|---|------|----------------|
| 1 | `4c23bd36` | `refactor(zai): drop RuntimeCore type + settings.runtimeCore field` |
| 2 | `59a56751` | `refactor(zai): remove runtimeCore server resolver + REST route` |
| 3 | `ea7ec36e` | `refactor(zai): drop --runtimeCore CLI flag + cli/runtimeCoreFlag.ts` |
| 4 | `83b7e2ef` | `refactor(zai): drop per-instance runtimeCore override + supervisor plumbing` |
| 5 | `44da7eb9` | `feat(zai): remove runtimeCore UI (SettingsDrawer + ConversationInfoCard + hook)` |
| 6 | `6e772981` | `test(zai): drop runtimeCore tests + ui mock fields` |
| 7 | `TBD`    | `chore(zai): bump version to 0.7.0 (runtimeCore concept removed)` |
| 8 | `TBD`    | `chore(docs): mark phase-3 runtimeCore concept removal complete` |

(commit 7+8 hash 在执行归档时填入;最终 8 commit 总数)

---

## 2. 改动清单(每步覆盖范围)

### 2.1 类型面(commit 1)

- `packages/zai/src/shared/settings.ts`:删 `RuntimeCore` 类型(`'default' | 'repl'`)+ 整块 11 行注释 + `ZaiSettings.runtimeCore?: RuntimeCore` 字段定义 + 整块 8 行注释
- 旧 `settings.json` 写 `runtimeCore: 'default'` 字段会变成 "未声明字段",运行时无 reader,行为不变;无需 migration 脚本

### 2.2 server 解析链(commit 2)

- `zaiSettingsStore.ts`:删 `RuntimeCore` import + `resolveRuntimeCore` 函数 + `isValidRuntimeCore` 函数
- `agentRuntime.ts`:删 `reapplyRuntimeCoreFlag` import + `RuntimeCore` import + `resolveRuntimeCore` 函数 + `let activeRuntimeCore` + `getRuntimeCore` 函数 + `__resetAgentRuntimeForTests` 里的 `activeRuntimeCore = 'repl'` 一行 + `enableOpenccConfigs()` 后的整块 `reapplyRuntimeCoreFlag()` / `resolveRuntimeCore(settings)` / assert / `activeRuntimeCore = runtimeCore` 调用链 + 注释改写
- `routes/agentSettings.ts`:删 `getRuntimeCore` import + `RuntimeCore` import + `isValidRuntimeCore` / `resolveRuntimeCore` import + GET 响应里 `runtimeCore` / `activeRuntimeCore` 字段 + 整段 `PUT /api/agent/settings/runtime-core` 端点
- `routes/instances.ts`:删 `RuntimeCore` import + `RUNTIME_CORE_VALUES` 常量 + `parseRuntimeCoreField` 函数 + POST / PATCH 的 runtimeCore 接受链

### 2.3 CLI flag(commit 3)

- 整文件删除 `packages/zai/src/cli/runtimeCoreFlag.ts`
- `cli/index.ts`:删 `applyRuntimeCoreFlag` import + `--runtimeCore <mode>` 两条 `.option` + 两条 `applyRuntimeCoreFlag(options.runtimeCore)` 调用
- `cli/dev.ts`:删 `DevOptions.runtimeCore?: string` 字段 + 整块 9 行注释
- `cli/start.ts`:删 `StartOptions.runtimeCore?: string` 字段 + 整块 7 行注释 + `childArgs.push('--runtimeCore', options.runtimeCore)` 透传 + 上方 3 行注释

### 2.4 per-instance(commit 4)

- `shared/instances.ts`:删 `RuntimeCore` import + `InstanceDefinition.runtimeCore?: RuntimeCore` 字段 + 整块 13 行注释
- `services/instanceSupervisor.ts`:删 `RuntimeCore` import + `InstanceSupervisor` 接口里 `createInstance` / `startInstance` / `restartInstance` / `updateInstance` 的 `runtimeCore` 字段 + 整块 `updateInstance` 注释段 + `doStart` 签名去掉 `runtimeCore?: RuntimeCore | null` + 删 `effectiveRuntimeCore` resolution 注释 + 计算 + `args.push('--runtimeCore', ...)` + `createInstance` 签名去掉 `runtimeCore` 形参 + `def.runtimeCore` 持久化 + `updateInstance` 签名去掉 + patch.runtimeCore 处理块

### 2.5 前端 UI(commit 5)

- `hooks/useConversationInfo.ts`:删 `RuntimeCore` import + `ConversationInfo.runtimeCore` / `activeRuntimeCore` 字段 + 整块 14 行注释 + `RuntimeSettings` 子类型对应字段 + `useState` 初值两行 + fetch effect 内的 setRuntime 回填块 + useMemo return 两行
- `components/SettingsDrawer.tsx`:删 `RuntimeCoreOption` type + 整块 6 行注释 + `buildStaticSchema` 签名去掉 `runtimeCore` 形参 + 整段 `section: '运行时'` schema 块 + `useState<RuntimeCoreOption>` + `buildStaticSchema(...)` 调用对应参数 + fetch effect 内的 setRuntimeCore 块 + schema 同步 effect 整段 + handleChange 内 `PUT /api/agent/settings/runtime-core` 块
- `components/ConversationInfoCard.tsx`:删 `runtimeCoreLabel` 函数 + 整块 12 行注释 + `<Descriptions.Item label="运行时">` 整段

### 2.6 测试清理(commit 6)

| 类别 | 文件 |
|------|------|
| 整文件删除(3) | `test/server/agentRuntime.resolveRuntimeCore.test.ts` (77 行) / `test/cli/runtimeCoreFlag.test.ts` (68 行) / `test/server/agentSettings-runtime-core.test.ts` (140 行) |
| 段删除(5) | `src/server/services/zaiSettingsStore.test.ts` (14 行 `resolveRuntimeCore` 段) / `test/server/agent-runtime-server.test.ts` (env 处理) / `test/server/routes/instances.test.ts` (POST/PATCH 段 ~110 行) / `test/server/services/instanceSupervisor.test.ts` (per-instance 段 ~70 行) / `src/server/services/__tests__/agentRuntime.repl.test.ts` (env 设置 + describe 名)|
| mock 删除(1) | `test/server/subagentNotifier.test.ts` (`vi.mock getRuntimeCore`) |
| mock 字段删除(1) | `src/web/src/components/ConversationInfoButton.test.tsx` (runtimeCore + activeRuntimeCore 字段) |
| 注释改写(1) | `test/cli/ports.test.ts` (L64 注释去掉 `--runtimeCore repl` 字样) |

### 2.7 版本 + 文档(commit 7+8)

- `packages/zai/package.json`:`0.6.7` → `0.7.0`
- `packages/zn-agent-core/package.json`:同步 bump `0.6.7` → `0.7.0`(可选对齐,本计划采纳)
- `docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md`:顶部追加 phase-3 完成 status 段
- 本归档文件新建

---

## 3. 终态(阶段 3 完成后)

```
zai 启动 → cli/index.ts dev|start (无 --runtimeCore flag)
  └─ initAgentRuntime (无 resolveRuntimeCore / 无 activeRuntimeCore)
       ├─ createOpenccRuntime (vendor createOpenccRuntime-impl.ts,唯一形态)
       │    └─ OpenccRuntime (8-method V1 契约)
       └─ ReplRuntime 包装(query / slash command / P3 stub)
            └─ settings.runtimeCore 字段已删 / CLI flag 已删 / PUT 端点已删
                 唯一运行时形态:repl,无歧义
```

---

## 4. 风险评估(用户已接受中风险)

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 旧 settings.json 写 `runtimeCore: 'default'` | 低 | 字段变成 "未声明字段",运行时无 reader → 无影响;无需 migrate |
| 旧 instance def 持久化 `runtimeCore: 'repl'` | 低 | supervisor 不再读 → 无影响;InstanceSnapshot 仍 extend InstanceDefinition |
| 旧 `--runtimeCore <mode>` flag | 中 | commander 报 "unknown option";**不保留 alias**(用户接受) |
| 旧 `PUT /api/agent/settings/runtime-core` 调用方 | 中 | Express default 404 handler;**不保留 410 Gone 兼容端点** |
| `ZAI_RUNTIME_CORE` env 变量 | 低 | agentRuntime.ts 不再读 → 无影响 |
| `ConversationInfoCard` "运行时"行删除 | 低 | 用户要求删除;无回归风险 |
| 类型面删除连锁 | 中 | public API `RuntimeCore` 类型被删;minor bump 已生效 |

每个 commit atomic 可 revert;无需数据库迁移、无需用户操作。

---

## 5. 与阶段 1+2 的差异(避免重复工作)

### 5.1 阶段 1 已做

- `else { runtimeCore === 'default' }` 分支删除(agentRuntime.ts:807-846)
- `resolveRuntimeCore` 折叠 `'default'` → `'repl'`(三处)
- 6 个测试更新
- 6 个文档标 obsolete

### 5.2 阶段 2 已做

- vendor 4 文件删除(`createPrintRuntime*` + `headlessPrintSession*` + `printSessionRuntime*`)
- zai 9 文件删除(sessionHost/* + RuntimeAdapter + runtimeFlag + headlessLoopWake)
- 7 个测试删除
- print.ts 8 个 zai patch 撤回
- 文档更新

### 5.3 阶段 3 不重复(本计划新增)

- 类型面 `RuntimeCore` 删除(阶段 1 保留 `'default'` alias)
- server `resolveRuntimeCore` + `isValidRuntimeCore` 函数删除(阶段 1 折叠保留)
- `activeRuntimeCore` + `getRuntimeCore` 模块级状态删除(阶段 1 保留)
- `reapplyRuntimeCoreFlag` 调用删除(阶段 1 保留)
- PUT `/api/agent/settings/runtime-core` 端点删除(阶段 1 保留兼容)
- `--runtimeCore` CLI flag + 整模块删除(阶段 1 保留 `'default'` warn 折叠)
- per-instance `runtimeCore` 字段 + supervisor 透传删除(阶段 1+2 保留)
- SettingsDrawer "运行时" section 删除(阶段 1 改 disabled + 只读 'repl')
- ConversationInfoCard "运行时" 行删除(阶段 1 简化显示)
- 8 个测试文件清理(阶段 1+2 未触)

---

## 6. 验证(阶段 3 收尾)

### 6.1 类型检查

```bash
pnpm -r exec tsc --noEmit
# 预期:0 错误
```

### 6.2 zn-agent-core build

```bash
pnpm run build:core
# 预期:[verify-server-types] OK + EXIT: 0
```

### 6.3 单元测试

```bash
pnpm --filter @zn-ai/zai test --run 2>&1 | tail -30
# 预期:全部测试通过

pnpm --filter @zn-ai/zai test runtimeCoreFlag resolveRuntimeCore agentSettings-runtime-core 2>&1 | tail -5
# 预期:"No test files found, exiting with code 1"
```

### 6.4 死代码 0 引用验证

```bash
grep -rn "RuntimeCore\|runtimeCore\|activeRuntimeCore\|getRuntimeCore\|resolveRuntimeCore\|isValidRuntimeCore\|applyRuntimeCoreFlag\|reapplyRuntimeCoreFlag\|RuntimeCoreOption\|RUNTIME_CORE_VALUES\|parseRuntimeCoreField" \
  packages/ --include="*.ts" --include="*.tsx"
# 预期:仅 docs/ 与 docs/superpowers/specs 历史注释(无害)
```

---

## 7. 工作量统计

| 类别 | 阶段 3 |
|------|--------|
| 文件删除 | 4(1 cli + 3 test) |
| 段删除 | ~10 段(~700 行) |
| 类型 / API 收敛 | ~15 处 |
| UI 删除 | 3 文件 schema/字段/行 |
| 测试收敛 | 8 文件 |
| 文档更新 | 2 文档 |
| 版本 bump | 2 文件 |
| **总编辑数** | **~25 处 + 4 文件删除 + 8 测试文件清理** |
| **commit 数** | **8(atomic)** |
| **净删除行** | **~800 行** |
