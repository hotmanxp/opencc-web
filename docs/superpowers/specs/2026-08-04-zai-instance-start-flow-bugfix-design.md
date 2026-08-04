# zai 实例创建启动流程修复设计

**日期：** 2026-08-04
**状态：** 已确认，待实施

## 背景

`/instances` 实例管理页面在创建/启动实例时存在三个用户可见问题：

1. 子实例启动后的状态没有可靠地刷新到页面。
2. 新实例启动成功后没有自动打开新页面。
3. 子实例实际继承 supervisor 的工作目录，而不是实例定义中配置的 `cwd`。

期望行为已确认：点击“新建实例”的创建按钮后，实例立即启动；启动成功后自动打开该实例页面；列表实时显示启动状态和端口；子实例使用表单配置的 cwd。

## 根因

- `packages/zai/src/web/src/lib/eventSource.ts` 的 `NAMED_EVENT_TYPES` 没有登记 `instance.changed`。服务端虽广播该事件，浏览器却没有注册对应的 `addEventListener`，因此 `useInstanceStore.applyInstanceChanged` 不会被调用。
- `packages/zai/src/server/routes/instances.ts` 调用 `createInstance` 后仅返回创建结果；`instanceSupervisor.createInstance` 当前只持久化 stopped 定义，没有启动子进程；`packages/zai/src/web/src/pages/Instances.tsx` 也没有补充启动和打开流程。
- `packages/zai/src/server/services/instanceSupervisor.ts` 调用 `spawn` 时未传 `cwd`。Node 子进程因此继承 supervisor 的 `process.cwd()`；子进程 `runDirectServer` 又以 `process.cwd()` 初始化 `createApp`。

## 设计

### 1. Supervisor 启动与 cwd 传递

保持现有状态机和 IPC ready/heartbeat 机制不变：

- `createInstance({ name, cwd })` 创建并持久化定义后，调用现有 `doStart(id)`。
- `doStart` 的 `SpawnOptions` 增加 `cwd: entry.def.cwd`。
- 继续让 `doStart` 在子进程 spawn 后返回 `starting` 快照；ready IPC 到达时再切换为 running 并广播事件。
- 如果端口探测或 spawn 抛错，启动流程将该实例置为 `down`、写入 `lastError`、持久化并广播后再向路由抛出错误，避免留下永久 `starting` 状态。
- 定义中的 cwd 不做改写，不回退到 supervisor cwd。

这样所有调用 `createInstance` 的入口都共享“创建即启动”语义，并确保子实例运行时的 `process.cwd()` 与配置一致。

### 2. 前端创建、刷新与自动打开

在 `Instances.tsx` 中把创建流程设计为条件等待，而不是让 API 请求阻塞到 ready：

1. 用户点击 Modal 确认时，先同步调用 `window.open('about:blank', '_blank')`，保留浏览器用户手势上下文。
2. POST `/api/instances` 成功后关闭 Modal、清空表单并刷新列表。
3. 使用实例 ID 查询 `/api/instances/:id`，首次立即查询，之后每 250ms 查询一次，最多等待 30 秒；每次收到快照都更新列表；当快照满足 `state === 'running' && port !== null` 时，将预打开窗口导航到 `http://localhost:<port>`。
4. 当快照为 `down` 时展示 `lastError.message` 并关闭空白窗口。
5. 达到等待上限仍未 running 时提示用户，保留实例卡片和手动“打开”入口；不停止 supervisor 中的实例。
6. `window.open` 返回 null 时不影响创建和启动，用户仍可使用卡片上的“打开”按钮。

列表常规状态更新继续由 `instance.changed` SSE 增量驱动；创建流程的单实例 REST 查询用于确保即使 SSE 尚未连接或事件发生在初始列表请求之前，也能完成自动导航。

### 3. SSE 事件注册

在 `eventSource.ts` 的命名事件列表中加入 `instance.changed`，不改变 URL、sid 过滤或服务端事件格式。现有 `useEventStream.dispatch` 已有对应 reducer 分支，保持不变。

## 错误处理

| 场景 | 行为 |
|---|---|
| 创建请求返回非 2xx | 显示服务端错误，关闭预打开窗口，不开始等待 |
| 子实例进入 `down` | 显示 `lastError.message`，关闭预打开窗口，保留卡片 |
| 等待超过上限 | 显示启动仍未完成的提示，保留卡片和手动操作 |
| 浏览器拦截新窗口 | 不影响实例生命周期和列表刷新，依赖手动“打开”按钮 |
| cwd 不存在或不是目录 | 保持现有路由 400 校验 |

## 测试设计

### 后端

- 更新 supervisor 测试：创建后会调用 spawn 并进入 starting；spawn options 的 cwd 等于实例定义 cwd。
- 保留并运行现有 ready、heartbeat、停止、重启、删除、持久化和错误状态测试。

### 前端事件流

- 增加 `instance.changed` 命名 SSE 分发测试，确保事件到达订阅回调。

### 实例管理页面

- 创建请求成功后触发自动启动流程，并使用返回实例 ID 查询状态。
- running 快照带端口时，预打开窗口被导航到对应实例 URL。
- down 或等待超时会关闭窗口并显示错误/提示。
- 保留当前实例禁用操作和现有创建表单测试。

### 验证

- `pnpm -r exec tsc --noEmit`
- 相关 workspace 的实例 supervisor、事件流和 Instances 页面 Vitest 测试
- 使用 `/ego-browser` 启动/连接真实 zai 实例，在 `/instances` 完成：创建实例、观察 starting → running、验证 cwd、确认自动打开新页面，并检查列表状态和端口刷新。

## 影响范围

预计修改：

- `packages/zai/src/server/services/instanceSupervisor.ts`
- `packages/zai/src/web/src/lib/eventSource.ts`
- `packages/zai/src/web/src/pages/Instances.tsx`
- 对应 supervisor、事件流、页面测试文件

不修改实例持久化格式、SSE 服务端协议、端口分配策略或现有 stop/restart 状态机。
