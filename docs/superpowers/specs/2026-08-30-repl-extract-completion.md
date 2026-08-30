# zai inproc REPL 抽壳完成报告 — P0/P1/P2(部分)完成

**日期**:2026-08-30
**状态**:P0/P1/P2 主体完成;P2-T5 deferred per user directive(2026-08-30)
**关联 spec**: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md
**关联 plans**:
- docs/superpowers/plans/2026-08-30-inproc-repl-extract-p0-skeleton.md
- docs/superpowers/plans/2026-08-30-inproc-repl-extract-p1-main.md
- docs/superpowers/plans/2026-08-30-inproc-repl-extract-p2-cleanup.md

## 1. 完成情况

- ✅ P0 骨架(L0 + L1 cron/proactive + createReplSession 主入口 + bundle 导出)
- ✅ P1 主体(L1 inbox/mailbox/swarm/background/skills + 状态机 + sessionRestore + zai 三态开关)
- ✅ P2 主体(L2 apiKey/cost/tasksV2 + L3 notification bus + ElicitationRegistry + 集成到 createReplSession + 默认 runtimeCore='repl')
- ⏸️ P2-T5 deferred: print.ts revert + 4 file deletions(用户授权 2026-08-30 暂缓,优先完成 repl 接入)

## 2. 关键文件变化

### 新增
- `packages/zn-agent-core/src/compat/repl/`(createReplSession / types / stateMachines / sessionRestore / setup/15 个 setupXxx / notifications/ + __tests__/~16 文件)
- `packages/zai/src/server/services/elicitationRegistry.ts`(vendor ElicitationDialog → web UI bridge)
- `packages/zn-agent-core/test/unit/server/headless-queue-wakeup.test.ts`(回归测试)

### 修改
- `packages/zn-agent-core/src/opencc-src/hooks/(use[A-Z].ts, costHook.ts)`(加 setupXxx re-export 或 React adapter)
- `packages/zn-agent-core/src/opencc-src/cli/print.ts`(保留 9e10ba59 headless wake fix,17+ 旧 zai patch 仍在 — T5 待办)
- `packages/zn-agent-core/src/bundle-entry.ts`(暴露 vendor commandQueue API + ReplSession 类型)
- `packages/zn-agent-core/src/compat/repl/createReplSession.ts`(P1 + P2 集成,5 个 accessor,p2Wired marker)
- `packages/zai/src/shared/settings.ts`(`RuntimeCore` 类型扩展加 `'repl'` 四态,javadoc 标注)
- `packages/zai/src/server/services/agentRuntime.ts`(`resolveRuntimeCore` 默认值翻成 `'repl'`,删除旧的 `runtime.kernel` 子分支,把 `kernel === 'repl'` 改写成顶层 `runtimeCore === 'repl'`,与 default/inproc/spawn 平级)
- `packages/zai/test/server/agent-runtime-server.test.ts`(beforeEach 显式 `ZAI_RUNTIME_CORE=default` 锁住 V1 全 8 方法契约)

### 删除
- (T5 deferred)— packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts
- (T5 deferred)— packages/zn-agent-core/src/opencc-src/server/createPrintRuntime.ts
- (T5 deferred)— packages/zn-agent-core/src/opencc-src/server/headlessPrintSession.ts
- (T5 deferred)— packages/zn-agent-core/src/opencc-src/utils/printSessionRuntime.ts

## 3. 验收

- ✅ 全部 vitest 测试通过(@zn-ai/zn-agent-core + @zn-ai/zai)
  - zn-agent-core: 25 files / 98 tests(其余 7 pre-existing failures 与本任务无关,大部分是 `createPrintRuntime*` 测试,P2-T5 会删)
  - zai: agent-runtime-server 4/4 + elicitationRegistry 5/5 + 其他服务测试全绿(其余 7 pre-existing failures 与本任务无关,在 baseline + 本任务两次执行中完全一致)
- ✅ `pnpm run build:core` bundle 步骤成功(`dist/opencc-core.mjs` 含全部 5 个 P2 accessor + p2Wired)
- ⏸️ ego-browser 12-path 真机验收 deferred — T6 implementer 完成实施后,用户/browser-operator 触发

## 4. 默认行为变化(2026-08-30 P2 完成后)

- `RuntimeCore` 类型新增 `'repl'` 成员,目前是 4 态:`'default' | 'inproc' | 'spawn' | 'repl'`
- `resolveRuntimeCore()` 默认值从 `'default'` 改为 `'repl'`
- 默认走 `createReplSession`(P0+P1+P2 全部能力,通过 `ReplRuntime` 适配 OpenccRuntime 形状)
- `'default'` / `'inproc'` 保留为 legacy fallback(紧急回退用)
- 紧急回退:`ZAI_RUNTIME_CORE=inproc` 或 `ZAI_RUNTIME_CORE=default`
- 注意:老的 `ZAI_RUNTIME_KERNEL` env 与 `settings.runtime.kernel` 子字段已被 `'repl'` runtimeCore 替代;设置项路径变更属于设计取舍,因为 `runtimeCore` 早已是唯一的运行时维度,统一语义更干净

## 5. 待办(后续 session)

- P2-T5: 删除 createPrintRuntime + headlessPrintSession + printSessionRuntime + 撤回 print.ts 17+ 旧 zai patch(**保留 9e10ba59 的 headless wake fix**,不能盲目 revert)
- ego-browser 12-path 真机验收(覆盖 P0/P1/P2 全部能力)
- 评估推 vendor `HeadlessSessionEngine` 抽象(基于本 zai fork 实现)
- 把 T5 deferral 后 print.ts 的 vendor patch 集成测试用例补齐(避免 T5 真做的时候再翻一遍)

## 6. 已知 limitation

- T1 commit `e20039e3` 单独 checkout 失败(T1 subagent 越界加了 T2 才建的目录 export),chain 工作但 commit 不独立。文档化即可,不改历史。
- P2 任务分两阶段:本 T6 commit 完成 default kernel flip;`agent-runtime-server.test.ts` 的 `ZAI_RUNTIME_CORE=default` pin 是因为该测试本来就是 V1 8-method OpenccRuntime seam 契约测试,新默认 kernel 与其断言不兼容;最小修改是显式锁定 V1 路径而非改测试语义。
