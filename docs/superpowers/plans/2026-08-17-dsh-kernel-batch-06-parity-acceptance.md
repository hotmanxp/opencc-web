# Batch 6 — 对等验收与切换

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> 目标：双轨全量对等验收——parity 测试 harness（覆盖 11 组 ServerEvent）、ego-browser 双轨全场景、**幂等/校验/回滚**的会话迁移工具、kill switch 演练。产出 G2 决策门的全部证据。

---

## 1. 目标

- 建立「同一场景脚本双轨各跑一遍」的 parity 测试 harness，**事件归一化必须覆盖 11 组 ServerEvent 类型**，产出可读 diff 报告。
- ego-browser 双轨全场景验收（主计划 §6 的验收总标准）。
- 会话迁移工具：opencc jsonl → dsh 事件溯源格式，**锁定 dsh 版本 + 幂等 + 校验 + 回滚 + dry-run 默认**（审查改进 4）。
- kill switch 演练：含 SSE 长连接 drain/dispose 顺序验证（主计划 R8）。
- 整理「已知差异清单」（主计划 §6.1 定稿）。

## 2. 前置条件

- B0-B5 全部合入。
- 收集 B1-B5 过程中记录的所有「待定差异」。
- dsh 版本固定（`save-exact` 锁定 0.1.0-rc.7）；如发现需要升级，先独立批次处理，不在 B6 混。

## 3. 任务清单

### T6.1 parity harness（11 组事件全覆盖）

- **做什么**：`packages/zai/test/kernel/parity/` 下建 harness：
  - **场景脚本**：对话 / 工具链 / 审批 / 后台任务 / skill 触发 / slash 命令。
  - **事件归一化**：剥离时序、id 差异；**必须覆盖全部 11 组 ServerEvent**（Runtime/Session/Job/Prompt/System/State/Instance/Queue/Command/StreamError/Projection）——不是只测对话流。
  - **diff 报告**：每组事件类型独立行，标注「对等 / 差异 / 已知差异清单条目」。
- **文件**：`packages/zai/test/kernel/parity/harness.ts`、`scenarios/*.ts`、`report.ts`。
- **验收**：双轨各场景可跑；11 组事件类型各至少 1 个断言；全绿为「对等」，差异进入已知差异清单。

### T6.2 ego-browser 双轨全场景验收

- **做什么**：按主计划 §6.5，双轨各走一遍核心用户路径：发起对话、工具执行展示、权限弹窗、后台任务 drawer、会话历史恢复、skill 触发、slash 命令。每场景截图存证。
- **文件**：验收记录 `docs/superpowers/plans/2026-08-17-dsh-kernel-acceptance-report.md`（验收报告）。
- **验收**：两条轨道各 7+ 场景通过；差异截图对照。

### T6.3 会话迁移工具（**幂等/校验/回滚 + 锁定 dsh 版本**）

- **做什么**：`packages/zai/src/server/services/kernel/migrate.ts`：
  - `migrateSession(cwd, sessionId, { dryRun, targetDshVersion })` 把 opencc jsonl 会话翻译为 dsh 事件溯源 log。
  - **只读源、只写目标**；`dryRun=true` 默认开启，输出统计（消息数/工具数/不可迁移条目）。
  - **锁定 dsh 版本**：迁移前校验 `targetDshVersion === installed('@deepseek-ai/dsh-headless')`，不一致报错——避免版本不匹配产生无效 log（dsh `SESSION_FORMAT_VERSION=0` 无兼容承诺）。
  - **幂等**：重复运行同一 session 不产生重复/损坏；目标目录存在且通过校验时跳过。
  - **校验**：迁移完成后回读 log 并断言关键事件（firstSeq、turn 数）符合预期。
  - **回滚**：迁移前 snapshot 目标目录（如已存在），失败时恢复。
  - 不可迁移的会话（损坏 / 未知事件类型）显式列出，不静默丢弃。
- **文件**：`packages/zai/src/server/services/kernel/migrate.ts` + `routes/migrate.ts`（或 CLI 命令）。
- **验收**：
  - 单测覆盖：jsonl → dsh log 字段映射、幂等（重复运行结果一致）、回滚（强制失败场景下目标目录无残留）、版本不匹配报错。
  - 真实会话 dry-run 无异常。
  - 真实会话非 dry-run 迁移后可在 dsh 轨道续读（对话续传）。
  - 不可迁移会话显式列出。

### T6.4 kill switch 演练（含 SSE drain）

- **做什么**：dsh 轨道运行中（有活跃 SSE 连接、有进行中 turn、有后台任务）切换到 `'opencc'` 重启：
  - 验证 drain/dispose 顺序（拒绝新请求 → flush 当前 turn → dispose Cordis ctx → 清 `__zaiEventBus/__zaiBridgeCtx/__zaiCurrentSessionId` globalThis 桥）。
  - 验证会话数据互不可见但不损坏（`dsh-sessions/` 与 `<sessionId>.jsonl` 各自完整）。
  - 验证无孤儿进程（dsh 长驻 Cordis ctx 干净退出）、`~/.zai/tasks/` 与 `~/.zai/tasks-dsh/` 无残留。
- **文件**：演练脚本 `scripts/kill-switch-drill.sh` + 记录（含 SSE 场景验证截图）。
- **验收**：演练通过，记录留存。

### T6.5 已知差异清单定稿

- **做什么**：汇总 B1-B5 全部差异（工具 schema、事件时序、压缩、嵌套子 agent、插件兼容、dsh 版本兼容性等），逐条标注：来源批次 / 影响 / 可接受性 / 处置（补丁 or 文档化 or 待 dsh 上游 / 与 dsh 版本绑定）。
- **文件**：`docs/2026-08-17-dsh-known-differences.md`（或并入验收报告）。
- **验收**：清单完整、可追溯（每条有来源批次/单测/相关 dsh 版本）。

### T6.6 全量回归

- **做什么**：`pnpm -r test` 全量（opencc 轨道 1400+ 用例）+ `pnpm run build` 链式构建 + `pnpm --filter @zn-ai/dsh-bridge build` + typecheck。**全量在 Node ≥22.19 下**（主计划 §4.3 约束）。
- **验收**：全绿；任何失败在合入前解决。

## 4. 验收标准（G2 决策门输入）

1. parity harness：核心场景双轨对等，**11 组事件全部覆盖**；差异全部进入已知差异清单且可接受。
2. ego-browser：双轨各 7+ 场景通过，截图存证。
3. 迁移工具：真实会话迁移后可在 dsh 轨道续读；幂等 / 校验 / 回滚 / 版本锁定全部单测覆盖。
4. kill switch 演练通过（含 SSE drain 验证）。
5. 全量测试 + 构建绿（Node ≥22.19）。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| parity 场景覆盖不足导致「伪对等」 | 场景清单由 B1-B5 各批验收场景汇总；T6.1 强制 11 组事件类型各 ≥1 断言 |
| 迁移工具损坏原会话或产生无效 log | dry-run 默认 + 只读源 + 版本锁定 + 幂等 + 回滚；不可迁移条目显式列出 |
| ego-browser 双轨全量验收耗时长 | 分场景批跑；每场景「opencc 基线 + dsh 对比」成对执行 |
| 已知差异清单被当「免责声明」滥用 | 每条差异必须带处置结论（补丁/文档/上游/版本绑定），G2 评审逐条过 |
| dsh 升级导致 log 不兼容 | 迁移器绑定 `installed('@deepseek-ai/dsh-headless')` 版本；版本不一致报错；升级走独立批次 |

## 6. 测试策略

- parity harness 本身是测试主体（T6.1）。
- 迁移工具：单测（构造 jsonl fixture → 断言 dsh log + 幂等 + 回滚 + 版本不匹配）+ 真实数据 dry-run + 真实数据非 dry-run 续读验证。
- kill switch：脚本化演练，结果记录（含 SSE 场景）。
- ego-browser：全场景截图报告。
