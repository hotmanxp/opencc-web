# zai 多 PWD 与多实例实施计划

> **给执行者：** 推荐使用 superpowers:subagent-driven-development（或 superpowers:executing-plans）逐任务实施。每步用 `- [ ]` 追踪。

**目标：** 让 `zai` 支持从多个目录同时启动多个实例，每个实例绑定独立端口、只展示当前 cwd 的会话，并在浏览器 Title 显示当前目录名。

**架构：** CLI 启动时解析一次 `process.cwd()` 形成不可变实例上下文；通过动态端口探测避免冲突；Express 通过 `app.locals.instanceContext` 向路由注入 cwd；`TranscriptStore.list()` 按 cwd 过滤；前端通过 `/api/system` 获取只读实例上下文并设置 Title。

**技术栈：** Node.js ≥20、Express 4、Vite 5、Zustand 4、TypeScript 5、Vitest 2。

## 全局约束

- 每个实例必须绑定独立端口；默认端口冲突时自动向上扫描最多 100 个端口。
- 显式指定端口时若冲突必须报错，不得自动更换。
- 实例 cwd 在启动后不可变；前端不能通过请求体覆盖。
- 会话隔离在服务端执行；前端不接收全部会话后自行过滤。
- `document.title` 格式为 `知鸟AI - <cwdName>`；系统信息加载失败时保留 `知鸟AI`。
- 不生成 instanceId；端口和进程天然区分实例。
- 不引入跨进程 EventBus、AskRegistry 或会话事件同步。

---

### Task 1：端口探测工具

**Files:**
- Create: `packages/zai/src/cli/ports.ts`
- Create: `packages/zai/test/cli/ports.test.ts`

**Interfaces:**
- Consumes: `net.createServer`（Node 标准库）
- Produces: `parsePort(value: string, field: string): number`、`listen(port: number): Promise<Server>`、`findAvailablePort(start: number, maxAttempts?: number): Promise<number>`

- [ ] **Step 1: 写端口解析测试**

```ts
// packages/zai/test/cli/ports.test.ts
import { describe, expect, it } from 'vitest'
import { parsePort } from '../../src/cli/ports.js'

describe('parsePort', () => {
  it('returns integer for valid port string', () => {
    expect(parsePort('8080', 'port')).toBe(8080)
  })
  it('throws for non-integer', () => {
    expect(() => parsePort('abc', 'port')).toThrow('port must be an integer')
  })
  it('throws for out-of-range port', () => {
    expect(() => parsePort('99999', 'port')).toThrow('port must be an integer')
    expect(() => parsePort('0', 'port')).toThrow('port must be an integer')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai && vitest run test/cli/ports.test.ts`
Expected: FAIL（模块未实现）

- [ ] **Step 3: 实现端口解析**

```ts
// packages/zai/src/cli/ports.ts
import type { Server } from 'node:http'
import { createServer } from 'node:net'

export function parsePort(value: string, field: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`)
  }
  return n
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zai && vitest run test/cli/ports.test.ts`
Expected: PASS

- [ ] **Step 5: 写 listen 和 findAvailablePort 测试**

```ts
// packages/zai/test/cli/ports.test.ts（追加）
import { listen, findAvailablePort } from '../../src/cli/ports.js'

describe('listen', () => {
  it('binds to available port and returns server', async () => {
    const server = await listen(0)
    expect(server.listening).toBe(true)
    server.close()
  })
  it('rejects on EADDRINUSE', async () => {
    const s1 = await listen(0)
    const addr = s1.address() as { port: number }
    await expect(listen(addr.port)).rejects.toThrow()
    s1.close()
  })
})

describe('findAvailablePort', () => {
  it('returns start port if available', async () => {
    const port = await findAvailablePort(49152)
    expect(port).toBe(49152)
  })
  it('scans upward when start is occupied', async () => {
    const s1 = await listen(49152)
    const port = await findAvailablePort(49152)
    expect(port).toBeGreaterThan(49152)
    s1.close()
  })
  it('throws after maxAttempts exhausted', async () => {
    const servers: any[] = []
    for (let i = 0; i < 5; i++) servers.push(await listen(49152 + i))
    await expect(findAvailablePort(49152, 5)).rejects.toThrow()
    servers.forEach((s) => s.close())
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd packages/zai && vitest run test/cli/ports.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 listen 和 findAvailablePort**

```ts
// packages/zai/src/cli/ports.ts（追加）
export function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

export async function findAvailablePort(start: number, maxAttempts = 100): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset
    try {
      const server = await listen(candidate)
      server.close()
      return candidate
    } catch {
      continue
    }
  }
  throw new Error(`No available port found in range [${start}, ${start + maxAttempts - 1}]`)
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd packages/zai && vitest run test/cli/ports.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/zai/src/cli/ports.ts packages/zai/test/cli/ports.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 添加端口探测工具"
```

---

### Task 2：启动命令端口探测

**Files:**
- Modify: `packages/zai/src/cli/index.ts`
- Modify: `packages/zai/src/cli/start.ts`
- Modify: `packages/zai/src/cli/dev.ts`
- Modify: `packages/zai/vite.config.ts`

**Interfaces:**
- Consumes: `parsePort`、`findAvailablePort`（Task 1）
- Produces: 更新后的 `runStart`、`runDev`

- [ ] **Step 1: 修改 CLI 注册以区分显式端口**

```ts
// packages/zai/src/cli/index.ts（28–34 行）
program
  .command('dev')
  .description('Development mode (Vite HMR + Express)')
  .option('--port <port>', 'Vite dev server port (default: 9888, auto-scan if occupied)')
  .option('--api-port <port>', 'Express API port (default: 7715, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .action(runDev);
```

```ts
// packages/zai/src/cli/index.ts（36–41 行）
program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port (default: 9888, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .action(runStart);
```

Commander 不再提供默认字符串；`options.port` 为 `undefined` 时由 `runDev` / `runStart` 自动探测。

- [ ] **Step 2: 实现 runStart 端口探测**

```ts
// packages/zai/src/cli/start.ts（替换 1–41 行）
import { existsSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createApp } from '../server/index.js'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { findAvailablePort, parsePort } from './ports.js'

interface StartOptions {
  port?: string
  open: boolean
}

export async function runStart(options: StartOptions) {
  const token = randomBytes(16).toString('hex')
  const cwd = resolve(process.cwd())
  const cwdName = basename(cwd) || cwd

  let port: number
  if (options.port) {
    port = parsePort(options.port, 'port')
  } else {
    port = await findAvailablePort(9888)
    if (port !== 9888) {
      console.log(`[zai] default port 9888 occupied, using ${port}`)
    }
  }

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const webDir = join(__dirname, '..', 'web')

  if (!existsSync(webDir)) {
    console.error(`[zai] dist/web not found. Run 'npm run build:web' first.`)
    process.exit(1)
  }

  console.log(`[zai] start token: ${token}`)
  console.log(`[zai] cwd: ${cwd}`)

  const app = createApp({ token, cwd, cwdName })
  app.use(express.static(webDir))

  app.get('*', (_req, res) => {
    res.sendFile(join(webDir, 'index.html'))
  })

  app.listen(port, () => {
    console.log(`[zai] Production server on http://localhost:${port}`)
    if (options.open) {
      spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' })
    }
  })
}
```

- [ ] **Step 3: 实现 runDev 端口探测**

```ts
// packages/zai/src/cli/dev.ts（替换 1–48 行）
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createApp } from '../server/index.js'
import { randomBytes } from 'node:crypto'
import { findAvailablePort, parsePort } from './ports.js'

interface DevOptions {
  port?: string
  apiPort?: string
  open: boolean
}

export async function runDev(options: DevOptions) {
  const token = randomBytes(16).toString('hex')
  const cwd = resolve(process.cwd())
  const cwdName = basename(cwd) || cwd

  let apiPort: number
  if (options.apiPort) {
    apiPort = parsePort(options.apiPort, 'api-port')
  } else {
    apiPort = await findAvailablePort(7715)
    if (apiPort !== 7715) {
      console.log(`[zai] default API port 7715 occupied, using ${apiPort}`)
    }
  }

  let vitePort: number
  if (options.port) {
    vitePort = parsePort(options.port, 'port')
  } else {
    vitePort = await findAvailablePort(9888)
    if (vitePort !== 9888) {
      console.log(`[zai] default Web port 9888 occupied, using ${vitePort}`)
    }
  }

  console.log(`[zai] dev token: ${token}`)
  console.log(`[zai] cwd: ${cwd}`)

  const app = createApp({ token, cwd, cwdName })
  const server = app.listen(apiPort, () => {
    console.log(`[zai] API server on http://localhost:${apiPort}`)
  })

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = resolve(__dirname, '..', '..')
  const vite = spawn('npx', ['vite', '--port', String(vitePort)], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZAI_API_ORIGIN: `http://localhost:${apiPort}`,
    },
  })

  if (options.open) {
    setTimeout(() => {
      spawn('open', [`http://localhost:${vitePort}`], { stdio: 'ignore' })
    }, 2000)
  }

  const cleanup = () => {
    vite.kill('SIGTERM')
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
```

- [ ] **Step 4: 修改 vite.config.ts 读取 API origin**

```ts
// packages/zai/vite.config.ts（替换 1–26 行）
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const projectRoot = process.cwd()
const apiOrigin = process.env.ZAI_API_ORIGIN || 'http://localhost:7715'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src', 'shared'),
    },
  },
  server: {
    port: Number.parseInt(process.env.VITE_PORT || '5173', 10),
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
})
```

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/index.ts packages/zai/src/cli/start.ts packages/zai/src/cli/dev.ts packages/zai/vite.config.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 启动命令支持动态端口探测"
```

---

### Task 3：实例上下文与系统信息

**Files:**
- Modify: `packages/zai/src/server/types.ts`
- Modify: `packages/zai/src/server/index.ts`
- Modify: `packages/zai/src/server/routes/system.ts`
- Create: `packages/zai/test/server/system.test.ts`

**Interfaces:**
- Consumes: `AppOptions`（新增 `cwd`、`cwdName`）
- Produces: `GET /api/system` 返回 `{ cwd, cwdName }`

- [ ] **Step 1: 扩展 AppOptions**

```ts
// packages/zai/src/server/types.ts（替换 1–3 行）
export interface AppOptions {
  token: string
  port?: number
  cwd: string
  cwdName: string
}
```

- [ ] **Step 2: 修改 createApp 注入实例上下文**

```ts
// packages/zai/src/server/index.ts（替换 22–25 行）
export function createApp(opts: AppOptions): express.Express {
  const app = express()
  app.locals.instanceContext = { cwd: opts.cwd, cwdName: opts.cwdName }
  initAgentRuntime(opts.cwd)
  // ...（其余不变）
```

- [ ] **Step 3: 写 system 路由测试**

```ts
// packages/zai/test/server/system.test.ts
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import systemRouter from '../../src/server/routes/system.js'

vi.mock('../../src/server/services/detect.js', () => ({
  getSystemInfo: async () => ({
    nodeVersion: 'v20.0.0',
    nodeMajor: 20,
    npmVersion: '10.0.0',
    npmPrefix: '/usr/local',
    npmRegistry: 'https://registry.npmjs.org/',
    npmBinInPath: true,
    platform: 'darwin',
  }),
}))

function startApp(cwd: string, cwdName: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = express()
    app.locals.instanceContext = { cwd, cwdName }
    app.use('/api', systemRouter)
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      })
    })
  })
}

describe('GET /api/system', () => {
  it('returns instance cwd and cwdName', async () => {
    const { url, close } = await startApp('/tmp/project', 'project')
    try {
      const res = await fetch(`${url}/api/system`)
      const data = await res.json()
      expect(data.cwd).toBe('/tmp/project')
      expect(data.cwdName).toBe('project')
    } finally {
      close()
    }
  })
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd packages/zai && vitest run test/server/system.test.ts`
Expected: FAIL

- [ ] **Step 5: 修改 system 路由返回实例上下文**

```ts
// packages/zai/src/server/routes/system.ts（替换 5–12 行）
router.get('/system', async (req, res) => {
  try {
    const info = await getSystemInfo()
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    res.json({ ...info, cwd: ctx.cwd, cwdName: ctx.cwdName })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/zai && vitest run test/server/system.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/server/types.ts packages/zai/src/server/index.ts packages/zai/src/server/routes/system.ts packages/zai/test/server/system.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 系统信息返回实例 cwd"
```

---

### Task 4：Agent Runtime 接收 cwd

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts`

**Interfaces:**
- Consumes: `opts.cwd`（Task 3）
- Produces: `initAgentRuntime(cwd: string)`

- [ ] **Step 1: 修改 initAgentRuntime 接收 cwd**

```ts
// packages/zai/src/server/services/agentRuntime.ts（替换 47–77 行）
export function initAgentRuntime(cwd: string): void {
  if (runtime) return
  const { resolved: dataDir } = resolveDataDir()
  transcriptStore = new TranscriptStore(dataDir)

  const mcpServers = loadMcpServers(cwd)
  const mcpClientPool = mcpServers.length > 0 ? new MCPClientPool() : undefined

  runtime = new DefaultAgentRuntime({
    dataDir,
    modelCaller: createAnthropicModelCaller(),
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    askRegistry,
    skillsDirs: resolveSkillsDirs(),
    ...(mcpClientPool && mcpServers.length > 0 ? { mcpClientPool, mcpServers } : {}),
    ...(resolveSandbox(cwd) ? { sandbox: resolveSandbox(cwd) } : {}),
  })

  if (mcpClientPool) {
    const cleanup = () => { mcpClientPool.disconnectAll() }
    process.once('SIGTERM', cleanup)
    process.once('SIGINT', cleanup)
  }
}
```

- [ ] **Step 2: 修改 resolveSandbox 接收 cwd**

```ts
// packages/zai/src/server/services/agentRuntime.ts（替换 34–45 行）
function resolveSandbox(cwd: string): import('@zn-ai/zai-agent-core').SandboxConfig | undefined {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  return {
    executor: 'child_process',
    workdir: cwd,
    ...(process.env.ZAI_SANDBOX_ENV_ALLOWLIST
      ? { envAllowlist: process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',') }
      : {}),
    maxCpuMs: Number.parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS ?? '600000', 10),
    networkEgress: 'allow',
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/server/services/agentRuntime.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 refactor(zai): agentRuntime 接收实例 cwd"
```

---

### Task 5：TranscriptStore 按 cwd 过滤

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/store.ts`
- Modify: `packages/zai-agent-core/test/transcript/store.test.ts`

**Interfaces:**
- Consumes: `TranscriptMeta.cwd`
- Produces: `list(cwd?: string): Promise<TranscriptMeta[]>`

- [ ] **Step 1: 写 list cwd 过滤测试**

```ts
// packages/zai-agent-core/test/transcript/store.test.ts（追加）
test('list with cwd filter returns only matching sessions', async () => {
  await store.create({ cwd: '/a', model: 'm1' })
  await store.create({ cwd: '/b', model: 'm2' })
  await store.create({ cwd: '/a', model: 'm3' })
  const list = await store.list('/a')
  expect(list).toHaveLength(2)
  expect(list.every((s) => s.cwd === '/a')).toBe(true)
})

test('list with cwd excludes invalid or missing cwd', async () => {
  await store.create({ cwd: '/a', model: 'm1' })
  // 手动写入无效 cwd
  const id = await store.create({ cwd: '', model: 'm2' })
  const list = await store.list('/a')
  expect(list).toHaveLength(1)
  expect(list[0].transcriptId).not.toBe(id)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai-agent-core && vitest run test/transcript/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 list cwd 过滤**

```ts
// packages/zai-agent-core/src/transcript/store.ts（追加顶部 import）
import path from 'node:path'

// packages/zai-agent-core/src/transcript/store.ts（替换 45–63 行）
async list(cwd?: string): Promise<TranscriptMeta[]> {
  const dir = transcriptDir(this.dataDir)
  try {
    const entries = await readdir(dir)
    const files = entries.filter((e) => e.endsWith('.json'))
    const metas: TranscriptMeta[] = []
    for (const file of files) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8')
        const tf = deserializeFile(raw)
        const meta = extractMeta(tf)
        if (cwd !== undefined) {
          const resolved = typeof meta.cwd === 'string' && meta.cwd ? path.resolve(meta.cwd) : null
          if (resolved !== path.resolve(cwd)) continue
        }
        metas.push(meta)
      } catch { /* skip corrupt files */ }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zai-agent-core && vitest run test/transcript/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/transcript/store.ts packages/zai-agent-core/test/transcript/store.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): TranscriptStore.list 支持 cwd 过滤"
```

---

### Task 6：Agent 路由使用实例 cwd

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`
- Modify: `packages/zai/test/server/agent.test.ts`

**Interfaces:**
- Consumes: `req.app.locals.instanceContext`（Task 3）
- Produces: `POST /api/agent/prompt`、`POST /api/agent/sessions` 使用服务端 cwd

- [ ] **Step 1: 写 agent 路由 cwd 测试**

```ts
// packages/zai/test/server/agent.test.ts（在现有 mock 变量声明区追加）
let lastCreateMeta: { cwd: string; model: string } | null = null

// packages/zai/test/server/agent.test.ts（修改 getTranscriptStore mock，约 34–53 行）
getTranscriptStore: () => ({
  list: async () => [],
  create: async (meta: { cwd: string; model: string }) => {
    lastCreateMeta = meta
    return 'sess-mock'
  },
  read: async () => ({
    version: 1,
    transcriptId: 'sess-1',
    meta: {
      cwd: '/tmp',
      model: 'unknown',
      createdAt: 0,
      updatedAt: 0,
      ...(mockTranscriptHasTitle ? { title: 'existing-title' } : {}),
    },
    messages: [],
  }),
  patch: async (id: string, patch: { title?: string; tags?: string[] }) => {
    patchCalls.push({ id, patch })
  },
  remove: async () => {},
  append: async () => {},
}),

// packages/zai/test/server/agent.test.ts（追加 describe 块）
describe('POST /api/agent/sessions with instance cwd', () => {
  it('uses server cwd instead of client cwd', async () => {
    lastCreateMeta = null
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/client-cwd' }),
      })
      expect(res.status).toBe(200)
      expect(lastCreateMeta).not.toBeNull()
      expect(lastCreateMeta!.cwd).toBe('/server-cwd')
    } finally {
      close()
    }
  })
})
```

（需要在 `startApp` 中设置 `app.locals.instanceContext = { cwd: '/server-cwd', cwdName: 'server-cwd' }`。现有 `agent.test.ts` 的 `getTranscriptStore` mock 没有 `create` 方法，需在 Task 6 Step 1 的 mock 修改中补充。）

- [ ] **Step 3.5: 写 Prompt 路由跨 cwd 校验测试**

```ts
// packages/zai/test/server/agent.test.ts（追加 describe 块）
describe('POST /api/agent/prompt with existing sessionId cross-cwd', () => {
  it('returns 404 when sessionId belongs to different cwd', async () => {
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'test',
          sessionId: 'sess-other-cwd',
        }),
      })
      expect(res.status).toBe(404)
    } finally {
      close()
    }
  })
})
```

（需要在 `getTranscriptStore` mock 的 `read` 方法中根据 sessionId 返回不同 cwd：`sess-other-cwd` 返回 `meta.cwd = '/other-cwd'`，其余返回 `/server-cwd`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai && vitest run test/server/agent.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 agent 路由使用实例 cwd**

```ts
// packages/zai/src/server/routes/agent.ts（追加顶部 import）
import path from 'node:path'

// packages/zai/src/server/routes/agent.ts（替换 227 行附近）
const { prompt, contentBlocks, sessionId: existingSessionId } = parsed.data
const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
const cwd = ctx.cwd

// Prompt 携带已有 sessionId 时，必须在响应成功和启动 runtime 之前完成 cwd 校验
if (existingSessionId) {
  try {
    const t = await getTranscriptStore().read(existingSessionId)
    const resolved = t.meta.cwd ? path.resolve(t.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
  } catch {
    return res.status(404).json({ error: 'Session not found' })
  }
}
```

```ts
// packages/zai/src/server/routes/agent.ts（替换 399 行附近）
router.post('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const cwd = ctx.cwd
    const store = getTranscriptStore()
    const sessionId = await store.create({ cwd, model: 'unknown' })
    res.json({ sessionId })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 4: 修改 list 路由按 cwd 过滤**

```ts
// packages/zai/src/server/routes/agent.ts（替换 384–392 行）
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const sessions = await store.list(ctx.cwd)
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 5: 添加 session 访问校验**

```ts
// packages/zai/src/server/routes/agent.ts（替换 409–417 行）
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
    const resolved = transcript.meta.cwd ? path.resolve(transcript.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    res.json({ transcript })
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})
```

```ts
// packages/zai/src/server/routes/agent.ts（替换 420–428 行）
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
    const resolved = transcript.meta.cwd ? path.resolve(transcript.meta.cwd) : null
    if (resolved !== path.resolve(ctx.cwd)) {
      return res.status(404).json({ error: 'Session not found' })
    }
    await store.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/zai && vitest run test/server/agent.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/server/routes/agent.ts packages/zai/test/server/agent.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): agent 路由使用实例 cwd 并隔离会话"
```

---

### Task 7：前端系统信息与 Title

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`
- Modify: `packages/zai/src/web/src/components/Layout.tsx`
- Modify: `packages/zai/src/web/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: `GET /api/system` 返回 `{ cwd, cwdName }`
- Produces: `useAppStore.instanceContext`、`document.title`

- [ ] **Step 1: 扩展 useAppStore**

```ts
// packages/zai/src/web/src/store/useAppStore.ts（替换 24–34 行）
interface AppState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  connected: boolean
  jobs: Record<string, JobInfo>
  toasts: ToastInfo[]
  instanceContext: { cwd: string; cwdName: string } | null
  setConnected: (v: boolean) => void
  setInstanceContext: (ctx: { cwd: string; cwdName: string }) => void
  applyJobEvent: (event: ServerEvent) => void
  applySystemEvent: (event: ServerEvent) => void
  dismissToast: (id: string) => void
}
```

```ts
// packages/zai/src/web/src/store/useAppStore.ts（替换 36–46 行）
export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: getInitialSidebarCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed
      localStorage.setItem('zai-sidebar-collapsed', String(next))
      return { sidebarCollapsed: next }
    }),
  connected: false,
  jobs: {},
  toasts: [],
  instanceContext: null,
  setConnected: (v) => set({ connected: v }),
  setInstanceContext: (ctx) => set({ instanceContext: ctx }),
  // ...（其余不变）
```

- [ ] **Step 2: 写 Layout Title 测试**

```ts
// packages/zai/src/web/src/store/useAppStore.test.ts（追加）
test('setInstanceContext stores cwd and cwdName', () => {
  useAppStore.getState().setInstanceContext({ cwd: '/tmp/proj', cwdName: 'proj' })
  expect(useAppStore.getState().instanceContext).toEqual({ cwd: '/tmp/proj', cwdName: 'proj' })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/zai && vitest run src/web/src/store/useAppStore.test.ts`
Expected: FAIL

- [ ] **Step 4: 修改 Layout 加载系统信息并设置 Title**

```ts
// packages/zai/src/web/src/components/Layout.tsx（替换 35–42 行）
const { sidebarCollapsed, toggleSidebar, instanceContext, setInstanceContext } = useAppStore()
const [version, setVersion] = useState<string>('…')

useEffect(() => {
  api
    .get<{ ok: boolean; version: string; cwd: string; cwdName: string }>('/system')
    .then((data) => {
      setVersion(data.version)
      setInstanceContext({ cwd: data.cwd, cwdName: data.cwdName })
      document.title = `知鸟AI - ${data.cwdName}`
    })
    .catch(() => {
      setVersion('unknown')
      document.title = '知鸟AI'
    })
}, [setInstanceContext])
```

- [ ] **Step 5: 修改 index.html 默认 Title**

```html
<!-- packages/zai/index.html（替换第 6 行） -->
<title>知鸟AI</title>
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd packages/zai && vitest run src/web/src/store/useAppStore.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/components/Layout.tsx packages/zai/src/web/src/store/useAppStore.test.ts packages/zai/index.html
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): 动态页面 Title 显示 cwdName"
```

---

### Task 8：前端移除 cwd 状态

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`
- Modify: `packages/zai/src/web/src/hooks/useConversationInfo.ts`

**Interfaces:**
- Consumes: `useAppStore.instanceContext`（Task 7）
- Produces: 移除 `useAgentStore.cwd`、`setCwd`

- [ ] **Step 1: 移除 useAgentStore.cwd**

```ts
// packages/zai/src/web/src/store/useAgentStore.ts（删除 58、83、109、121 行相关）
// 删除：cwd: string、setCwd: (cwd: string) => void、初始值 cwd: ''、setCwd 实现
```

- [ ] **Step 2: 修改 createNewSession 移除 cwd**

```ts
// packages/zai/src/web/src/store/useAgentStore.ts（替换 354–358 行）
const res = await fetch('/api/agent/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
  body: JSON.stringify({}),
})
```

- [ ] **Step 3: 修改 Agent.tsx 使用 instanceContext**

```ts
// packages/zai/src/web/src/pages/Agent.tsx（替换 809 行附近）
const { messages, status, sessions, sessionId, activeSessionId, stop, clearMessages, loadSessions, setCurrentSession, loadTranscript, createNewSession, deleteSession, pendingAsk, setAskAnswer, setAskNotes, submitAsk, rejectAsk } =
  useAgentStore()
const { instanceContext } = useAppStore()
const cwd = instanceContext?.cwd || '~'
```

- [ ] **Step 4: 修改 handleSend 移除 cwd**

```ts
// packages/zai/src/web/src/pages/Agent.tsx（替换 1056 行附近）
const { sessionId: returnedSessionId } = await api.post<{ sessionId: string }>('/agent/prompt', {
  prompt: text || undefined,
  contentBlocks: blocks.length > 0 ? blocks : undefined,
  sessionId: sessionId || activeSessionId || undefined,
})
```

- [ ] **Step 5: 修改 useConversationInfo 使用 instanceContext**

```ts
// packages/zai/src/web/src/hooks/useConversationInfo.ts（替换 72–73 行）
const { sessionId, activeSessionId, sessions, messages, status } =
  useAgentStore()
const { instanceContext } = useAppStore()
const cwd = instanceContext?.cwd || null
```

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/hooks/useConversationInfo.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 refactor(zai-web): 移除前端 cwd 状态，使用只读 instanceContext"
```

---

### Task 9：集成验收

- [ ] **Step 1: 在两个不同目录运行 `zai start`，验证端口自动分配**

```bash
cd /tmp/project-a && zai start &
cd /tmp/project-b && zai start &
# 验证两个进程分别监听不同端口，日志显示各自 cwd
```

- [ ] **Step 2: 验证系统信息返回正确 cwd**

```bash
curl http://localhost:9888/api/system | jq '.cwd, .cwdName'
curl http://localhost:9889/api/system | jq '.cwd, .cwdName'
```

- [ ] **Step 3: 验证会话列表按 cwd 隔离**

```bash
# 在 project-a 创建会话
curl -X POST http://localhost:9888/api/agent/sessions
# 在 project-b 查询列表，确认看不到 project-a 的会话
curl http://localhost:9889/api/agent/sessions
```

- [ ] **Step 4: 验证跨 cwd 访问返回 404**

```bash
# 用 project-a 的 sessionId 请求 project-b 的接口
curl http://localhost:9889/api/agent/sessions/<project-a-session-id>
# 预期返回 404
```

- [ ] **Step 5: 验证浏览器 Title**

打开两个标签页，确认分别显示 `知鸟AI - project-a` 和 `知鸟AI - project-b`。

- [ ] **Step 6: 验证 dev 模式**

```bash
cd /tmp/project-a && zai dev &
cd /tmp/project-b && zai dev &
# 验证每个 Vite 实例的 /api 代理只指向配套 API
```

- [ ] **Step 7: 提交集成验收报告（可选）**

```bash
git add docs/integration-test-report.md
git commit -m "HRMSV3-ZN-WEBSITE#668 test: 多实例集成验收报告"
```
