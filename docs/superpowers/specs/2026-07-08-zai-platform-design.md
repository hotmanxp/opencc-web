# ZAI Platform — 设计规格

> 本文档定义 `@zn-ai/zai` 的设计方案。基于 `scripts/zn-ai` bash 脚本的全功能 Web 复刻。

---

## 1. 总体架构

### 1.1 核心理念

zai 是一个轻量级本地 HTTP server，启动时执行 `zn-ai` 那些命令（npm install、npx、读 settings.json），把结果通过 REST + SSE 暴露给 React SPA。浏览器是 UI，Node 是引擎。

### 1.2 系统拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                     用户 macOS 桌面                          │
│                                                             │
│  ┌──────────────────────────────────────┐                   │
│  │   Chrome / Safari / Edge (SPA)       │ ← 用户交互         │
│  │   http://localhost:7715              │                   │
│  └──────────────┬───────────────────────┘                   │
│                 │ HTTP REST + EventSource (SSE)              │
│                 ▼                                           │
│  ┌──────────────────────────────────────┐                   │
│  │   zai (Node + Express)              │ ← 端口 7715        │
│  │   - /api/system       GET           │                   │
│  │   - /api/cli          GET           │                   │
│  │   - /api/dirs         GET           │                   │
│  │   - /api/install/:pkg POST (SSE)    │                   │
│  │   - /api/login/:type  POST (唤终端)  │                   │
│  │   - /api/config/:tool GET/PUT       │                   │
│  │   - /api/resources/:type GET        │                   │
│  └──────────────┬───────────────────────┘                   │
│                 │ spawn / readFile                          │
│                 ▼                                           │
│  ┌──────────────────────────────────────┐                   │
│  │   子进程                              │                   │
│  │   - npx @zn-ai/plugin@latest list   │                   │
│  │   - npx @zn-ai/plugin@latest install │                   │
│  │   - npm install -g @zn-ai/xxx       │                   │
│  │   - osascript -e 'tell app "Terminal"'                   │
│  └──────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键决策汇总

| 维度 | 选择 |
|------|------|
| 运行形态 | 浏览器模式（A） |
| MVP 范围 | 全量复刻 zn-ai（丙） |
| 登录方式 | 唤起系统终端（C） |
| CLI 集成 | 直接 `npx` 调用（A） |
| 后端 | Express + SSE |
| 前端 | React 18 + Vite + TypeScript + Tailwind + Antd v5 + React Router v6 + Zustand |
| 端口 | 7715（高且独特）+ `--port` flag 覆盖 |
| 自动打开 | 默认开 + `--no-open` flag |
| CLI | `zai dev` / `zai start`，bin 名 `zai`，包名 `@zn-ai/zai` |
| 目录结构 | 单包 `packages/zai/` 内 `src/server/` + `src/web/` |

---

## 2. 目录结构与构建产物

### 2.1 文件布局

```
packages/zai/
├── package.json                 # @zn-ai/zai, bin: { zai: "bin/zai.js" }
├── bin/
│   └── zai.js                   # 入口：解析参数 → 调 src/cli/index.ts
├── src/
│   ├── cli/                     # CLI 命令分发
│   │   ├── index.ts             # commander 实例，分 dev/start 子命令
│   │   ├── dev.ts               # 开发模式：并行启 Vite dev server + Express（proxy /api）
│   │   └── start.ts             # 生产模式：单进程 Express 同时服务 SPA + API
│   ├── server/                  # 后端
│   │   ├── index.ts             # createApp(opts) → Express 实例
│   │   ├── routes/
│   │   │   ├── system.ts        # GET /api/system
│   │   │   ├── cli.ts           # GET /api/cli, POST /api/install/:pkg
│   │   │   ├── dirs.ts          # GET /api/dirs
│   │   │   ├── login.ts         # POST /api/login/:type
│   │   │   ├── config.ts        # GET/PUT /api/config/:tool
│   │   │   ├── resources.ts     # GET /api/resources/:type, POST /api/install-resource
│   │   │   └── stream.ts        # SSE 工具：createSseStream(res)
│   │   ├── services/
│   │   │   ├── spawner.ts       # spawn 子进程并产生 line stream
│   │   │   ├── osascript.ts     # macOS 唤起 Terminal.app
│   │   │   ├── fileStore.ts     # 读/写 ~/.nova/settings.json 等
│   │   │   └── detect.ts        # Node 版本 / npm registry / PATH 检测
│   │   └── types.ts
│   ├── web/                     # 前端（Vite + React）
│   │   ├── index.html
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.js
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx          # 路由壳
│   │   │   ├── router.tsx       # React Router v6 路由表
│   │   │   ├── store/
│   │   │   │   └── useAppStore.ts  # Zustand：activeKey / theme
│   │   │   ├── components/
│   │   │   │   ├── Layout.tsx       # antd Layout + 侧边栏 + 顶栏
│   │   │   │   ├── LogPanel.tsx     # SSE 日志展示（虚拟列表）
│   │   │   │   ├── StatusDot.tsx    # 绿/红/灰 圆点
│   │   │   │   └── ConfirmButton.tsx
│   │   │   ├── pages/
│   │   │   │   ├── Dashboard.tsx    # /  系统信息 + 快速启动
│   │   │   │   ├── Tools.tsx        # /tools  CLI 状态 + 安装/更新
│   │   │   │   ├── Resources.tsx    # /resources  浏览+安装 skills/cmds/plugins/agents
│   │   │   │   ├── Login.tsx        # /login  PA / OpenPlatform / OpenPlatform-stg
│   │   │   │   ├── Config.tsx       # /config  Nova/OpenCode/OpenCC settings.json
│   │   │   │   └── Directory.tsx    # /dirs  ~/.nova 等目录内容
│   │   │   └── lib/
│   │   │       ├── api.ts           # fetch 封装
│   │   │       └── sse.ts           # EventSource 封装 + 自动重连
│   │   └── tsconfig.json
│   └── shared/                  # 后端 + 前端共享类型
│       └── types.ts             # SystemInfo / CliStatus / ResourceItem / ConfigFile
├── test/                        # vitest
│   ├── server/
│   │   ├── detect.test.ts
│   │   ├── fileStore.test.ts
│   │   └── spawner.test.ts
│   └── web/                     # vitest + @testing-library/react
│       └── components/
├── tsconfig.json                # 根 tsconfig，references 子项目
├── vite.config.ts               # 单点 Vite 配置（root: src/web，dev proxy /api → :7715）
├── tailwind.config.ts
├── postcss.config.js
└── README.md
```

### 2.2 关键约定

1. **`src/server/` 用 tsx 在 dev 跑**（`tsx watch src/server/index.ts`），prod build 用 `tsc -b` 输出 `dist/server/`
2. **`src/web/` 完全独立 Vite 工程**，dev 时 Vite 起 5173，proxy `/api` 到 Express 7715；prod build 输出 `dist/web/`，由 Express `express.static('dist/web')` 服务
3. **`src/shared/types.ts` 是单一真相源**，前端 import via path alias `@shared/*`，后端用相对路径或编译时合并
4. **bin 入口 `bin/zai.js`** 是纯 esm shim：`#!/usr/bin/env node` + `import('../dist/cli/index.js')`；开发时直接跑 `tsx src/cli/index.ts dev` 绕过 bin

### 2.3 启动流程

**`zai dev`**：
```
1. spawn("vite", ["--port", "5173"], cwd: src/web/)    // 前台输出 tee 到日志
2. spawn("tsx", ["watch", "src/server/index.ts"], ...) // 起 Express 7715
3. 等 7715 健康 → spawn("open", ["http://localhost:5173"]) // macOS 自动开浏览器
4. 父进程 SIGINT → 杀两个子进程退出
```

**`zai start`**：
```
1. 校验 dist/server + dist/web 存在（否则提示先 npm run build）
2. node dist/server/index.js 监听 7715
3. spawn("open", ["http://localhost:7715"])
4. SIGINT → 优雅退出
```

---

## 3. API 表面（Express + SSE）

### 3.1 接口列表

所有 API 前缀 `/api`。流式接口用 `text/event-stream`，每条消息格式 `data: <json>\n\n`。

| 方法 | 路径 | 输入 | 输出 | 说明 |
|------|------|------|------|------|
| GET | `/api/health` | — | `{ok:true,version}` | 健康检查 |
| GET | `/api/system` | — | `SystemInfo` | Node 版本 / npm registry / npm prefix / PATH 中是否含 npm bin |
| GET | `/api/cli` | — | `CliStatus[]` | nova / opencode / opencc / agent-login 是否安装及路径 |
| GET | `/api/dirs` | — | `DirectoryStatus` | `~/.nova` `~/.config/opencode` `~/.claude` `~/.agents/skills` 下 agents/commands/skills/extensions 文件树 |
| GET | `/api/resources/:type` | type ∈ skills/commands/extensions/agents | `ResourceItem[]` | spawn `npx @zn-ai/plugin@latest list <type>` 解析 stdout |
| POST | `/api/install/cli` | `{pkg:'@zn-ai/nova'}` | **SSE** | spawn `npm install -g <pkg>` 流式回显 |
| POST | `/api/install/resource` | `{type, name}` | **SSE** | spawn `npx @zn-ai/plugin@latest install <type> <name>` |
| POST | `/api/login/:type` | type ∈ pa/op/op-stg | `{ok,pid}` | spawn Terminal.app 跑 `npx @zn-ai/agent-login@latest <type>` |
| GET | `/api/config/:tool` | tool ∈ nova/opencode/opencc | `ConfigFile` | 读 `~/.nova/settings.json` 等；不存在时返回默认内容 + `missing:true` |
| PUT | `/api/config/:tool` | `ConfigFile` | `{ok}` | 原子写回（先写 .tmp 再 rename），保留原文件 mode |
| POST | `/api/quickstart` | — | **SSE** | 串行执行：检测缺失工具 → 安装 → 设置 registry → 报告 |

### 3.2 SSE 事件 schema

所有流式接口统一：

```ts
type SseEvent =
  | { type: 'start'; command: string }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string }
```

### 3.3 安全约束

- 所有写操作（install / config PUT / quickstart）要求请求头 `X-Zai-Token`，值等于 `zai` 启动时随机生成并打到 stdout 第一行的 token。浏览器同源请求自动带 `fetch` credentials：include + cookie。这样防止 LAN 上其他人误触发安装
- `pkg` / `name` / `type` 字段用 zod 校验白名单，禁止路径注入

---

## 4. 前端路由与页面

### 4.1 路由表

```
/                Dashboard  系统信息卡 + 快速启动按钮
/tools           Tools      CLI 工具状态表 + 安装/更新按钮
/resources       Resources  tabs：skills / commands / plugins / agents
/login           Login      PA / OpenPlatform / OpenPlatform(stg) 三个按钮
/config          Config     tabs：Nova / OpenCode / OpenCC settings.json 编辑器
/dirs            Directory  四个目录的文件树 + 计数
```

### 4.2 Layout

antd `Layout` + Tailwind：
- 顶栏：logo「知鸟AI 平台」+ 当前 Node 版本 + 主题切换
- 侧边栏：6 个菜单项（icon + label），折叠态记忆到 zustand + localStorage
- 主区：根据路由渲染页面，最大宽 1280px
- 全局 `LogPanel`（Drawer）：点击任何"运行中"任务时从右侧滑出，显示该任务的 SSE 日志流，支持"取消"按钮（发 DELETE 终止子进程）

### 4.3 Dashboard 卡片

首屏价值最高：
- 4 个状态卡：Node / npm registry / 4 个 CLI 安装状态聚合
- "快速启动"按钮：POST /api/quickstart，弹出 LogPanel 显示全过程
- "登录状态"卡：检测 `~/.nova/credentials.json` 存在性 + 读取文件 mtime 计算距上次登录天数

### 4.4 Config 编辑器

- 加载后展示 JSON：左边 antd `Form` 表单（按已知字段渲染 input），右边只读 JSON 预览
- 表单按 `保存` 时序列化为 JSON PUT
- 未知字段保留（不做 schema 严格校验），避免覆盖用户在 settings.json 自定义的 env

---

## 5. CLI 命令与运行生命周期

### 5.1 命令

```bash
zai dev [--port 5173] [--api-port 7715] [--no-open]
zai start [--port 7715] [--no-open]
zai --version
zai --help
```

### 5.2 进程模型

**`zai dev`**：
```
zai (parent)
 ├─ vite (cwd: src/web, port 5173)
 └─ tsx watch src/server/index.ts (port 7715)
```
父进程转發 SIGINT 给两个子进程；任一崩溃则全部清理。

**`zai start`**：单 Express 进程，监听 7715，`app.use(express.static('dist/web'))`。

### 5.3 SPA fallback

所有非 `/api/*` 的 GET 请求 fallback 到 `dist/web/index.html`，由 React Router 处理。

### 5.4 日志

所有 stdout/stderr 同时输出到终端（颜色化）和 `~/.cache/zai/logs/<yyyy-mm-dd>.log`。

---

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 端口被占 | 报错 + 打印占用进程 PID（`lsof -nP -iTCP:<port> -sTCP:LISTEN`） |
| Node < 20 | 启动时直接退出 + 提示升级 |
| `npx` 拉包失败（无网/registry 不通） | SSE `error` 事件，前端 LogPanel 红字 |
| 用户在编辑 settings.json 时另一个实例也在写 | 文件锁 `~/.nova/.zai.lock`（proper-lockfile）+ 409 响应 |
| 子进程超时（默认 5 分钟） | spawner 主动 SIGTERM + 10 秒后 SIGKILL |
| 用户关闭浏览器 | 不影响 zai 进程（除非 zai 是 `--once` 模式，V1 不实现） |

---

## 7. 测试策略

- **后端 vitest**：spawner / fileStore / detect 三个 service 单测覆盖；routes 用 supertest 集成测
- **前端 vitest + RTL**：components 渲染 + LogPanel SSE mock
- **E2E（V2）**：暂不在 V1 范围
- **覆盖率门槛**：server ≥ 80%，web ≥ 60%（前端主要靠手动验证 UI）

---

## 附录 A：依赖清单（V1）

### 后端

```
express@4
commander@12
zod@3
proper-lockfile@4
open@10 (仅 dev 用，可选)
```

### 前端

```
react@18
react-dom@18
react-router-dom@6
antd@5
zustand@4
tailwindcss@3
postcss@8
vite@5
@types/react@18
@types/react-dom@18
```

### 开发依赖

```
typescript@5
tsx@4
ts-node@10
vitest@2
@testing-library/react@15
@testing-library/jest-dom@6
```
