# 实施计划归档:移除 repl 以外链路 — 阶段 2(死代码清理)

> **Plan agent**: MiniMax-M3
> **生成时间**: 2026-09-12 21:21
> **执行时间**: 2026-09-12
> **完整 plan 文件**:`/tmp/deep-research/repl-link-remove-plan-phase2.md`(615 行,执行前只读参考)
> **基于终稿**:`/tmp/deep-research/repl-link-remove-final.md`(612 行 §10/§11 关键)
> **仓库 HEAD**: `4421dae9` on `main`(阶段 1 收尾后)
> **Worktree**: `/Users/ethan/.zai/task-factory/worktrees/repl-link-unify-phase2`
> **本计划范围**:仅阶段 2 死代码清理(终稿 §10.1);阶段 3 类型面单态收敛列于 plan §6 为可选激进项

---

## 0. 范围与目标

阶段 2 把阶段 1 已收敛的 `runtimeCore === 'repl'` 单态语义延伸到底层:
删除所有"repl 以外链路"残留代码(vendor inproc + zai spawn)+ print.ts 的
8 个 zai patch 撤回。无 API 兼容破坏;无类型面收窄。

### 0.1 死代码清单(终稿 §10.1 + plan §0.1)

| 类别 | 数量 | 行数 |
|------|------|------|
| vendor 死代码文件 | 4 | createPrintRuntime.ts(179) / createPrintRuntime-impl.ts(883) / headlessPrintSession.ts(415) / printSessionRuntime.ts(82) |
| zai 死代码文件 | 9 | sessionHost/{SessionHost,SessionRegistry,cliSpawn,controlRequest,ndjsonStream,index,types,sessionHost.test} (8 文件) + RuntimeAdapter.ts(133) + runtimeFlag.ts(39) + headlessLoopWake.ts(连带) |
| 测试删除 | 8 | createPrintRuntime-{bridges,contract,lifecycle,ndjson-framing} + headlessPrintSession.routing + headless-queue-wakeup + sessionHost/cliSpawn-env + sessionHost(随目录) |
| print.ts patch 撤回 | 1 文件,8 处 | L54 / L527-529 / L545-547 / L827-828 / L2034-2037 / L2023-2040 / L2043-2064 / L2581-2592 / L5048-5049 |

### 0.2 验证方式

```bash
# 死代码 0 引用验证
grep -rn "createPrintRuntime\|headlessPrintSession\|printSessionRuntime\|getPrintSessionContext\|runWithPrintSession" \
  packages/ --include="*.ts" --include="*.tsx" \
  | grep -v "test/" | grep -v "node_modules" | grep -v "dist/"
# 期望:空

grep -rn "sessionHost\|SessionHost\|RuntimeAdapter\|applyRuntimeFlag\|headlessLoopWake\|subscribeToHeadlessWake\|ZAI_OPENCC_CLI" \
  packages/ --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules" | grep -v "dist/"
# 期望:空(注释文档提及的为历史说明,无害)

grep -n "zai patch" packages/zn-agent-core/src/opencc-src/cli/print.ts
# 期望:空
```

---

## 1. 5 个 atomic commit 序列

| # | commit hash | message | scope | 文件数 |
|---|-------------|---------|-------|-------|
| 1 | `4325c8e7` | `refactor(zn-agent-core): remove inproc runtime vendor code` | zn-agent-core | 4 |
| 2 | `fbf9bc1a` | `refactor(zai): remove sessionHost + RuntimeAdapter + runtimeFlag dead code` | zai + zn-agent-core | 11(含 headlessLoopWake) |
| 3 | `979025e8` | `test: drop dead-code tests` | both | 7(sessionHost.test.ts 已随目录删除) |
| 4 | `d5528735` | `refactor(zn-agent-core): revert zai patches on print.ts` | zn-agent-core | 1 |
| 5 | (TBD) | `chore(docs): mark phase-2 dead-code cleanup complete` | docs | 3 |

**顺序约束**:步骤 1 → 2 → 3 → 4 → 5 严格;步骤 1+2 可互换但其它必须严格。
步骤 4 必须在步骤 2 之后(headlessLoopWake.ts 删除 + print.ts patch 撤回配套)。

---

## 2. 关键决策

- **采纳** 全部 8 个 patch 撤回(无保留)— 因 zai server repl 路径永不进 `print.ts`,撤回仅影响 vendor CLI mode
- **采纳** 连带删除 `headlessLoopWake.ts` — 撤回 print.ts patch #1/#5 后无引用
- **不采纳** 类型面收窄(`'default'` alias 删除)— 阶段 3 候选(plan §6 评估)
- **保留** `compat/repl/*` + `createOpenccRuntime*` + `createHeadlessContext*`(repl 分支依赖)
- **保留** `runtimeCore` 二态类型面 + `isValidRuntimeCore` 兼容函数
- **保留** `'default'` PUT/POST 静默落 `'repl'` 行为(阶段 1 已落地)

---

## 3. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| patch #6 vendor 原版 do-while 还原错误 | 中 | 高(zn-agent-core build 失败) | 从 `git show 98ee7e5a:...` 取 vendor 原版精确片段(本仓库 vendor sync 起点 commit) |
| patch #6 race condition 在 zai 环境触发 | 极低 | 中(罕见 hang) | zai server 不走 print.ts,实际不可能触发 |
| 遗漏 hidden 引用(barrel / type re-export) | 中 | 中(tsc 报错) | 步骤 4 验证命令 + plan §4.5 失败对策 |
| `getCanUseToolFn` 因 patch 撤回行为变化 | 低 | 中(createHeadlessContext 调用失败) | L4453 函数体本身不是 patch,撤回 patch 不影响 export 行为 |
| `compat/repl` 间接依赖被误删 | 极低 | 高(repl 挂掉) | 步骤 2 验证命令 + plan §0.4 明确 `compat/repl` 全部保留 |

---

## 4. 后续工作(本阶段未做)

- **类型面收窄**(`'default'` alias 删除):见 plan §6 评估
- **CLI flag 简化为无 `--runtimeCore` 选项**:阶段 1 保留向后兼容,阶段 3 考虑
- **settings.json 自动 migrate 脚本**:阶段 1 已让 `resolveRuntimeCore` 静默落 `'repl'`,无需 migrate 脚本
- **print.ts 撤回后 vendor 上游同步策略**(长期):阶段 2 撤回 patch 后,下次 vendor sync 可直接覆盖;建议在 `docs/DEVELOPMENT_REFERENCE.md` 追加"print.ts patch 撤回说明"
- **过期 worktree 清理**:`feat/repl-link-unify`(阶段 1 期间产物)在 main merge 后 `git worktree remove` + `git branch -d`

---

## 5. 一句话定位

**阶段 2 = 删除 4 vendor + 9 zai 死代码文件 + 7 测试 + 撤回 print.ts 8 个 inproc-specific patch;5 commit;无 API 兼容破坏;无类型面收窄;merge 后清理过期 worktree。**

---

**END OF PHASE-2 PLAN ARCHIVE**