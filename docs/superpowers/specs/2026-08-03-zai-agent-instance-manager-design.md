# zai agent 实例管理器设计

**日期：** 2026-08-03
**状态：** 已确认

## 背景

zai 目前以单进程模式运行：`zai dev`（Bun 开发模式，API 7715 + Vite 9201）或 `zai start`（生产模式，默认 9201）。已有能力：

- **per-instance supervisor**（`cli/supervisor.ts`）：`zai start` 默认进入 managed 模式，supervisor 守护**单个** child 进程（ready 检测、restart、shutdown），状态写 `~/.zai/state/managed.json`。子进程通过 IPC `sendReady({type:'ready',pid,port})` 上报就绪（`server/services/readyHook.ts`）。
- **端口自动递增**（`cli/start.ts` / `cli/dev.ts`）：从 base port 向上扫描 `EADDRINUSE` 自动跳号。
- **headless 心跳**（opencc-src `cli/headlessHeartbeat.ts`）：面向 headless/CI 外部观察者的 stderr/stream-json 心跳，**不是**给 supervisor 的。
- **Web UI 侧边栏菜单**（`web/src/components/Layout.tsx` 的 `menuItems`）。

用户需要像 docker 一样在一个 Web 菜单里**管理多个 agent 实例**：启动、关闭、重启；每个实例独立端口；由守护进程（supervisor）掌控；实例定时发送心跳让 supervisor 判断存活。这是**新架构**，不是扩展现有单实例 supervisor。

## 目标

1. 在 zai Web UI 侧边栏新增「实例管理」菜单，可视化管理多个 agent 实例。
2. 支持创建、启动、关闭、重启、删除实例（实例 = 完整 zai 服务器进程，独立端口）。
3. 新实例端口自动分配且与当前实例及其它实例不同。
4. 当前 zai 进程内嵌 supervisor 角色，负责 spawn/停止/重启/心跳监测。
5. 实例通过 IPC 定时发送心跳，supervisor 心跳超时判定 down。
6. 实例定义（名称/cwd）持久化到 `~/.zai/instances.json`，supervisor 重启后手动启动。

## 非目标

- 不引入独立 supervisor 守护进程 / 独立管理控制台。
- 不做实例崩溃自动重启（手动拉起）。
- 不引入 HTTP 心跳或主动 `/api/health` 探活。
- 不修改现有 `zai start` 的 per-instance supervisor 行为。
- 不按实例拆分 `~/.zai` 数据目录；会话按 cwd 隔离，复用现有 multi-pwd 机制。
- 不做跨实例的事件同步 / 会话迁移。
- 不在单个实例内切换 cwd。

## 核心决策

| 决策点 | 选择 |
|---|---|
| 实例粒度 | 完整 zai 服务器实例（独立进程 + 端口 + Web UI + runtime） |
| supervisor 形态 | 当前 zai 进程内嵌（现有 Web UI 加菜单） |
| 心跳通道 | IPC（supervisor spawn 时建立，子实例定时 `process.send`） |
| 创建参数 | 名称 + cwd，端口自动分配，其余继承默认 |
| 崩溃处理 | 标记 down + lastError，手动拉起 |
| 持久化 | 定义落盘 `~/.zai/instances.json`，重启后状态重置 stopped |
| 心跳超时处理 | kill 占端口进程 → 标 down（避免死进程占端口） |
| supervisor 退出 | 优雅停止所有受管实例（SIGINT → 3s → SIGKILL） |

## 架构设计

### 架构总览

```
当前 zai 进程 (supervisor + 管理 UI)
├── server/services/instanceSupervisor.ts   ← 中央管理服务
│     ├── 实例注册表（in-memory Map + 磁盘 ~/.zai/instances.json）
│     ├── 状态机：stopped → starting → running → stopping → down
│     ├── spawn / stop / restart 子实例
│     └── 心跳超时检测（IPC）
├── server/routes/instances.ts              ← REST API
└── Web UI /instances 页面
      │  spawn：zai start --managed-child --port <N>
      ▼         env 注入 ZAI_INSTANCE_ID / ZAI_SUPERVISOR_PID / ZAI_INSTANCE_HEARTBEAT_MS
子实例进程（完整 zai server）
├── server/services/instanceHeartbeat.ts    ← 心跳定时器（IPC process.send）
└── /api/health
```

### 实例定义与状态（shared 类型）

```ts
interface InstanceDefinition {          // 持久化到 ~/.zai/instances.json
  id: string;       // inst_xxx
  name: string;     // 显示名（唯一）
  cwd: string;      // 绝对路径
  createdAt: string;
}
interface InstanceStatus {              // 运行期状态，同样落盘
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'down';
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: { at: string; message: string } | null;
}
```

`instances.json` 同时持久化 definition + 当前状态。supervisor（当前 zai）重启后状态全部重置为 `stopped`，需手动启动。

### instanceSupervisor 服务（`server/services/instanceSupervisor.ts`）

- `createInstance({name, cwd})`：校验（名称唯一 / cwd 存在且为目录）→ 落盘 → 立即启动。
- `startInstance(id)`：端口分配用 `findAvailablePort`（9201 起向上扫描，跳过当前实例端口 `process.env.ZAI_PORT`）→ spawn `zai start --managed-child --port <N>`，env 注入 `ZAI_INSTANCE_ID` / `ZAI_SUPERVISOR_PID` / `ZAI_INSTANCE_HEARTBEAT_MS=5000` → 状态 `starting`。
- 子进程 IPC：`ready` 消息 → `running`；`heartbeat` 消息 → 更新 `lastHeartbeatAt`。
- **心跳超时检测**：每 5s 巡检 running 实例，`lastHeartbeatAt` 超过阈值（20s）→ kill 进程（若还活着）→ 标 `down` + 广播事件。
- `stopInstance(id)`：`child.kill('SIGINT')` → 等 exit（超时 10s `SIGKILL`）→ `stopped`。
- `restartInstance(id)` = stop 后 start。
- `removeInstance(id)`：running 先停止，然后删定义。
- **supervisor 退出**：遍历所有 child `SIGINT` → 3s → `SIGKILL`，再退出。
- 事件广播：每个状态变更 `eventBus.emit({type:'instance.changed', ...})`。

### instanceHeartbeat（子实例侧，`server/services/instanceHeartbeat.ts`）

- 在 `runDirectServer` 启动成功后检测 env：`ZAI_SUPERVISOR_PID` + `ZAI_INSTANCE_ID` 且 `process.send` 可用才激活。
- `setInterval` 每 5s 发 `{type:'heartbeat', instanceId, port, ts, pid}`。
- 父进程消失后 `process.send` 抛错 → try/catch 静默停止定时器，不崩溃。
- dev 模式 / 非受管启动不激活（env 缺失）。

### REST API（`routes/instances.ts`，挂 `/api/instances`）

- `GET /api/instances` —— 列表（definition + status 合并，含 `isCurrent` 标记）。
- `GET /api/instances/:id` —— 单个。
- `POST /api/instances` `{name, cwd}` —— 创建并启动。
- `POST /api/instances/:id/start` / `stop` / `restart`。
- `DELETE /api/instances/:id` —— running 先停止再删除。
- 当前实例（`isCurrent`）拒绝 stop/restart/delete，返回 4xx。

### SSE 事件

新增全局事件 `instance.changed`（含 instanceId/state/port/pid），登记进 `eventBus.ts` 的 `isGlobalEvent`，所有 tab 实时收到。

### 前端

- `Layout.tsx` 菜单新增 `{ key: '/instances', icon: <ClusterOutlined/>, label: '实例管理' }`。
- 新页面 `pages/Instances.tsx`：
  - 实例列表：名称、状态 Tag（颜色区分 running/stopped/down）、端口、cwd、pid、最后心跳时间（「N 秒前」）、启动时间。
  - 操作：启动 / 停止 / 重启 / 删除（Popconfirm 确认，停止/删除需确认）。
  - 「打开」按钮 → 新标签跳转 `http://localhost:<port>`。
  - 「新建实例」Modal：名称 + cwd（cwd 预填当前实例 cwd）。
  - 当前实例标记「当前」，所有操作禁用。
- 数据流：mount 时 `GET /api/instances` + `useEventStream` 订阅 `instance.changed` 增量更新。

## 数据流

1. **创建并启动**：`POST /api/instances {name, cwd}` → 校验 → 落盘 → `startInstance` 分配端口（跳过当前端口）→ spawn `zai start --managed-child` → 子实例 listen 后 `sendReady` → supervisor 收 `ready` → `running` → 广播 `instance.changed`。
2. **运行中心跳**：子实例每 5s `process.send({type:'heartbeat',...})` → supervisor 更新 `lastHeartbeatAt` → UI 显示「心跳 N 秒前」。
3. **停止**：`POST /api/instances/:id/stop` → `kill('SIGINT')` → 子实例走自身 cleanup（关 server + runtime）→ exit → `stopped`。
4. **崩溃**：`exit` 事件（非 stop 触发）→ 标 `down` + `lastError`；心跳超时 → 先 kill 占端口进程 → 标 `down`。
5. **UI 实时**：SSE `instance.changed` 推送所有状态变更。

## 状态机

```
        ┌──────────┐
        │  stopped  │◄──────────────┐
        └────┬─────┘               │
      start  │                     │ stop 完成 / 手动启动
             ▼                     │
        ┌──────────┐    ready IPC  ┌──────────┐
        │ starting │──────────────►│ running  │
        └────┬─────┘               └────┬─────┘
             │                          │ exit(非用户停)
        spawn 失败                      │ 心跳超时(20s)
             ▼                          ▼
        ┌──────────┐              ┌──────────┐
        │   down   │◄─────────────│  down    │
        └──────────┘              └──────────┘
             ▲ 手动「启动」
             └─────────────────────────
```

- `stopping` 是 stop/restart 期间的瞬时态，不单独落盘。
- 从 `running` 出发只有一条路到 `down`（exit 或心跳超时），UI 状态可预期。

## 错误处理

| 场景 | 行为 |
|---|---|
| cwd 不存在 / 不是目录 | `POST /api/instances` 返回 400，不落盘 |
| 名称重复 | 409 |
| 端口分配失败（100 个候选全占） | 实例标 `down` + `lastError`，广播事件 |
| spawn 失败（如 `dist/web` 未构建，子进程立即退出） | `starting` → 检测 exit → `down` + `lastError`，UI 显示错误 |
| 停止超时（10s 未 exit） | `SIGKILL` 兜底 → `stopped` |
| 心跳超时（20s） | kill 进程 → `down` + `lastError: "heartbeat timeout"` |
| supervisor 退出 | 遍历所有 child `SIGINT` → 3s → `SIGKILL`，再退出 |
| 心跳 IPC 父进程消失 | 子实例 `process.send` 抛错 → 静默停止定时器 |

## 边界情况

- **同一 cwd 多个实例**：允许。端口已隔离；会话共享 `~/.zai/transcripts` 按 cwd 隔离（复用现有 multi-pwd 机制）。
- **子实例间端口冲突**：spawn 时 `findAvailablePort` 实际 bind 探测，天然避开。
- **当前实例**：`isCurrent` 标记，UI 禁操作，API 层拒绝 stop/restart/delete。
- **心跳丢失但进程活着**：超时后 supervisor kill 进程，避免占端口。

## 测试设计

### 单元测试（`packages/zai/test/`，注入 fake child/deps，不真 spawn）

1. **instanceSupervisor.test.ts**
   - 创建/启动/停止/重启/删除的状态流转。
   - 端口分配：自动递增、跳过当前端口、全部占满报错。
   - 心跳超时：伪造心跳流 → 停超阈值 → 标 `down` + kill 调用。
   - 校验：名称重复 409、cwd 不存在 400、操作当前实例被拒。
   - 持久化：`instances.json` 读写、supervisor 重启后状态重置为 `stopped`。
   - 事件广播：每个状态变更发出 `instance.changed`。
2. **instanceHeartbeat.test.ts**
   - env 标记齐全才激活；缺 `ZAI_SUPERVISOR_PID` 不启动。
   - 心跳消息格式 `{type:'heartbeat', instanceId, port, ts, pid}`。
   - 父进程消失后 `process.send` 抛错 → 静默停止不崩溃。
3. **instances 路由测试**：CRUD + 校验 + 404/409。

### 前端测试（`Instances.tsx`）

- 列表渲染（状态 Tag 颜色、当前实例禁用）。
- 新建 Modal 校验（名称必填、cwd 必填）。
- 操作按钮触发对应 API 调用。

### 集成验收

1. 起当前实例 → 创建「demo」实例（cwd 选一个目录）→ 自动分配到不同端口。
2. 子实例日志出现 `[zai] Production server on http://localhost:<port>`。
3. 浏览器打开新端口 → 独立的 zai UI，会话列表独立。
4. UI 显示 running + 心跳时间戳在刷新。
5. 停止 → 状态 stopped → 端口释放（可再起）。
6. 手动 `kill -9` 子实例 pid → 状态变 down + lastError。
7. 当前实例显示「当前」，停止/重启按钮禁用。

### 真实浏览器验收（AGENTS.md 强制）

用 `/ego-browser` 启动 `zai dev`，走完：打开实例管理页 → 新建实例 → 新实例端口可访问 → 停止实例 → 重启实例 → 删除实例。

## 主要影响文件

| 操作 | 文件 |
|---|---|
| 新增 | `packages/zai/src/server/services/instanceSupervisor.ts` |
| 新增 | `packages/zai/src/server/services/instanceHeartbeat.ts` |
| 新增 | `packages/zai/src/server/routes/instances.ts` |
| 新增 | `packages/zai/src/web/src/pages/Instances.tsx` |
| 修改 | `packages/zai/src/server/index.ts`（挂路由 + 初始化 supervisor） |
| 修改 | `packages/zai/src/cli/start.ts`（runDirectServer 启动心跳） |
| 修改 | `packages/zai/src/shared/events.ts`（`instance.changed` 类型） |
| 修改 | `packages/zai/src/server/services/eventBus.ts`（isGlobalEvent 登记） |
| 修改 | `packages/zai/src/web/src/components/Layout.tsx`（菜单项） |
| 修改 | `packages/zai/src/web/src/store/useEventStream.ts`（处理 instance.changed） |
| 修改 | `packages/zai/src/web/src/router.tsx`（路由） |
