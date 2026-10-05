# InstanceSupervisor 并发 start/stop 产生双 spawn 与孤儿子进程

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 高（端口被孤儿进程占用，实例无法再启动）

## 摘要

`doStart` 在设置 `state = 'starting'` 之后、`spawn` 之前存在一个 **await 空窗**
（端口探测）。`doStop` 在 `entry.child === null` 时会把状态**改回 `stopped`** 并
立即返回。两个调用交错时，`doStart` 的去重守卫被绕过，**spawn 出两个子进程，
后一个覆盖前一个的 `entry.child` 引用** —— 先 spawn 的那个成了永远不会被 kill 的孤儿。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/instanceSupervisor.ts` | 309 | 去重守卫 `if (state === 'starting' \|\| state === 'running') return` |
| 同上 | 310 | `setStatus(entry, { state: 'starting' })` |
| 同上 | 327 | `await deps.assertPortAvailable(pinned)` —— **await 空窗起点** |
| 同上 | 330 | `await deps.probePort(INSTANCE_BASE_PORT)` —— **await 空窗起点** |
| 同上 | 410 | `deps.spawn(...)` —— 空窗终点 |
| 同上 | 439 | `doStop` 的 `if (!child \|\| !childState)` 早退分支 |
| 同上 | 264 | `entry.child = child` —— 后者覆盖前者 |
| 同上 | 531 | `restartInstance` = `await doStop(id); return doStart(id, opts)` |
| 同上 | 529-530 | `startInstance` / `stopInstance`，**无任何 in-flight 守卫** |

`cli/ports.ts:61` 的 `isPortBusy` 自带最多 200ms 的探测等待，空窗宽度足够
让一次完整的 `doStop` + `doStart` 走完。

## 复现链（双击「重启」按钮）

`restartInstance`（:531）串行 `await doStop` → `doStart`。两次调用交错：

1. restart#1 的 `doStop` 杀掉子进程 C1，resolve。
2. restart#1 的 `doStart` 命中 :310 设 `state = 'starting'`，进入 :327/:330 的 await。
3. restart#2 的 `doStop`（:438-439）看到 `entry.child === null` ——
   C1 已退出、C2 尚未 spawn —— **把 state 改回 `'stopped'` 并立即返回 200**。
4. restart#2 的 `doStart` 走到 :309 守卫，此时 state 已是 `'stopped'`，**守卫放行**，
   再次设 `'starting'`，进入同一个 await。
5. 两个 `doStart` 相继 resume：#1 spawn 出 C2，`entry.child = C2`；
   #2 spawn 出 C3，`entry.child = C3`。**C2 的引用被覆盖，永久泄漏。**

### 两种失败形态

**钉端口**（`entry.def.startPort` 有值）：C2 先起来并占住端口，C3 的
`assertPortAvailable` 失败，entry 被强制置为 `down` 并带 `lastError`。
**UI 显示「启动失败」，但那个端口上确实有个活着的 zai 在服务。**
此后每次 `POST /instances/:id/start` 都撞 `EADDRINUSE`，用户只能手动 kill。

**自动扫描**（`probePort`）：不报错，但**两个子进程都活着，只有一个被追踪**。
`shutdown()`（:572-592）与子进程 exit handler 都只看 `entry.child`，
永远看不到 C2。

## 根因

两个独立缺陷叠加：

1. **`doStop` 的空 child 早退会「撤销」正在进行的 start。** 从 supervisor 的视角
   「此刻没有子进程，所以已停止」是成立的，但它不知道另一个 `doStart` 正在飞行中。
   状态机缺一个 `stopping → stopped` 的转换守卫：只有在没有 in-flight start 时
   才允许置 `stopped`。

2. **`state` 标志不足以做去重。** 守卫（:309）是 check-then-act ——
   `if (state === 'starting') return` 与 `setStatus(state = 'starting')` 之间
   没有任何同步原语。在 Node 单线程下这段本身不会被打断，**但 await 之后状态
   可能已被别的调用改写**（正是 doStop 干的事），守卫的假设就失效了。

## 修复

1. **给每个 entry 加 in-flight promise 锁**（最直接）：`entry.starting?: Promise<...>`，
   `doStart` 开头若有 in-flight 就直接返回它，否则把整个 doStart 包成 promise 存进去，
   `finally` 里清空。这样无论 doStop 怎么改 state，都不可能有第二个 doStart 穿过。

2. **`doStop` 的空 child 分支需要判断是否有 in-flight start**。有的话应等待它
   结束（或标记取消），而不是置 `stopped` 直接返回。

3. `attachChild`（:264）处加断言：若 `entry.child` 已非空，说明发生了双 spawn，
   应当立即 kill 新来的那个（或老的那条）并记警告，而不是静默覆盖。

4. 长期：`startInstance` / `stopInstance`（:529-530）作为对外入口，
   应当串行化到同一把 per-instance 锁上。

## 关联问题

- 同类的「fire-and-forget async 调用点未挂 `.catch()`」模式在
  `docs/bugs/2026-10-05-session-inbox-sync-try-catch.md` 中有更严重的实例 ——
  那里的失败后果是整个进程崩溃。
- 孤儿子进程能存活到进程退出之外，还与
  `docs/bugs/2026-10-05-repl-registry-child-process-leak.md` 记录的
  `closeServer()` 回收清单缺项属于同一类治理缺口。
