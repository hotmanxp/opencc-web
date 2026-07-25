# zai Agent LAN Share — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai 用户通过 `zai --lan` 启动后,在 Agent 页面工具栏点"分享"按钮,弹出 IP 列表,点选即复制 `http://<ip>:<port>/agent?sid=<sid>` 给 LAN 同事访问。

**Architecture:** 三层变更:
1. CLI 增加 `--lan` flag → 把 `createApp({host})` 传给 server;server 端 `listen(host)` 决定 bind 地址
2. Server 探测 LAN IP 列表(`os.networkInterfaces()`),扩展 `/api/system` 返回 `host/port/ips`,并把这些字段注入 `instanceContext`
3. Web 端 `Layout` hydrate 把新字段写进 `useAppStore.instanceContext`;`AgentInputBox` 工具栏加 `ShareAltOutlined` 按钮 + 受控 `Popover` 渲染 `SharePopover` 组件,每行提供 clipboard 复制

**Tech Stack:** TypeScript 5, Node 20+, Express 4, commander 12, React 18, AntD 5, zustand 4, vitest 4 + supertest + @testing-library/react

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-25-zai-agent-share-design.md`
- **Node:** `>=20` (per `package.json:34`)
- **No new deps:** QR 码已与用户确认不引入,实现纯 URL + clipboard
- **Test runner:** `npm test` (vitest run) 在 `packages/zai/` 工作目录下跑
- **Typecheck:** `npm run typecheck`
- **Lint baseline:** 现有 PASS 状态必须保持(具体 case 由 `npm test` 验证)
- **Test mock pattern:** server route 测试用 supertest + 局部 mock `getSystemInfo`(已有 precedent at `test/server/system.test.ts:5-15`)
- **Web test mock pattern:** `vi.mock` + `vi.stubGlobal("fetch", ...)`(precedent at `AgentInputBox.test.tsx:17-39`)
- **Default listen host:** 保持 `127.0.0.1`,只有显式 `--lan` 才改 `0.0.0.0`(用户决定的安全默认)
- **IP 探测范围:** `os.networkInterfaces()` 全部非 internal IPv4,排重后全列表返回;前端让用户挑
- **URL 格式:** `http://<ip>:<port>/agent?sid=<sid>`,与现有 `useAgentStore.writeUrlSid` 兼容

---

## File Structure

### 新建
- `packages/zai/src/server/utils/lanIps.ts` — `detectLanIps()` 纯函数,~25 行
- `packages/zai/src/web/src/components/SharePopover.tsx` — 弹层组件,~80 行
- `packages/zai/test/server/lanIps.test.ts` — detectLanIps 单元测试
- `packages/zai/test/server/system-route-extra.test.ts` — `/api/system` 扩展字段测试
- `packages/zai/test/web/SharePopover.test.tsx` — SharePopover 单元测试

### 修改
- `packages/zai/src/cli/start.ts` — 接收 `--lan`,传 host 给 createApp + listen
- `packages/zai/src/cli/ports.ts` — `listen(port, host?)` 接受 host 参数
- `packages/zai/src/server/types.ts` — `AppOptions.host?: string`
- `packages/zai/src/server/index.ts` — 注入 `host` 到 `app.locals.instanceContext`
- `packages/zai/src/server/routes/system.ts` — 返回 `host/port/ips`
- `packages/zai/src/web/src/store/useAppStore.ts` — `instanceContext` 类型扩展
- `packages/zai/src/web/src/components/Layout.tsx` — hydrate 传新字段
- `packages/zai/src/web/src/components/AgentInputBox.tsx` — 加 Share 按钮 + Popover

### 不动
- `packages/zai/src/cli/index.ts` — commander 已自动透传 flag(无需改)
- `packages/zai/src/cli/dev.ts` — dev 模式本期不动(`--lan` 只对 production start,降低 PR 风险);后续阶段再加
- `packages/zai/src/web/src/pages/Agent.tsx` — `useAgentStore` 已处理 `?sid=` 路由,无需改

---

## Task 1: `detectLanIps()` server 端 LAN IP 探测工具

**Files:**
- Create: `packages/zai/src/server/utils/lanIps.ts`
- Test: `packages/zai/test/server/lanIps.test.ts`

**Interfaces:**
- Produces: `export function detectLanIps(): string[]` — 返回 IPv4 地址数组,过滤掉 `internal` 和 IPv6,排重

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/test/server/lanIps.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { detectLanIps } from '../../src/server/utils/lanIps.js';

describe('detectLanIps', () => {
  it('excludes loopback (127.0.0.1) and internal IPv6', () => {
    const ips = detectLanIps();
    expect(ips).not.toContain('127.0.0.1');
    // 不应含 IPv6 格式(无冒号)
    for (const ip of ips) {
      expect(ip).not.toContain(':');
    }
  });

  it('returns an array of IPv4 strings only', () => {
    const ips = detectLanIps();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it('dedupes duplicate addresses from multiple interfaces', async () => {
    const os = await import('node:os');
    vi.spyOn(os, 'networkInterfaces').mockReturnValueOnce({
      eth0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as any,
      ],
      wlan0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as any,
      ],
    });
    const ips = detectLanIps();
    const dup = ips.filter((x) => x === '192.168.1.5');
    expect(dup.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai && npx vitest run test/server/lanIps.test.ts`
Expected: FAIL — `lanIps.ts` 文件不存在

- [ ] **Step 3: 实现 `detectLanIps()`**

新建 `packages/zai/src/server/utils/lanIps.ts`:

```ts
import { networkInterfaces } from 'node:os';

/**
 * 探测本机非 internal 的 IPv4 地址,排重返回。
 * 用途:zai --lan 启动后,在 /api/system 里返回候选 LAN 地址,
 *      前端分享弹层列出,用户挑选复制。
 *
 * 设计:
 * - os.networkInterfaces() 在大多数 OS 上返回 Map<name, NIC[]>
 * - 过滤掉 internal=true 的(loopback 127.0.0.1, ::1)
 * - 只保留 family === 'IPv4' (TypeScript 这里 family 是字符串而非枚举)
 * - 用 Set 去重(某些 OS 同名 interface 多个 v4 address)
 */
export function detectLanIps(): string[] {
  const seen = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const nic of list) {
      if (nic.internal) continue;
      if (nic.family !== 'IPv4') continue;
      seen.add(nic.address);
    }
  }
  return [...seen];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zai && npx vitest run test/server/lanIps.test.ts`
Expected: PASS — 3 cases pass

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/utils/lanIps.ts packages/zai/test/server/lanIps.test.ts
git commit -m "feat(zai): detectLanIps server util for LAN share"
```

---

## Task 2: `AppOptions` 加 `host` 字段 + `createApp` 注入

**Files:**
- Modify: `packages/zai/src/server/types.ts:1-7`
- Modify: `packages/zai/src/server/index.ts:43`

**Interfaces:**
- Consumes: `opts.host?: string` (from CLI)
- Produces: `app.locals.instanceContext.host: string` (downstream 路由可读)

- [ ] **Step 1: 修改 `AppOptions` 类型**

Edit `packages/zai/src/server/types.ts`:

```ts
export interface AppOptions {
  token: string;
  port?: number;
  cwd: string;
  cwdName: string;
  host?: string;   // server bind host, 默认 '127.0.0.1', --lan 时 '0.0.0.0'
}
```

- [ ] **Step 2: 修改 `createApp` 注入 host**

Edit `packages/zai/src/server/index.ts:43`:

```ts
  app.locals.instanceContext = {
    cwd: opts.cwd,
    cwdName: opts.cwdName,
    host: opts.host ?? '127.0.0.1',
  };
```

- [ ] **Step 3: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS — types match

- [ ] **Step 4: 跑现有 server 测试套**

Run: `cd packages/zai && npx vitest run test/server/`
Expected: PASS — 现有 case 不变(instanceContext 扩展字段向后兼容)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/types.ts packages/zai/src/server/index.ts
git commit -m "feat(zai): createApp accepts host for LAN share"
```

---

## Task 3: `cli/ports.ts` `listen()` 接受 host 参数

**Files:**
- Modify: `packages/zai/src/cli/ports.ts:11-20`

**Interfaces:**
- Consumes: `port: number, host?: string` (default `'127.0.0.1'`)
- Produces: 现有签名扩展,向后兼容(默认 host 不变,测试不破)

- [ ] **Step 1: 修改 `listen()`**

Edit `packages/zai/src/cli/ports.ts:11-20`:

```ts
export function listen(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
```

- [ ] **Step 2: 跑现有 ports 测试**

Run: `cd packages/zai && npx vitest run test/cli/ports.test.ts`
Expected: PASS — 默认 host 不变,3 个 case 都过

- [ ] **Step 3: 新增测试覆盖 `--lan` 路径**

Edit `packages/zai/test/cli/ports.test.ts:22`,在 describe('listen') 内追加:

```ts
  it('binds to specified host (0.0.0.0 for --lan)', async () => {
    const server = await listen(0, '0.0.0.0');
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe('0.0.0.0');
    expect(addr.port).toBeGreaterThan(0);
    server.close();
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && npx vitest run test/cli/ports.test.ts`
Expected: PASS — 4 个 case(原 3 + 新 1)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/cli/ports.ts packages/zai/test/cli/ports.test.ts
git commit -m "feat(zai): cli/ports.listen accepts host parameter"
```

---

## Task 4: `cli/start.ts` 加 `--lan` flag

**Files:**
- Modify: `packages/zai/src/cli/start.ts:11-90`

**Interfaces:**
- Consumes: `options.lan?: boolean` (from commander)
- Produces: server.listen(port, host) 用对应 host,createApp({...host}) 透传

- [ ] **Step 1: 修改 `StartOptions` 接口和 listen 调用**

Edit `packages/zai/src/cli/start.ts`:

修改 `StartOptions`(line 11-14):

```ts
interface StartOptions {
  port?: string;
  open: boolean;
  lan?: boolean;
}
```

修改 `runStart` 函数 — 在 `createApp` 调用处(line 24)改为:

```ts
  const host = options.lan ? '0.0.0.0' : '127.0.0.1';
  const app = createApp({ token, cwd, cwdName, host });
```

修改 `server.listen` 调用(line 58):

```ts
        server!.listen(port, host, () => resolve());
```

修改生产环境日志(line 75) — LAN 模式下打印 LAN 地址:

```ts
  if (options.lan) {
    const { detectLanIps } = await import('../server/utils/lanIps.js');
    const ips = detectLanIps();
    console.log(`[zai] Production server on http://localhost:${port}`);
    console.log(`[zai] LAN mode — listening on 0.0.0.0:${port}`);
    for (const ip of ips) {
      console.log(`[zai]   → http://${ip}:${port}`);
    }
  } else {
    console.log(`[zai] Production server on http://localhost:${port}`);
  }
```

- [ ] **Step 2: 修改 `cli/index.ts` commander start 子命令**

Edit `packages/zai/src/cli/index.ts:36-41`:

```ts
program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port (default: 9888, auto-scan if occupied)')
  .option('--no-open', 'Do not auto-open browser')
  .option('--lan', 'Bind to 0.0.0.0 to allow LAN clients to access')
  .action(runStart);
```

- [ ] **Step 3: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 手动 smoke test**

Run: `cd packages/zai && timeout 3 node dist/cli/index.js start --lan 2>&1 | head -20`
Expected: 输出包含 "LAN mode" 和至少一个 `→ http://<ip>:9888` 行

(如果没 build,先 `npm run build` 再测)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/cli/start.ts packages/zai/src/cli/index.ts
git commit -m "feat(zai): --lan flag binds server to 0.0.0.0"
```

---

## Task 5: `routes/system.ts` 返回 `host/port/ips`

**Files:**
- Modify: `packages/zai/src/server/routes/system.ts:60-69`

**Interfaces:**
- Consumes: `app.locals.instanceContext.host`
- Produces: response JSON 加 `host: string, port: number, ips: string[]`

- [ ] **Step 1: 修改 GET /api/system handler**

Edit `packages/zai/src/server/routes/system.ts:60-69`:

```ts
router.get('/system', async (req, res) => {
  try {
    const info = await getSystemInfo();
    const ctx = req.app.locals.instanceContext as {
      cwd: string;
      cwdName: string;
      host: string;
    };
    const branch = await getGitBranch(ctx.cwd);
    const { detectLanIps } = await import('../utils/lanIps.js');
    const ips = detectLanIps();
    res.json({
      ...info,
      cwd: ctx.cwd,
      cwdName: ctx.cwdName,
      branch,
      host: ctx.host,
      port: Number(process.env.ZAI_PORT ?? '') || 0,
      ips,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

注:port 用 env 透传是因为 express `req.app.locals` 不存 port,且 start.ts 把 port 透传给 listen 但不存进 app.locals。我们把 port 写入 `process.env.ZAI_PORT`(在 start.ts 里)— 见 Task 6 补充。

- [ ] **Step 2: 写失败测试**

新建 `packages/zai/test/server/system-route-extra.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import systemRouter from '../../src/server/routes/system.js';

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
}));

function makeApp(cwd: string, cwdName: string, host = '127.0.0.1'): express.Express {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName, host };
  app.use('/api', systemRouter);
  return app;
}

describe('GET /api/system — LAN share fields', () => {
  it('returns host field from instanceContext', async () => {
    process.env.ZAI_PORT = '9123';
    const res = await request(makeApp('/tmp/project', 'project', '0.0.0.0'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('0.0.0.0');
    expect(res.body.port).toBe(9123);
    expect(Array.isArray(res.body.ips)).toBe(true);
    for (const ip of res.body.ips) {
      expect(ip).not.toContain('127.0.0.1');
      expect(ip).not.toContain(':');
    }
    delete process.env.ZAI_PORT;
  });

  it('returns default host=127.0.0.1 when not --lan', async () => {
    delete process.env.ZAI_PORT;
    const res = await request(makeApp('/tmp', 'tmp'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('127.0.0.1');
    expect(res.body.port).toBe(0); // 无 env 时 port=0
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd packages/zai && npx vitest run test/server/system-route-extra.test.ts`
Expected: PASS — 2 cases

- [ ] **Step 4: 跑现有 system 测试不破**

Run: `cd packages/zai && npx vitest run test/server/system.test.ts`
Expected: PASS — 现有 2 cases,扩展字段不破坏

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/system.ts packages/zai/test/server/system-route-extra.test.ts
git commit -m "feat(zai): GET /api/system returns host/port/ips"
```

---

## Task 6: `start.ts` 把 port 写入 `process.env.ZAI_PORT`

**Files:**
- Modify: `packages/zai/src/cli/start.ts:45-65`

**Interfaces:**
- Produces: `process.env.ZAI_PORT = String(port)` 让 system 路由读得到

- [ ] **Step 1: 在 listen 成功后写 env**

Edit `packages/zai/src/cli/start.ts` — 在 `await new Promise(...)` 成功之后(line 60-61 之间):

```ts
      await new Promise<void>((resolve, reject) => {
        server!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(err);
          } else {
            reject(err);
          }
        });
        server!.listen(port, host, () => {
          process.env.ZAI_PORT = String(port);
          resolve();
        });
      });
```

注:dev.ts 同样需要写,见 Task 7。

- [ ] **Step 2: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/cli/start.ts
git commit -m "feat(zai): write ZAI_PORT env on successful bind"
```

---

## Task 7: `dev.ts` 也写 `ZAI_PORT` (避免 dev 模式 port=0)

**Files:**
- Modify: `packages/zai/src/cli/dev.ts:30-52`

**Interfaces:**
- Produces: dev 模式启动后 `/api/system` 能拿到正确 port

- [ ] **Step 1: 修改 dev.ts listen 回调**

Edit `packages/zai/src/cli/dev.ts:34-41`:

```ts
      await new Promise<void>((resolve, reject) => {
        apiServer!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') reject(err);
          else reject(err);
        });
        apiServer!.listen(apiPort, '127.0.0.1', () => {
          process.env.ZAI_PORT = String(apiPort);
          resolve();
        });
      });
```

dev 模式本期不支持 `--lan`(降低 PR 风险),host 保持 `'127.0.0.1'`。

- [ ] **Step 2: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/cli/dev.ts
git commit -m "feat(zai): dev mode writes ZAI_PORT env"
```

---

## Task 8: `useAppStore.instanceContext` 类型扩展

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts:42-44`

**Interfaces:**
- Produces: `instanceContext: { cwd, cwdName, branch, host, port, ips } | null`

- [ ] **Step 1: 修改接口**

Edit `packages/zai/src/web/src/store/useAppStore.ts:42-44`:

```ts
  instanceContext: {
    cwd: string;
    cwdName: string;
    branch: string | null;
    host: string;
    port: number;
    ips: string[];
  } | null;
  setInstanceContext: (ctx: {
    cwd: string;
    cwdName: string;
    branch: string | null;
    host: string;
    port: number;
    ips: string[];
  }) => void;
```

- [ ] **Step 2: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS — type 扩展向后兼容

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts
git commit -m "feat(zai): useAppStore.instanceContext adds host/port/ips"
```

---

## Task 9: `Layout.tsx` hydrate 透传新字段

**Files:**
- Modify: `packages/zai/src/web/src/components/Layout.tsx:40-52`

**Interfaces:**
- Consumes: `api.get<...>('/system')` 返回值带 host/port/ips
- Produces: `setInstanceContext` 接收扩展 payload

- [ ] **Step 1: 修改 hydrate effect**

Edit `packages/zai/src/web/src/components/Layout.tsx:40-52`:

```ts
  useEffect(() => {
    api
      .get<{
        ok: boolean;
        version: string;
        cwd: string;
        cwdName: string;
        branch: string | null;
        host: string;
        port: number;
        ips: string[];
      }>('/system')
      .then((data) => {
        setVersion(data.version);
        setInstanceContext({
          cwd: data.cwd,
          cwdName: data.cwdName,
          branch: data.branch ?? null,
          host: data.host,
          port: data.port,
          ips: data.ips ?? [],
        });
        document.title = `${data.cwdName}-Z.AI`;
      })
      .catch(() => {
        setVersion('unknown');
        document.title = 'opencc-web-Z.AI';
      });
  }, [setInstanceContext]);
```

- [ ] **Step 2: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/Layout.tsx
git commit -m "feat(zai): Layout hydrate instanceContext with host/port/ips"
```

---

## Task 10: `SharePopover.tsx` 新组件

**Files:**
- Create: `packages/zai/src/web/src/components/SharePopover.tsx`
- Test: `packages/zai/test/web/SharePopover.test.tsx`

**Interfaces:**
- Consumes: `useAppStore.instanceContext`, `useAgentStore.sessionId`
- Produces: 渲染 IP 列表 + 复制按钮;Copy 调 `navigator.clipboard.writeText`

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/test/web/SharePopover.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "../../src/store/useAppStore.js";
import { useAgentStore } from "../../src/store/useAgentStore.js";
import SharePopover from "../../src/components/SharePopover.js";

beforeEach(() => {
  useAppStore.setState({
    instanceContext: {
      cwd: "/tmp",
      cwdName: "tmp",
      branch: null,
      host: "0.0.0.0",
      port: 9888,
      ips: ["192.168.1.5", "10.0.0.2"],
    },
  });
  useAgentStore.setState({
    sessionId: "sess-test-123",
  });
});

describe("SharePopover", () => {
  test("renders IP list with sid in URL", () => {
    render(<SharePopover />);
    expect(screen.getByText("192.168.1.5:9888")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.2:9888")).toBeInTheDocument();
    expect(screen.getByText(/sess-test-123/)).toBeInTheDocument();
  });

  test("shows '先开一个会话' when no sessionId", () => {
    useAgentStore.setState({ sessionId: null });
    render(<SharePopover />);
    expect(screen.getByText(/先开一个会话/)).toBeInTheDocument();
  });

  test("shows '未启用 --lan' when ips empty", () => {
    useAppStore.setState({
      instanceContext: {
        cwd: "/tmp",
        cwdName: "tmp",
        branch: null,
        host: "127.0.0.1",
        port: 9888,
        ips: [],
      },
    });
    render(<SharePopover />);
    expect(screen.getByText(/未启用 --lan/)).toBeInTheDocument();
  });

  test("clicking Copy invokes navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // antd message.success 静默(避免 happy-dom 报错)
    vi.mock("antd", async (importOriginal) => {
      const mod = await importOriginal();
      return { ...mod, message: { success: () => {}, error: () => {} } };
    });
    render(<SharePopover />);
    const copyBtns = screen.getAllByRole("button", { name: /复制/ });
    fireEvent.click(copyBtns[0]!);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "http://192.168.1.5:9888/agent?sid=sess-test-123",
      );
    });
  });

  test("clipboard.writeText reject triggers error message", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const errorFn = vi.fn();
    vi.mock("antd", async (importOriginal) => {
      const mod = await importOriginal();
      return {
        ...mod,
        message: { success: () => {}, error: errorFn },
      };
    });
    render(<SharePopover />);
    const copyBtns = screen.getAllByRole("button", { name: /复制/ });
    fireEvent.click(copyBtns[0]!);
    await waitFor(() => {
      expect(errorFn).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai && npx vitest run test/web/SharePopover.test.tsx`
Expected: FAIL — `SharePopover.tsx` 不存在

- [ ] **Step 3: 实现 `SharePopover`**

新建 `packages/zai/src/web/src/components/SharePopover.tsx`:

```tsx
import { Button, Space, Typography, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useAppStore } from "../store/useAppStore.js";
import { useAgentStore } from "../store/useAgentStore.js";

const { Text } = Typography;

export default function SharePopover() {
  const ctx = useAppStore((s) => s.instanceContext);
  const sessionId = useAgentStore((s) => s.sessionId);

  if (!sessionId) {
    return (
      <div style={{ padding: "12px 4px", fontSize: 13 }}>
        先开一个会话再分享。
      </div>
    );
  }

  if (!ctx || ctx.ips.length === 0) {
    return (
      <div style={{ padding: "12px 4px", fontSize: 13, maxWidth: 280 }}>
        未启用 <code>--lan</code>,无法分享到局域网。
        <br />
        用 <code>zai --lan</code> 重新启动 server。
      </div>
    );
  }

  const handleCopy = async (ip: string) => {
    const url = `http://${ip}:${ctx.port}/agent?sid=${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      message.success(`已复制 ${url}`);
    } catch {
      message.error("复制失败,请手动选择文本");
    }
  };

  return (
    <div style={{ maxWidth: 360, padding: "4px 0" }}>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
        分享到 LAN — 点 Copy 把链接发给同事
      </div>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {ctx.ips.map((ip) => {
          const url = `http://${ip}:${ctx.port}/agent?sid=${sessionId}`;
          return (
            <div
              key={ip}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 4,
              }}
            >
              <Text
                code
                style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}
              >
                {ip}:{ctx.port}/agent?sid={sessionId.slice(0, 12)}…
              </Text>
              <Button
                size="small"
                icon={<CopyOutlined />}
                data-testid={`share-copy-${ip}`}
                onClick={() => void handleCopy(ip)}
                aria-label={`复制 ${ip}`}
              >
                复制
              </Button>
            </div>
          );
        })}
      </Space>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zai && npx vitest run test/web/SharePopover.test.tsx`
Expected: PASS — 5 cases

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/SharePopover.tsx packages/zai/test/web/SharePopover.test.tsx
git commit -m "feat(zai): SharePopover lists LAN IPs with copy"
```

---

## Task 11: `AgentInputBox.tsx` 加 Share 按钮 + Popover

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:1-25, 716-721`

**Interfaces:**
- Consumes: `useAppStore.instanceContext`, `useAgentStore.sessionId`
- Produces: 工具栏 spacer 后第一个按钮 = ShareAltOutlined + Popover

- [ ] **Step 1: 修改 imports**

Edit `packages/zai/src/web/src/components/AgentInputBox.tsx:1-25` — 在 `@ant-design/icons` import 块加入 `ShareAltOutlined`,在 react + antd import 加入 `Popover`:

```tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input, Button, message, Popover, Tooltip } from "antd";
import {
  PictureOutlined,
  ToolOutlined,
  CompressOutlined,
  ExpandOutlined,
  BorderOutlined,
  MenuUnfoldOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
```

并在文件其他 import 之后追加:

```tsx
import SharePopover from "./SharePopover.js";
import { useAppStore } from "../store/useAppStore.js";
```

(注意:`useAppStore` 已经在 line 18 import 过,删掉重复即可)

- [ ] **Step 2: 在 `AgentInputBox` 函数体内加 share 状态**

Edit `packages/zai/src/web/src/components/AgentInputBox.tsx` — 在 line 102 `const [input, setInput] = useState("");` 附近追加:

```tsx
  const [shareOpen, setShareOpen] = useState(false);
  const shareIps = useAppStore((s) => s.instanceContext?.ips ?? []);
```

- [ ] **Step 3: 在工具栏 spacer 后插入 Share 按钮**

Edit `packages/zai/src/web/src/components/AgentInputBox.tsx:716-721` — 把这段:

```tsx
        <span style={{ flex: 1, minWidth: 0 }} />
        {/* settings 按钮(首期 UI 原型入口,点击弹出 SettingsDrawer).
            位置:右端工具栏第一项,在 CompressOutlined 之前 — 与原 4 个图标
            共用同一行 flex 容器,颜色一致 (rgba(255,255,255,0.45)).
            替代原 opencc 上游 [⚙] 内嵌快捷键;阶段 2 再加 dropdown 双层结构. */}
        <SettingsButton />
```

改为:

```tsx
        <span style={{ flex: 1, minWidth: 0 }} />
        {/* Share 按钮: 分享当前 session 到 LAN.
            - 位置: spacer 后最右, 作为工具栏右端第一入口 (演示场景核心操作).
            - disabled: 无 sessionId 时 disabled (分享空 session 无意义).
            - Popover: 受控 open={shareOpen}, 内部渲染 SharePopover.
            - 图标色与同行其他按钮一致 (rgba(255,255,255,0.45)).
            详见 docs/superpowers/specs/2026-07-25-zai-agent-share-design.md §4.6 */}
        <Tooltip
          title={
            sessionId
              ? "分享到 LAN — 点开后选择 IP 复制链接发给同事"
              : "先开一个会话再分享"
          }
          placement="top"
        >
          <Popover
            open={shareOpen}
            onOpenChange={(v) => setShareOpen(v)}
            trigger="click"
            placement="topRight"
            arrow={false}
            destroyTooltipOnHide
            content={<SharePopover />}
          >
            <Button
              icon={<ShareAltOutlined />}
              data-testid="share-button"
              disabled={!sessionId}
              aria-pressed={shareOpen}
              style={{
                color: shareOpen ? "#ff6600" : "rgba(255,255,255,0.45)",
                flexShrink: 0,
              }}
            />
          </Popover>
        </Tooltip>
        <SettingsButton />
```

- [ ] **Step 4: typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 跑 AgentInputBox 现有测试不破**

Run: `cd packages/zai && npx vitest run test/web/AgentInputBox.test.tsx`
Expected: PASS — 现有 slash / status bar 用例不受影响

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx
git commit -m "feat(zai): share button + Popover in AgentInputBox toolbar"
```

---

## Task 12: AgentInputBox 集成测试 + 全套验证

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.test.tsx`

**Interfaces:**
- Verifies: share-button 渲染、disabled 条件、Popover 打开

- [ ] **Step 1: 在现有 `AgentInputBox.test.tsx` 末尾追加 describe**

Read `packages/zai/src/web/src/components/AgentInputBox.test.tsx` 找文件末尾,在最后一行前(最后 `});` 之前)追加:

```tsx
import { useAppStore } from "../store/useAppStore.js";

// (放在 import 块顶部附近)

describe('AgentInputBox — share button', () => {
  beforeEach(() => {
    useAppStore.setState({
      instanceContext: {
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        host: '0.0.0.0',
        port: 9888,
        ips: ['192.168.1.5'],
      },
    });
  });

  test('share button renders', () => {
    render(<AgentInputBox />);
    expect(screen.getByTestId('share-button')).toBeInTheDocument();
  });

  test('share button disabled when no sessionId', () => {
    useAgentStore.setState({ sessionId: null });
    render(<AgentInputBox />);
    expect(screen.getByTestId('share-button')).toBeDisabled();
  });

  test('clicking share button opens popover with IP list', async () => {
    render(<AgentInputBox />);
    fireEvent.click(screen.getByTestId('share-button'));
    await waitFor(() => {
      expect(screen.getByText(/192.168.1.5/)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd packages/zai && npx vitest run test/web/AgentInputBox.test.tsx`
Expected: PASS — 旧用例 + 新 3 个 share 用例全过

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "test(zai): AgentInputBox share button integration"
```

---

## Task 13: 全套验证

**Files:** (无)

- [ ] **Step 1: 全量 typecheck**

Run: `cd packages/zai && npm run typecheck`
Expected: PASS — 0 errors

- [ ] **Step 2: 全量测试**

Run: `cd packages/zai && npm test 2>&1 | tail -50`
Expected: 所有 suite PASS(应包含 lanIps / ports / system / system-route-extra / SharePopover / AgentInputBox)

- [ ] **Step 3: 手动 smoke — `zai --lan` 启动**

Run: `cd packages/zai && npm run build && timeout 5 node dist/cli/index.js start --lan 2>&1 | head -30`
Expected: 输出包含 `LAN mode` 行 + 至少一个 `→ http://<ip>:<port>` 行

- [ ] **Step 4: 验证 docs 同步**

确认 `docs/superpowers/specs/2026-07-25-zai-agent-share-design.md` 和本 plan 都已 commit。
Run: `git log --oneline -20`
Expected: 见到所有 feat(zai): ... 和 test(zai): ... commits,以及 docs(spec) 和 docs(plan) commits

- [ ] **Step 5: 完整 diff review**

Run: `git diff main~13 main --stat`
Expected: 改动列表与 spec §8 文件清单一致(无散落意外改动)