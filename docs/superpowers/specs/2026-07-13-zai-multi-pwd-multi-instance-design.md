# zai 多 PWD 与多实例设计

**日期：** 2026-07-13
**状态：** 已确认

## 背景

当前 `zai` 进程会继承启动时的工作目录，但多实例运行仍存在以下问题：

- `start`、`dev` 使用固定默认端口；第二个实例需要手动改端口。
- dev 模式的 Vite `/api` 代理固定指向 `localhost:7715`，可能把前端请求转发到另一个实例。
- 所有 transcript 共用 `~/.zai/transcripts`，会话列表没有按 cwd 过滤。
- Prompt 和新建会话接口允许前端传入任意 cwd，实例工作目录并不固定。
- 浏览器 Title 固定，多个实例标签页难以区分。

本设计将一个 `zai` 进程定义为一个绑定启动 cwd 的实例，通过动态端口隔离前后端连接，通过 cwd 隔离共享存储中的会话。

## 目标

1. 可从多个目录同时启动多个 `zai start` 或 `zai dev` 实例。
2. 默认端口冲突时自动选择后续可用端口。
3. dev 模式的每个 Vite 前端只代理到配套的 API 进程。
4. 实例工作目录在启动后不可变。
5. 会话列表仅加载当前实例 cwd 对应的 transcript。
6. 其他 cwd 的 session 不能通过直接 sessionId 被读取、删除或续聊。
7. 浏览器 Title 显示 `知鸟AI - <cwd 最后一级目录名>`。

## 非目标

- 不在单个实例内切换 cwd。
- 不提供中心实例注册表、实例选择器或中心网关。
- 不生成额外 instanceId；端口和进程天然区分实例。
- 不按实例拆分 `~/.zai`、资源、设置或 manifest。
- 不同步不同进程的 EventBus、AskRegistry 或运行状态。
- 同 cwd 多实例之间不实时同步会话事件。
- 不为同一 session 的跨进程并发编辑增加文件锁或冲突合并。
- 不顺带修复与本需求无关的旧 `/api/agent/stream` 测试。

## 核心决策

### 一实例一 PWD

CLI 启动时解析一次 `process.cwd()`，使用 `path.resolve` 得到规范化绝对路径，并派生最后一级目录名。该实例上下文通过 `AppOptions` 传入服务端，后续路由、runtime、MCP 配置和会话操作均使用这一固定 cwd。

前端不再决定实例 cwd，也不能通过请求体切换工作目录。

### 同源接口隔离

每个实例拥有独立 Web origin。浏览器继续请求相对地址 `/api` 和 `/api/event`：

- `start` 中，Express 的同一端口承载 SPA、API 和 SSE。
- `dev` 中，Vite 使用独立 Web 端口，并在启动时获得配套 API 的实际 origin；该实例的 `/api` 代理只指向这一 API 端口。

因此不需要绝对 API 地址注入、CORS、instanceId 请求头或实例化 API 路径。

### 会话共享存储、按 cwd 隔离

Transcript 继续存放在共享的 `~/.zai/transcripts`。同 cwd 的多个实例看到同一批会话，不同 cwd 的实例互不可见。

隔离在服务端执行，前端不接收全部会话后自行过滤。

## 架构设计

### 实例上下文

`AppOptions` 承载只读实例信息：

```ts
interface AppOptions {
  token: string;
  port?: number;
  cwd: string;
  cwdName: string;
}
```

本需求保留现有 `token`、`port` 契约，不改变认证语义；新增的 `cwd` 与 `cwdName` 必须被 `createApp` 实际消费，路由不再自行读取 `process.cwd()`。

`cwdName` 默认取 `path.basename(cwd)`；根目录导致 basename 为空时，回退为根路径本身。

### 动态端口

#### 默认端口

- `zai start` Web/API：从 `9888` 开始。
- `zai dev` Web：从 `9888` 开始。
- `zai dev` API：从 `7715` 开始。

未显式指定端口时，从默认端口开始向上扫描最多 100 个端口，选择第一个可用端口。dev 的 Web 与 API 端口必须不同。Express/API 端口应通过实际 `listen` 尝试完成选择，遇到 `EADDRINUSE` 后再试下一候选端口，避免“探测后释放、启动前被抢占”的竞态。

#### 显式端口

用户显式提供 `--port` 或 `--api-port` 时，该值为严格约束。若端口被占用，命令直接失败，不自动更换。

CLI 必须区分“用户显式指定”和“采用默认值”，避免 commander 的默认值掩盖这一语义。

#### dev 代理

API 端口确定并成功监听后，CLI 将实际 API origin 传给 Vite 子进程。`vite.config.ts` 从该启动配置生成 proxy target，不再固定为 `http://localhost:7715`。

Vite 使用 CLI 已选择的 Web 端口并启用严格端口行为，防止 Vite 自行换号后启动日志和打开地址失真。

#### 启动输出

每个实例输出：

- 实例 cwd；
- 最终 Web URL；
- dev 模式下的 API URL；
- 默认端口被占用时发生的自动调整。

自动打开浏览器时使用最终 Web URL。

### 服务端 cwd 边界

以下行为一律使用实例上下文的 cwd：

- 加载项目级 MCP 配置；
- runtime sandbox 工作目录；
- 加载 `AGENTS.md`；
- 创建 transcript；
- 执行 Prompt；
- 查询和校验会话。

`POST /api/agent/prompt` 与 `POST /api/agent/sessions` 不再使用客户端 `cwd`。前端移除对应请求字段；即使请求包含多余 cwd，服务端也不能用它覆盖实例上下文。

### 会话列表与访问控制

`TranscriptStore.list()` 增加 cwd 过滤能力。只有非空绝对路径形式的 `meta.cwd` 才参与匹配；对其执行 `path.resolve` 后，与实例 cwd 做精确比较。相对路径、空字符串和非字符串值均视为无效 cwd。

`GET /api/agent/sessions` 不增加 cwd 查询参数，直接返回当前实例可见的会话，并保持 `updatedAt` 降序。

以下 sessionId 操作也必须校验 transcript cwd：

- `GET /api/agent/sessions/:id`；
- `DELETE /api/agent/sessions/:id`；
- 使用已有 sessionId 的 `POST /api/agent/prompt`。

不属于当前 cwd 的 session 按不存在处理并返回 404，避免暴露其他目录的会话是否存在。Prompt 携带已有 sessionId 时，服务端必须在响应成功和启动 runtime 之前完成该校验。

缺失或包含无效 cwd 的历史 transcript 不出现在任何 cwd 的列表中，也不在本次改造中自动迁移或重写。

### 系统信息与前端状态

现有 `GET /api/system` 响应增加：

```json
{
  "cwd": "/absolute/project/path",
  "cwdName": "project"
}
```

前端启动时读取一次，保存为只读实例上下文。该上下文是页面中当前 cwd 的唯一来源；移除 Agent store 中可由前端修改、且当前没有有效调用方的 cwd 状态。

会话列表项类型保留 transcript 自带的 `cwd` 字段，供会话信息展示使用，但不用于客户端隔离决策。

### 浏览器 Title

HTML 默认 Title 改为：

```text
知鸟AI
```

系统信息加载成功后设置：

```text
知鸟AI - <cwdName>
```

完整 cwd 仍可在现有工作目录展示位置显示，不把 Title 截取规则扩散到业务组件中。

### 事件与同 cwd 多实例

每个进程继续使用自己的 EventBus、SSE 连接、AskRegistry 和 runtime。端口确保浏览器只连接当前实例。

同 cwd 的多个实例共享磁盘 transcript，但不共享事件：

- 新建、重命名或删除事件只实时更新发出事件的实例；
- 另一个实例在页面刷新后重新从磁盘加载最新列表；
- 不支持两个进程同时编辑同一 session 的一致性保证。

## 数据流

### 启动

1. CLI 解析并固定 cwd。
2. CLI 选择并绑定实际端口。
3. `start` 直接启动同源 Express；`dev` 将实际 API origin 传给 Vite。
4. CLI 输出并打开最终 Web URL。

### 页面初始化

1. 页面从自身 origin 请求 `GET /api/system`。
2. 前端保存 `{ cwd, cwdName }` 并更新浏览器 Title。
3. 前端请求 `GET /api/agent/sessions`。
4. 服务端只返回 transcript cwd 与实例 cwd 相同的会话。
5. 前端加载返回列表中的最新会话；列表为空时保持新会话状态。

### 新建与执行 Prompt

1. 前端发送不含 cwd 的新建会话或 Prompt 请求。
2. 服务端使用实例 cwd 创建 transcript、加载项目上下文并执行 runtime。
3. 当前进程的 SSE 将事件推送给当前 origin 下的页面。

## 异常处理

### 端口分配失败

- 默认端口扫描耗尽时退出，错误信息包含尝试范围。
- 显式端口被占用时立即退出并指出冲突端口。
- 不以静默随机端口作为兜底。

### dev 半启动

先确保 API 成功监听，再启动 Vite。Vite 启动失败时关闭 API server。SIGINT、SIGTERM 或任一子进程异常退出时清理本实例关联进程，不影响其他实例。

### 系统信息加载失败

页面保留默认 Title `知鸟AI`。会话隔离仍由服务端执行，不依赖前端成功取得 cwd。

### 会话越界

跨 cwd 的读取、删除和续聊统一返回 404。错误响应不包含目标 transcript 的 cwd 或其他元数据。

## 测试设计

### 单元测试

1. **端口选择**
   - 默认端口可用；
   - 连续端口占用后向上选择；
   - 100 个候选端口耗尽；
   - 显式端口冲突；
   - dev Web/API 端口不重复。
2. **TranscriptStore**
   - 仅返回规范化 cwd 相同的记录；
   - 排除其他 cwd、缺失 cwd 和无效 cwd；
   - 保持 `updatedAt` 排序。
3. **Agent 路由**
   - 会话列表按实例 cwd 过滤；
   - 新建会话和 Prompt 使用服务端 cwd；
   - 客户端 cwd 不能覆盖实例 cwd；
   - 跨 cwd 读取、删除、续聊返回 404。
4. **System 路由**
   - 返回正确的 `cwd` 和 `cwdName`；
   - 根目录名称回退正确。
5. **前端**
   - 系统信息成功后设置 `知鸟AI - <cwdName>`；
   - 加载失败时保留 `知鸟AI`；
   - 会话元数据中的完整 cwd 继续正确展示。
6. **Vite 配置**
   - proxy target 使用当前 dev 实例注入的 API origin；
   - 缺少启动配置时仅使用单实例开发默认值，不引用其他实例状态。

### 多实例集成验收

1. 在两个不同目录同时运行默认 `zai start`，得到不同 Web 端口。
2. 两个页面的 `/api/system` 分别返回各自 cwd，Title 分别显示对应目录名。
3. 两边只看到各自 cwd 的 transcript。
4. 任一实例不能用另一 cwd 的 sessionId 读取、删除或续聊。
5. 在同一 cwd 启动两个实例时端口不同，刷新后两边会话列表相同。
6. 同时运行两个 `zai dev`，每个 Vite `/api` 与 SSE 只连接配套 API。
7. 结束任一 dev 实例，不影响另一个实例，且不遗留该实例的 API 进程。

## 主要影响文件

- `packages/zai/src/cli/index.ts`
- `packages/zai/src/cli/start.ts`
- `packages/zai/src/cli/dev.ts`
- `packages/zai/vite.config.ts`
- `packages/zai/src/server/types.ts`
- `packages/zai/src/server/index.ts`
- `packages/zai/src/server/routes/system.ts`
- `packages/zai/src/server/routes/agent.ts`
- `packages/zai/src/server/services/agentRuntime.ts`
- `packages/zai-agent-core/src/transcript/store.ts`
- `packages/zai/src/web/src/store/useAppStore.ts`
- `packages/zai/src/web/src/store/useAgentStore.ts`
- `packages/zai/src/web/src/components/Layout.tsx`
- `packages/zai/src/web/src/hooks/useConversationInfo.ts`
- `packages/zai/src/web/src/pages/Agent.tsx`
- 对应 server、web 与 transcript 测试文件
