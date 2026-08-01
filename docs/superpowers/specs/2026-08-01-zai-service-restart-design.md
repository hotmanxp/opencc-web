# 2026-08-01 zai 服务重启设计

> 范围:`packages/zai` 内 `zai start` 受管模式;设置抽屉新增"服务"区段触发重启。

## 1. 背景与目标

`zai start` 当前是单进程直跑,只能通过外部 kill + 拉起重启。本次目标:

- 在设置抽屉底部暴露「重启服务」按钮,带二次确认;
- 仅作用于 `zai start` 的受管启动(`--managed` 标志,默认开启);
- 内部 supervisor 负责:启动子进程、接收重启信号、退避重试、健康检查;
- dev / `dev:node` / 单元测试 路径行为完全不变。

## 2. 角色与进程模型

```
$ zai start
  └─ supervisor.ts (主进程, P1)
       ├─ detached child = bin/.../server.js, env.SUPERVISOR_PID=P1.pid
       │     ├─ createApp + listen
       │     ├─ IPC: process.on('message') { ready | restart | abort | shutdown }
       │     └─ process.exit(0) on graceful close
       └─ 进程角色通过 ZAI_SUPERVISOR_PID 识别; 缺失时按旧路径运行
```

- `supervisor.ts` 与 `server.ts` 同目录 `packages/zai/src/cli/`。
- IPC channel 复用 `child_process.spawn` 默认行为(`stdio:['ipc','inherit','inherit']`),无新增 socket。
- CLI 入口 `cli/start.ts` 在 `--managed` 时调用 `supervisor.run()`,否则保持原 `createApp + listen`。

## 3. 组件

| 路径 | 职责 |
|---|---|
| `packages/zai/src/cli/supervisor.ts` | 启动子进程、监听 ready/exit/restart、写状态/日志、健康检查 |
| `packages/zai/src/cli/start.ts` | 解析 `--managed` / `--no-managed`,转交 supervisor 或直接跑 server |
| `packages/zai/src/server/routes/system.ts` | `POST /api/system/restart`、`GET /api/system/status` |
| `packages/zai/src/server/services/restartCoordinator.ts` | 协调 gracefulClose:drain in-flight → 通知 supervisor → 退出 |
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | 底部新增"服务"区段,展示状态徽章 + 重启按钮 + Modal 二次确认 |
| `packages/zai/src/web/src/lib/systemApi.ts` | 浏览器侧 fetch 包装:`requestRestart()`、`getStatus()` |

## 4. 数据流

### 4.1 受管模式启动

1. `zai start --managed` → `supervisor.run()`。
2. supervisor 写 `~/.zai/state/managed.json` (initial state) → `spawn` child 透传 env/args → 等 child 发送 `{type:'ready'}`。
3. 收到 ready → 状态置 `running` → CLI 输出 `listening on :PORT (pid=...)`。
4. child 30s 内未发 ready → 视为失败 → 进入退避(见 §6)。

### 4.2 页面触发重启

1. 用户在 SettingsDrawer 点「重启服务」 → `Modal.confirm` 「将会中断当前对话/任务,确定?」 → 调 `POST /api/system/restart`。
2. 路由 (`routes/system.ts`) 校验 `ZAI_SUPERVISOR_PID` 存在,缺失返回 `409 { error: 'not_managed' }`。
3. 调用 `restartCoordinator.requestRestart(reason)`:
   1. 通过 `__zaiEventBus` 广播 `system.restarting` (SSE 通道),前端 toast 显示 15s 倒计时 + 「取消」按钮。
   2. drain in-flight:轮询 `agentRuntime` 与 `backgroundRuntime` 的活跃计数,直到 0 或 5s 超时。
   3. `httpServer.close()`(Express `server.closeAllConnections?.()` 兜底 keep-alive)。
   4. `process.send({type:'restart', reason, ts})`。
   5. `process.exit(0)`。
4. supervisor 收到 restart 消息 → 写日志 `~/.zai/logs/restart.jsonl` → spawn 新 child。
5. 前端在 disconnect 后轮询 `GET /api/system/status`(2s 一次,最多 30 次),拿到 `200 { state: 'running' }` 后关闭 toast。

### 4.3 取消与异常

- toast 期间点「取消」→ `POST /api/system/restart/cancel` → coordinator 已注册但未进入 close 阶段 → 直接清理标志位,toast 关闭。
- 5s drain 超时 → `agentRuntime` 与 `backgroundRuntime` 的活跃 controller 调 `.abort()`(复用 `routes/agent.ts` HARD_TIMEOUT 路径),不延后 exit。
- 任意阶段抛出 → coordinator 兜底执行 `process.exit(0)`,让 supervisor 接管。

## 5. 状态/日志文件

- `~/.zai/state/managed.json`
  ```json
  {
    "supervisorPid": 1234,
    "state": "starting|running|restarting|failed",
    "childPid": 5678 | null,
    "startedAt": "2026-08-01T12:00:00Z",
    "restarts": 0,
    "lastError": null | { "at": "...", "message": "..." }
  }
  ```
- `~/.zai/logs/restart.jsonl` 每次事件追加一行 `{ at, type, childPid, durationMs, reason? }`。
- `state/managed.json` 由 supervisor 单写者锁 (`proper-lockfile` 已在仓内使用),子进程只读。

## 6. 错误处理与退避

| 场景 | supervisor 行为 | 子进程行为 |
|---|---|---|
| 启动 30s 内未发 ready | 退避 1s/2s/4s,最多 3 次;失败写 `lastError` 并退出 1 | — |
| 退出码非 0 | 立即退避 1s 重启 1 次,仍失败转 failed | — |
| 收到 `restart` 消息 | 写日志 + spawn 新 child,restart 计数 +1 | 已发 exit |
| Ctrl-C (SIGINT) | 第一次:转发 SIGINT 给 child; 5s 后未退:再 SIGTERM; 10s 后未退:SIGKILL | 收到信号走 gracefulClose 路径 |
| 重启 3 次仍失败 | 状态 `failed`,CLI 退出 1;`zai start` 下次启动打印 lastError 警告 | — |

## 7. 受管模式开关与向后兼容

- `zai start` 默认 `--managed`(即原 `zai start` 行为升级,需要 CHANGELOG 标注);
- 提供 `zai start --no-managed` 回到旧单进程模式,适合用户用 systemd/launchd 自行管理;
- `zai dev` / `dev:node` 不受管,行为完全不变;
- 单元测试 / CI 通过 `ZAI_SUPERVISOR_PID=`(空)或 `ZAI_SUPERVISOR_PID` 缺失走旧路径。

## 8. 安全

- 路由层不新增鉴权(沿用 server 整体的 localhost-only 假设,见 zai AGENTS.md);
- supervisor 自身不做 API 调用,只接收 IPC 消息;`reason` 字段白名单(枚举 `user_action | auto_recovery | update`),写入日志不直接执行;
- 受管模式启动记录 child PID,防止误接管别人留下的 zai 进程;`managed.json` 写失败时 supervisor 退出 1 而非静默运行。

## 9. 测试

| 层 | 文件 | 覆盖点 |
|---|---|---|
| 单元 | `packages/zai/test/cli/supervisor.test.ts` | spawn 回调、退避表、Ctrl-C 升级、lastError 写盘 |
| 单元 | `packages/zai/test/server/restartCoordinator.test.ts` | drain 阶段、in-flight 计数、cancel、abort 兜底 |
| 单元 | `packages/zai/test/server/routes/system.test.ts` | 受管/非受管分支、SSE 广播 |
| 组件 | `packages/zai/test/web/SettingsDrawer.restart.test.tsx` | 按钮显示、确认 modal、disabled 条件、toast 状态 |
| 集成 | `packages/zai/test/cli/supervisor.integration.test.ts` | spawn 一个 echo 子进程模拟 restart 消息,断言 30s 内重启 3 次成功 |
| 手动 | 文档末尾 checklist | `zai start --managed` 启动 → curl restart → 端口再通 |

## 10. 风险与回退

- **回退**:若生产出现 supervisor 反复失败,通过 `zai start --no-managed` 立即回退;无需改代码。
- **进程泄漏**:macOS 下 detached child 在父进程死掉后会变孤儿(由 launchd 接管),因此 SIGKILL supervisor 前必须先 SIGKILL child,本设计在 §6 列了升级序列。
- **状态文件锁竞争**:`proper-lockfile` 已在仓内使用,沿用即可;如未来多 supervisor 需引入 `flock`。

## 11. 文档与交付

- 本 spec 位于 `docs/superpowers/specs/2026-08-01-zai-service-restart-design.md`;
- 实施 plan 写在 `docs/superpowers/plans/2026-08-01-zai-service-restart.md`(writing-plans 阶段);
- CHANGELOG 条目:`feat(zai): add service restart from settings drawer (managed mode)`。
