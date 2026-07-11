# @zn-ai/zai

知鸟AI 统一工具平台 — 本地 Web 管理界面。

## 功能特性

- **仪表盘** — 系统信息概览 + 快速启动向导
- **工具管理** — CLI 工具状态查看、安装/更新
- **资源浏览** — Skills/Commands/Extensions/Agents 资源库
- **登录管理** — PA 神兵/开放平台登录（通过系统终端）
- **配置编辑** — Nova/OpenCode/OpenCC settings.json 可视化编辑
- **目录查看** — 资源目录结构和计数

## 快速开始

### 开发模式

```bash
pnpm dev
```

启动 Vite 开发服务器（9888）+ Express API 服务器（7715），自动打开浏览器。

### 生产模式

```bash
pnpm build
pnpm start
```

构建前后端，启动生产服务器（9888），自动打开浏览器。

### 测试

```bash
pnpm test
```

运行测试套件（Vitest）。

## 技术栈

**后端**
- Node.js 20+
- Express 4
- TypeScript 5
- Zod（参数验证）

**前端**
- React 18 + TypeScript
- Vite 5
- Ant Design 5
- Tailwind CSS 3
- Zustand（状态管理）
- React Router 6

## 项目结构

```
packages/zai/
├── src/
│   ├── cli/              # CLI 命令（dev/start）
│   ├── server/           # Express API 服务器
│   │   ├── services/     # 业务逻辑（detect/spawner/fileStore/osascript）
│   │   └── routes/       # API 路由
│   ├── shared/           # 共享类型定义
│   └── web/              # React 前端
│       ├── components/   # UI 组件
│       ├── pages/        # 页面组件
│       ├── lib/          # 工具函数（api/sse）
│       └── store/        # 状态管理
├── test/                 # 测试文件
├── bin/                  # CLI 入口
├── dist/                 # 构建输出
│   ├── cli/              # 编译后的 CLI
│   ├── server/           # 编译后的服务器
│   ├── shared/           # 编译后的类型
│   └── web/              # 构建后的前端
└── index.html            # Vite 入口
```

## API 端点

### 公开端点（GET）

- `GET /api/health` — 健康检查
- `GET /api/system` — 系统信息
- `GET /api/cli` — CLI 工具状态
- `GET /api/dirs` — 目录信息

### 受保护端点（需要 `X-Zai-Token`）

- `POST /api/login/:type` — 登录（pa/op）
- `POST /api/install/:pkg` — 安装 CLI 工具（SSE 流）
- `PUT /api/config/:tool` — 保存配置
- `POST /api/exec` — 执行命令（SSE 流）

## 安全机制

1. **Token 认证** — 服务器启动时生成随机 token，写入控制台和 localStorage
2. **白名单验证** — 命令执行前检查允许的 CLI 工具列表
3. **原子写入** — 配置文件使用临时文件 + rename 避免损坏
4. **进程超时** — 命令执行 5 分钟超时，自动终止

## 依赖

- **@zn-ai/plugin** — 资源管理（list/install）
- **@zn-ai/agent-login** — 登录认证

## 开发

```bash
# 安装依赖
pnpm install

# 代码检查
pnpm typecheck

# 构建
pnpm build

# 测试
pnpm test
```

## License

MIT
