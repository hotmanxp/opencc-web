# 未捕获的 async handler 异常直接杀掉整个 zai 进程

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 严重（全进程崩溃 + 会话/SSE 全丢）

## 摘要

Express 4 **不会**把 async handler 返回的 rejection 转发给错误中间件 —— 只有同步
`throw` 才会。而 zai 既没有 `unhandledRejection` 兜底，又有一批裸 `await` 的路由，
最终落到会 reject 的文件系统操作上。

结果是：**一个后台轮询撞上文件竞态，整个 server 进程退出**，所有打开的会话、
SSE 长连接、正在跑的 agent turn 一起消失。不是请求挂住，是进程死。

## 根因（三层叠加，缺一不可）

| 层 | 位置 | 事实 |
|----|------|------|
| 1. 框架 | `packages/zai/package.json:53` | `"express": "^4.21.2"`，实测解析到 **4.22.1**。Express 4 不 catch async rejection |
| 2. 兜底缺失 | 全仓 | `grep -rn "unhandledRejection\|uncaughtException" packages/zai/src/` **零注册**。Node 22+ 默认把 unhandledRejection 当 throw → uncaught exception → 退出 |
| 3. 路由裸奔 | `packages/zai/src/server/index.ts:336` | catch-all error handler 存在，但**永远收不到**第 2 类错误 |

`index.ts:336` 这个 handler 给人虚假的安全感 —— 它确实存在、确实处理了 Express 错误，
只是对 async 路径完全无效。

## 实证

用本仓库自己的 express 4.22.1 + Node 25.6.0 复现机制本身：

```js
const express = require('.../packages/zai/node_modules/express');
const app = express();
app.get('/boom', async (req, res) => { await Promise.reject(new Error('ENOENT')); });
app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });
```

```
Error: ENOENT
    at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)
    at next (express/lib/router/route.js:149:13)
    ...
Node.js v25.6.0
=== process exit code: 1 ===
```

错误中间件从未被调用，请求也没有响应 —— 进程直接死。

## 最容易触发的路径：任务工厂删除竞态

不是理论边界，前端对 `GET /super-tasks` **每 3 秒轮询一次**（`super-tasks` 页面挂载期间）。

```ts
// packages/zai/src/server/routes/superTasks.ts:87
// 上一行 86 的 sweepArchiveFinishedTasks() 有 .catch()，这一行没有
const [{ fingerprint, buckets }, state] = await Promise.all([getTasksSnapshot(), getTaskFactoryState()])
```

`getTasksSnapshot()` → `listIn()` → 逐个 `readTaskMeta()`，而后者是典型的
check-then-act：

```ts
// packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts:569-576
async function readTaskMeta(id: string, bucket: TaskBucketName): Promise<TaskYaml | null> {
  const dir = taskDir(bucket, id)
  const yamlPath = join(dir, TASK_YAML_FILENAME)
  if (existsSync(yamlPath)) {                       // ← 检查
    const text = await readFile(yamlPath, 'utf-8')  // ← 使用：中间被删就 ENOENT
```

同时用户在 UI 上删除任务 → `deleteTasks` 走：

```ts
// taskFactoryFiles.ts:864
await rm(taskDir(buckets[i]!, ids[i]!), { recursive: true, force: true })
```

**用户点一下删除，3 秒后的轮询就可能把整个 server 带走。**
`listIn`（:670）内的 `readdir`（:674）同样无保护。

## 同类未加保护的 await

| 路由 | 行 | 风险来源 |
|------|----|---------|
| `routes/superTasks.ts` | 87 | 见上，3s 轮询 |
| `routes/superTasks.ts` | 215, 227, 301, 317, 331, 354, 371 | `getTaskDetails` / `getTaskSummary` / `checkTaskIntakeDocs` |
| `routes/superTasks.ts` | 249, 264, 283 | `setTaskFactoryState` → `mkdir` + `writeFile`（EACCES / ENOSPC / EROFS） |
| `routes/tasks.ts` | 38, 50, 56, 63 | `runtime().dispatch/list/get/cancel` |
| `routes/aa/pairing.ts` | 196 | `cancelPairing()` |
| `routes/resources.ts` | 84 | `spawn('npx', ...)`，`spawner.ts:146` 在 ENOENT 时 reject |

**对照组说明这不是无知**：`routes/weixin.ts`、`routes/instances.ts`、
`routes/agentSettings.ts` 全部包了 try/catch。模式是已知的，只是没铺开。
`superTasks.ts:86` 甚至专门写了注释强调「此处 catch 为双保险，绝不阻塞/拖垮 3s 轮询」——
安全意识在这个文件里是有的，只是差一行。

## 修复

按性价比排序，建议前两条先做，能一次性堵住整类：

1. **进程级兜底**（一处，覆盖所有现有及未来路由）。在 `createApp` 早期或 CLI 入口注册
   `process.on('unhandledRejection', ...)`，记日志 + 决定是否退出。这不替代逐路由 try/catch，
   但把「一个请求搞死整个 server」降级为「一个请求返回 500」。

2. **给裸 await 补 try/catch**。`superTasks.ts:87` 最优先 —— 改成
   `await Promise.all([getTasksSnapshot(), getTaskFactoryState().catch(() => null)])`
   之类，或整体包 try/catch 后返回 `modified:false` 让前端下个周期重试。

3. **根治 check-then-act**。`readTaskMeta` 里 `existsSync` + `readFile` 换成单次
   `readFile` + catch ENOENT → 返回 null。`listIn` 的 `readdir` 同样包一层。
   这样即使上层忘了 try/catch 也不会炸。

4. 长期：升级 Express 5，或引入 `express-async-errors` 这类把 async rejection
   转发给 `next(err)` 的 wrapper。注意 Express 5 改变了 path 匹配语义，
   `router.tsx` 之外的通配路由（`app.use('*')`、可选参数）需要复核。

## 关联问题

- `docs/bugs/2026-10-05-non-atomic-write-data-loss.md:64-67` 记录了同一机制的另一处
  表现（`fsWrite.ts:99` 的 `stat` 在 try/catch 之外）。同源同解。
- `docs/bugs/2026-10-05-repl-registry-child-process-leak.md:76-81` 曾怀疑
  `bashRepl.ts:81` 的裸 `res.write` 会导致崩溃并**实测排除**。那处确实安全
  （Node 对已销毁 socket 的 `res.write` 是静默 no-op），但排除的是**另一条**路径
  —— 崩溃的根因是 async rejection，不是 `res.write`。
