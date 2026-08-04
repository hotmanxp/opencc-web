# zai 实例启动流程修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/instances` 创建操作立即启动实例、实时刷新状态、使用配置 cwd，并在实例 ready 后自动打开对应页面。

**Architecture:** 保留现有 supervisor 的异步状态机和 IPC ready/heartbeat 协议。创建接口在持久化定义后复用 `doStart`，前端同步预打开空白标签，再以单实例 REST 条件查询等待 `running + port`；SSE 补齐 `instance.changed` 命名事件以提供常规列表增量刷新。

**Tech Stack:** TypeScript、Express、React、Zustand、Ant Design、Vitest、Testing Library、SSE、Bun/pnpm。

## Global Constraints

- 实例子进程必须通过 `SpawnOptions.cwd` 使用表单配置的绝对路径，不得回退到 supervisor 的 `process.cwd()`。
- 状态更新继续使用现有 `instance.changed` SSE 协议，不新增服务端事件格式。
- 启动 API 保持非阻塞 ready 的状态机语义；前端使用条件查询等待，不使用固定延迟代替状态判断。
- 创建失败、`down` 和等待超时必须清理预打开的空白标签，但不能误停 supervisor 中的实例。
- 完成前必须通过真实浏览器 `/ego-browser` 验收；不得用 Playwright、Puppeteer、curl 或单元测试替代。
- 使用 Bun-direct 运行 zai；不要用 tsc 整编 `opencc-src`。
- 不自动创建 git commit；只有用户明确要求提交时才执行提交流程。

---

### Task 1: 修复 supervisor 的创建即启动与 cwd 传递

**Files:**
- Modify: `packages/zai/src/server/services/instanceSupervisor.ts:186-218,250-264`
- Test: `packages/zai/test/server/services/instanceSupervisor.test.ts:5-58,68-177`

**Interfaces:**
- Consumes: `InstanceSupervisor.createInstance({ name: string; cwd: string })`、现有 `doStart(id)` 和注入的 `InstanceSupervisorDeps`。
- Produces: 创建成功后返回 `starting` 快照；spawn 收到 `cwd`；端口探测或 spawn 失败时实例变为 `down` 并带 `lastError`。

- [ ] **Step 1: 扩展 fake child 测试夹具以记录 spawn 选项**

在 `instanceSupervisor.test.ts` 顶部增加 `SpawnOptions` 类型导入，并让 `makeSupervisor()` 记录每次 spawn 的第三个参数：

```ts
import type { ChildProcess, SpawnOptions } from 'node:child_process'

// makeSupervisor 内
const spawnOptions: SpawnOptions[] = []
const deps: Deps = {
  // ...
  spawn: (_cmd, _args, opts) => {
    spawnOptions.push(opts)
    const c = new FakeChild()
    fakeChildren.push(c)
    return c as unknown as ChildProcess
  },
  // ...
}
return {
  events,
  writes,
  deps,
  fakeChildren,
  spawnOptions,
  advance: (t: number) => { time = t },
  setProbe: (n: number) => { probeStart = n },
}
```

保持现有 fake child 的 IPC 和 exit 行为不变。

- [ ] **Step 2: 写出创建即启动和 cwd 的失败测试**

在状态机 describe 中加入：

```ts
it('createInstance starts the child with the configured cwd', async () => {
  const { deps, fakeChildren, spawnOptions } = makeSupervisor()
  const { getInstanceSupervisor } = await initSup(deps)

  const snap = await getInstanceSupervisor().createInstance({
    name: 'demo',
    cwd: '/tmp/configured-cwd',
  })

  expect(snap.state).toBe('starting')
  expect(fakeChildren).toHaveLength(1)
  expect(spawnOptions[0]?.cwd).toBe('/tmp/configured-cwd')
})

it('start failure records down state before rethrowing', async () => {
  const { deps } = makeSupervisor()
  deps.probePort = vi.fn().mockRejectedValue(new Error('no free port'))
  const { getInstanceSupervisor } = await initSup(deps)

  await expect(
    getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' }),
  ).rejects.toThrow('no free port')

  const snap = getInstanceSupervisor().getSnapshots().find((s) => s.name === 'demo')!
  expect(snap.state).toBe('down')
  expect(snap.lastError?.message).toBe('no free port')
})
```

同时把现有“createInstance returns stopped snapshot”测试改成断言 `starting` 和已经产生 `instance.changed` 事件；其余显式 `startInstance` 调用保留，用于验证 starting 状态下重复启动不会重复 spawn。

- [ ] **Step 3: 运行失败测试，确认当前实现失败**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run test/server/services/instanceSupervisor.test.ts
```

Expected: 新增测试至少因快照仍为 `stopped`、没有 child 或 spawn options 没有 `cwd` 而失败；失败必须发生在断言，不得是测试配置错误。

- [ ] **Step 4: 实现最小 supervisor 修复**

在 `doStart` 的 spawn options 中加入配置 cwd，并把端口探测和 spawn 包在失败状态转换中：

```ts
const doStart = async (id: string) => {
  const entry = getEntry(id)
  if (entry.status.state === 'starting' || entry.status.state === 'running') {
    return snapshotOf(entry)
  }

  setStatus(entry, { state: 'starting', lastError: null })
  emit(id, entry.status)
  persistSafe()

  try {
    const port = await deps.probePort(INSTANCE_BASE_PORT)
    const child = deps.spawn(
      process.execPath,
      [cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open'],
      {
        cwd: entry.def.cwd,
        stdio: ['ipc', 'inherit', 'inherit'],
        detached: false,
        env: {
          ...process.env,
          ZAI_INSTANCE_ID: id,
          ZAI_SUPERVISOR_PID: String(process.pid),
          ZAI_INSTANCE_HEARTBEAT_MS: '5000',
        },
      },
    )
    attachChild(entry, child)
    return snapshotOf(entry)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus(entry, {
      state: 'down',
      port: null,
      pid: null,
      lastError: { at: new Date(deps.now()).toISOString(), message },
    })
    emit(id, entry.status)
    persistSafe()
    throw err
  }
}
```

在 `createInstance` 完成 `entries.set`、`persist()` 和初始事件广播后调用 `return doStart(def.id)`：

```ts
entries.set(def.id, entry)
await persist()
emit(def.id, entry.status)
return doStart(def.id)
```

不要改动 `stopInstance`、`restartInstance`、heartbeat 和持久化格式。

- [ ] **Step 5: 运行 supervisor 测试确认通过**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run test/server/services/instanceSupervisor.test.ts
```

Expected: PASS；若旧测试依赖 stopped 快照，只更新与创建语义直接相关的断言，不改变状态机其他断言。

---

### Task 2: 让 instance.changed SSE 事件到达前端

**Files:**
- Modify: `packages/zai/src/web/src/lib/eventSource.ts:20-47`
- Test: `packages/zai/src/web/src/lib/eventSource.test.ts:52-84`

**Interfaces:**
- Consumes: 服务端已有 `ServerEvent` 的 `instance.changed` 变体。
- Produces: `subscribeServerEvents()` 对命名事件 `instance.changed` 调用 `onEvent`。

- [ ] **Step 1: 写出命名 instance.changed 分发测试**

在现有 named event 测试旁加入：

```ts
test('dispatches instance.changed named events', () => {
  MockEventSource.instances = []
  const onEvent = vi.fn()
  subscribeServerEvents('s1', onEvent)
  const es = MockEventSource.instances[0]

  es.dispatchNamed('instance.changed', {
    type: 'instance.changed',
    eventId: 'e-instance',
    ts: 1,
    instanceId: 'inst_1',
    state: 'running',
    port: 9202,
    pid: 42,
    lastHeartbeatAt: '2026-08-04T00:00:00.000Z',
  })

  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'instance.changed', instanceId: 'inst_1' }),
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/lib/eventSource.test.ts
```

Expected: 新测试失败且 `onEvent` 未被调用。

- [ ] **Step 3: 注册事件名**

在 `NAMED_EVENT_TYPES` 的事件列表中加入：

```ts
'instance.changed',
```

不要修改 SSE URL、sid 过滤或解析逻辑。

- [ ] **Step 4: 运行事件流测试确认通过**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/lib/eventSource.test.ts
```

Expected: PASS。

---

### Task 3: 增加单实例快照合并能力

**Files:**
- Modify: `packages/zai/src/web/src/store/useInstanceStore.ts:4-45`
- Test: `packages/zai/src/web/src/store/useInstanceStore.test.ts:19-55`

**Interfaces:**
- Consumes: 完整 `InstanceSnapshot`。
- Produces: `useInstanceStore.getState().applyInstanceSnapshot(snapshot)`，按 id 替换已有条目；若条目尚不存在则追加，保证创建后的轮询结果不会丢失。

- [ ] **Step 1: 写出快照替换与追加测试**

加入：

```ts
it('applyInstanceSnapshot replaces an existing row', () => {
  useInstanceStore.getState().seed([{ ...baseSnap, state: 'starting' }])
  useInstanceStore.getState().applyInstanceSnapshot({
    ...baseSnap,
    state: 'running',
    port: 9202,
    pid: 42,
  })
  expect(useInstanceStore.getState().instances).toEqual([
    expect.objectContaining({ id: 'inst_1', state: 'running', port: 9202 }),
  ])
})

it('applyInstanceSnapshot appends an unknown row', () => {
  useInstanceStore.getState().seed([])
  useInstanceStore.getState().applyInstanceSnapshot({ ...baseSnap, id: 'inst_new' })
  expect(useInstanceStore.getState().instances.map((s) => s.id)).toEqual(['inst_new'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/store/useInstanceStore.test.ts
```

Expected: TypeScript/test failure because `applyInstanceSnapshot` is not in the store.

- [ ] **Step 3: 实现按 id 的不可变合并**

在 `InstanceStoreState` 增加方法签名，并实现：

```ts
applyInstanceSnapshot(snapshot) {
  set((state) => {
    const index = state.instances.findIndex((item) => item.id === snapshot.id)
    if (index < 0) return { instances: [...state.instances, snapshot] }
    const instances = [...state.instances]
    instances[index] = snapshot
    return { instances }
  })
},
```

- [ ] **Step 4: 运行 store 测试确认通过**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/store/useInstanceStore.test.ts
```

Expected: PASS。

---

### Task 4: 实现创建后的条件等待与自动打开

**Files:**
- Modify: `packages/zai/src/web/src/pages/Instances.tsx:26-88`
- Test: `packages/zai/src/web/src/pages/Instances.test.tsx:41-84`

**Interfaces:**
- Consumes: `POST /api/instances` 返回 `{ instance: InstanceSnapshot }`、`GET /api/instances/:id` 返回 `{ instance: InstanceSnapshot }`、`applyInstanceSnapshot`。
- Produces: 创建确认后自动启动（由后端 create 语义保证）、running 后导航到 `http://localhost:<port>`，失败/超时清理窗口并提示。

- [ ] **Step 1: 写出成功导航测试**

在页面测试中用完整合法快照替换当前无效的 `{"instance":{...}}` 响应，并添加窗口 mock：

```tsx
const running = {
  ...demo,
  state: 'running' as const,
  port: 9202,
  pid: 42,
  startedAt: '2026-08-04T00:00:00.000Z',
}
const popup = {
  closed: false,
  location: { href: 'about:blank' },
  close: vi.fn(),
}
vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
```

让 fetch mock 返回：POST 创建时 `{ instance: { ...demo, state: 'starting' } }`，实例查询时 `{ instance: running }`，并断言：

```ts
await waitFor(() => {
  expect(popup.location.href).toBe('http://localhost:9202')
})
expect(fetchMock).toHaveBeenCalledWith('/api/instances/inst_1')
```

- [ ] **Step 2: 运行页面测试确认失败**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/pages/Instances.test.tsx
```

Expected: `window.open` 未被调用/窗口地址仍为 `about:blank`，或创建响应解析失败；失败原因必须对应待实现行为。

- [ ] **Step 3: 写出 down 和窗口清理测试**

让实例查询返回：

```ts
{
  instance: {
    ...demo,
    state: 'down',
    lastError: { at: '2026-08-04T00:00:00.000Z', message: 'cwd failed' },
  },
}
```

断言 `popup.close` 被调用；若测试环境已 mock `message.error`，同时断言错误消息包含 `cwd failed`。

- [ ] **Step 4: 实现最小创建等待流程**

在 `Instances.tsx` 增加常量和快照等待函数：

```tsx
const INSTANCE_START_POLL_MS = 250
const INSTANCE_START_TIMEOUT_MS = 30_000

async function waitForRunningInstance(
  id: string,
  applySnapshot: (snapshot: InstanceSnapshot) => void,
): Promise<InstanceSnapshot> {
  const deadline = Date.now() + INSTANCE_START_TIMEOUT_MS
  while (true) {
    const res = await fetch(`/api/instances/${id}`)
    if (!res.ok) throw new Error('无法读取实例状态')
    const data = (await res.json()) as { instance: InstanceSnapshot }
    applySnapshot(data.instance)
    if (data.instance.state === 'running' && data.instance.port !== null) {
      return data.instance
    }
    if (data.instance.state === 'down') {
      throw new Error(data.instance.lastError?.message ?? '实例启动失败')
    }
    if (Date.now() >= deadline) throw new Error('实例启动超时,请稍后手动打开')
    await new Promise<void>((resolve) => setTimeout(resolve, INSTANCE_START_POLL_MS))
  }
}
```

在 `Instances()` 中取出 `applyInstanceSnapshot`，并调整 `onCreate`：

```tsx
async function onCreate(): Promise<void> {
  const popup = window.open('about:blank', '_blank', 'noopener,noreferrer')
  try {
    const values = await form.validateFields()
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? '创建失败')
    }
    const data = (await res.json()) as { instance: InstanceSnapshot }
    setOpen(false)
    form.resetFields()
    void loadInstances()
    const started = await waitForRunningInstance(data.instance.id, applyInstanceSnapshot)
    const url = `http://localhost:${started.port}`
    if (popup && !popup.closed) popup.location.href = url
  } catch (err) {
    if (popup && !popup.closed) popup.close()
    message.error(err instanceof Error ? err.message : '创建失败')
  }
}
```

如果需要避免表单校验失败时出现空白标签，先保存 `popup`，在 catch 中统一关闭；创建失败和校验失败都不会留下窗口。保持现有手动“打开”按钮不变。

- [ ] **Step 5: 运行页面测试确认成功路径和失败路径通过**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run src/web/src/pages/Instances.test.tsx
```

Expected: PASS；成功测试应验证 running 端口导航，失败测试应验证窗口关闭。

---

### Task 5: 运行回归验证并完成真实浏览器验收

**Files:**
- Verify only: all files changed in Tasks 1–4

**Interfaces:**
- Consumes: 已通过的 supervisor、store、SSE 和页面行为。
- Produces: 类型检查、相关测试、真实 `/instances` 用户路径的验证证据。

- [ ] **Step 1: 运行相关测试集合**

Run:

```bash
pnpm --filter @zn-ai/zai exec vitest run \
  test/server/services/instanceSupervisor.test.ts \
  src/web/src/lib/eventSource.test.ts \
  src/web/src/store/useInstanceStore.test.ts \
  src/web/src/pages/Instances.test.tsx
```

Expected: all selected suites PASS。

- [ ] **Step 2: 运行 workspace 类型检查**

Run:

```bash
pnpm -r exec tsc --noEmit
```

Expected: exit code 0；不得以跳过 `opencc-src` 或 `--no-verify` 绕过错误。

- [ ] **Step 3: 启动/连接真实 zai 并用 ego-browser 验收**

按项目约束使用 `/ego-browser`，复用同一 task space 打开 `http://localhost:9201/instances`，完成以下路径：

1. 记录当前实例 cwd。
2. 点击“新建实例”，填写一个真实存在且与当前 cwd 不同的绝对目录。
3. 点击创建，确认列表先显示 starting，随后变为 running 且端口/pid/心跳出现。
4. 确认自动打开的新标签 URL 使用该端口。
5. 在新标签页面验证工作目录显示为表单配置目录，而不是 supervisor 容器路径。
6. 返回管理页确认新实例卡片仍存在且信息已刷新。

Expected: 三个用户问题均消失；记录页面快照/截图和失败时的环境阻塞。

- [ ] **Step 4: 检查工作树并报告，不自动提交**

Run:

```bash
git status --short
git diff --check
```

Expected: 只包含本任务的源码、测试和已确认设计/计划文档；不提交、不推送、不删除用户文件。
