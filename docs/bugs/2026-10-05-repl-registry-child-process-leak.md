# ReplRegistry 未接入 closeServer 导致子进程泄漏

**日期：** 2026-10-05
**发现者：** `--by opencc`
**状态：** 已确认，未修复
**严重度：** 中高（进程泄漏，长期运行后累积）

## 摘要

`ReplRegistry` 是唯一持有子进程、却**没有**被 `closeServer()` 回收的服务。
它 spawn 的 `sh -c` 子进程在 zai 正常退出（restart / stop）后存活，被 init 收养，
持续占用 CPU 与内存。

## 位置

| 文件 | 行 | 说明 |
|------|----|------|
| `packages/zai/src/server/services/repl/ReplSession.ts` | 148 | `spawn(shell.cmd, [...prefixArgs, command], { cwd, env })` —— **piped stdio，无 detached** |
| `packages/zai/src/server/services/repl/ReplRegistry.ts` | 27 | `dispose(sessionId)` —— 唯一的移除路径 |
| `packages/zai/src/server/services/repl/ReplRegistry.ts` | 44 | `__resetReplRegistryForTest` —— 唯一调用 `dispose` 的地方 |
| `packages/zai/src/server/services/runtimeLifecycle.ts` | 60-143 | `closeServer()` —— 回收清单中**没有** ReplRegistry |

## 根因

`closeServer()` 依次回收：instanceSupervisor → backgroundRuntime → weixinBot →
**`terminalService.disposeAll()`** → agentRegistry → skillWatcher → http server →
vite → branchChecker。

`ReplRegistry` 不在清单里。全仓 grep 确认 `dispose()` 仅能从测试 seam
`__resetReplRegistryForTest` 到达（`agentRuntime.repl.ts:278`  dispose 的是另一个 map）。

只有 `ReplSession.abort()`（:196）或 `dispose()`（:212）会 kill 子进程，两者都需要
显式调用 —— 进程退出时无人调用。

## 实证

用与 `ReplSession.exec()` 相同的 spawn 方式（`sh -c` + piped stdio）复现：

```
spawned pid 46558
parent exiting cleanly, no kill        ← 模拟 closeServer() 后 process.exit(0)
--- 父进程退出后 ---
46558 sleep 4321                       ← 子进程存活，被 init 收养
```

对照组：同样流程 + 调用 `reg.dispose()` → 子进程立即消失。

## 为什么 PTY 那条路反而是安全的（反直觉）

- `node-pty` 走 `forkpty`，PTY shell 是 session leader 且以 slave 为控制终端 ——
  master 关闭时内核会发 SIGHUP，进程被自动回收。
- `sh -c` + piped stdio 的子进程是**普通同进程组子进程**，父进程干净
  `process.exit(0)` 时**收不到任何信号**。

代码里被精心记账的 PTY 路径（`AGENTS.md` 声称的三处回收，实测三条路径都正确）
反而是安全的；真正漏掉的是不显眼的 repl 路径。这个反转正是它长期未被发现的原因。

## 附带的第二个问题：registry 无界增长

`GET /bash/repl/:sessionId/events`（`routes/bashRepl.ts:75`）在**订阅**时就通过
`reg.get()` 创建一个永久条目。而 `ReplSession.exec()` 的 busy 守卫
（`ReplSession.ts:135` 的 `if (this.child)`）是 per-session 的 —— 变化 `sessionId`
即可绕过。

在 `--lan` 模式下，客户端可创建无限多个并发 shell，且全部不被回收。

## 修复

1. 给 `ReplRegistry` 加 `disposeAll()`（遍历 map 调 `dispose()` 后清空），
   在 `closeServer()` 中调用，位置对齐 `terminalService.disposeAll()`。
2. 长期看，`bashRepl.ts:75` 不应把「订阅事件」当作「创建会话」的副作用 ——
   事件订阅不应分配需要显式回收的资源。

## 已排除的关联怀疑

`bashRepl.ts:80-82` 的心跳 `res.write` 没有 `res.writableEnded` 守卫、也没有
`res.on('error')`，曾被怀疑会在客户端断开时抛未捕获异常导致整个进程崩溃。

**实测排除**：分别用正常 `req.destroy()` 与硬 RST（`SO_LINGER 0`）断开真实 HTTP
连接，Node 对已销毁 socket 的 `res.write` 是静默 no-op，且 `req.on('close')`
已清除 interval —— 不崩溃。`terminal.ts:183` 有 `!res.writableEnded` 守卫而
`bashRepl.ts:81` 没有，属于风格不一致，不是缺陷。
