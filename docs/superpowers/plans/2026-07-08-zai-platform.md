# ZAI Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@zn-ai/zai` — a local web platform that replicates all `scripts/zn-ai` functionality (system info, CLI install/upgrade, resource browse/install, login via system Terminal, config editor) behind a Node/Express API + React SPA served on port 7715.

**Architecture:** Single npm package `packages/zai/` with `src/server/` (Express + SSE for streaming long commands) and `src/web/` (React + Vite + Tailwind + Antd). `zai dev` spawns both dev servers with HMR; `zai start` runs production build from single Express process.

**Tech Stack:** Node 20+, TypeScript, Express 4, Vite 5, React 18, React Router 6, Tailwind 3, Antd 5, Zustand 4, Vitest, Commander 12, Zod.

## Global Constraints

- Node >= 20 required (enforced at startup with `process.version` check, exit code 1 if lower)
- Default port 7715; `--port` flag overrides
- Default auto-open browser; `--no-open` flag disables
- All write API routes require `X-Zai-Token` header (token printed to stdout on launch, prevents LAN misuse)
- All user input (pkg/name/type) validated via Zod whitelist; no path traversal
- SSE events follow schema: `{ type: 'start' | 'stdout' | 'stderr' | 'exit' | 'error', ... }`
- Config writes are atomic (write to `.tmp` then `fs.rename`)
- Sub-process default timeout: 5 min; SIGTERM then SIGKILL after 10s
- Commit prefix: `HRMSV3-ZN-WEBSITE#668 feat(zai):` (per AGENTS.md)
- No `node-pty`; login spawns macOS `Terminal.app` via `osascript`

## File Structure

```
packages/zai/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── bin/zai.js
├── src/
│   ├── shared/types.ts
│   ├── cli/{index,dev,start}.ts
│   ├── server/{index,types}.ts
│   ├── server/services/{detect,spawner,fileStore,osascript}.ts
│   ├── server/routes/{system,cli,dirs,login,config,resources,stream,health}.ts
│   └── web/{index.html,src/{main,App,router}.tsx,src/lib/{api,sse}.ts,src/store/useAppStore.ts}
│   └── web/src/components/{Layout,LogPanel,StatusDot,ConfirmButton}.tsx
│   └── web/src/pages/{Dashboard,Tools,Resources,Login,Config,Directory}.tsx
└── test/server/{detect,fileStore,spawner,health,system}.test.ts
```

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/zai/package.json`
- Create: `packages/zai/tsconfig.json`
- Create: `packages/zai/bin/zai.js`
- Create: `packages/zai/src/shared/types.ts`
- Create: `packages/zai/.gitignore`

**Interfaces:**
- Produces: `bin/zai.js` executable that resolves to `dist/cli/index.js`
- Produces: `shared/types.ts` exports `SystemInfo`, `CliStatus`, `DirectoryStatus`, `ResourceItem`, `ConfigFile`, `SseEvent`

- [ ] **Step 1: Create `package.json`**

```bash
mkdir -p packages/zai/bin packages/zai/src/shared packages/zai/src/server/services packages/zai/src/server/routes packages/zai/src/cli packages/zai/src/web/src/components packages/zai/src/web/src/pages packages/zai/src/web/src/lib packages/zai/src/web/src/store packages/zai/test/server
cd packages/zai
```

Write `packages/zai/package.json`:
```json
{
  "name": "@zn-ai/zai",
  "version": "0.1.0",
  "description": "知鸟AI 统一工具平台 — 本地 Web 管理界面",
  "type": "module",
  "main": "dist/server/index.js",
  "types": "dist/server/index.d.ts",
  "bin": {
    "zai": "bin/zai.js"
  },
  "files": [
    "bin/",
    "dist/"
  ],
  "scripts": {
    "dev": "tsx src/cli/index.ts dev",
    "build": "tsc -b && npm run build:web",
    "build:web": "vite build --outDir dist/web",
    "start": "node dist/cli/index.js start",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "clean": "rm -rf dist",
    "typecheck": "tsc -b --noEmit"
  },
  "keywords": ["zn-ai", "nova", "opencode", "opencc", "cli", "platform"],
  "author": "ZN-AI",
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "express": "^4.21.2",
    "proper-lockfile": "^4.1.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^15.0.0",
    "@types/express": "^4.17.21",
    "@types/node": "^20.12.0",
    "@types/proper-lockfile": "^4.1.4",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/supertest": "^6.0.2",
    "@vitejs/plugin-react": "^4.3.0",
    "antd": "^5.22.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "supertest": "^7.0.0",
    "tailwindcss": "^3.4.15",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0",
    "zustand": "^4.5.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write `packages/zai/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "jsx": "react-jsx",
    "paths": {
      "@shared/*": ["./src/shared/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["test/**/*", "dist/**/*"]
}
```

- [ ] **Step 3: Create `bin/zai.js`**

Write `packages/zai/bin/zai.js`:
```js
#!/usr/bin/env node
import('../dist/cli/index.js').catch((err) => {
  console.error('[zai] Failed to start:', err);
  process.exit(1);
});
```

Make it executable:
```bash
chmod +x packages/zai/bin/zai.js
```

- [ ] **Step 4: Create `src/shared/types.ts`**

Write `packages/zai/src/shared/types.ts`:
```ts
// Shared type definitions — single source of truth for backend + frontend

export interface SystemInfo {
  nodeVersion: string;
  nodeMajor: number;
  npmVersion: string | null;
  npmPrefix: string;
  npmRegistry: string;
  npmBinInPath: boolean;
}

export interface CliStatus {
  name: 'nova' | 'opencode' | 'opencc' | 'agent-login';
  pkg: string;
  installed: boolean;
  path: string | null;
}

export interface DirectoryStatus {
  nova: DirInfo;
  opencode: DirInfo;
  opencc: DirInfo;
  globalSkills: DirInfo;
}

export interface DirInfo {
  path: string;
  exists: boolean;
  agents: FileCount;
  commands: FileCount;
  skills: FileCount;
  extensions: FileCount;
}

export interface FileCount {
  count: number;
  items: string[];
}

export type ResourceType = 'skills' | 'commands' | 'extensions' | 'agents';

export interface ResourceItem {
  name: string;
  type: ResourceType;
}

export interface ConfigFile {
  path: string;
  exists: boolean;
  content: Record<string, unknown>;
  missing?: boolean;
}

export type SseEventType = 'start' | 'stdout' | 'stderr' | 'exit' | 'error';

export interface SseEvent {
  type: SseEventType;
  command?: string;
  line?: string;
  code?: number;
  signal?: string;
  message?: string;
}

export type ConfigTool = 'nova' | 'opencode' | 'opencc';
export type LoginType = 'pa' | 'op' | 'op-stg';
```

- [ ] **Step 5: Create `.gitignore`**

Write `packages/zai/.gitignore`:
```
node_modules/
dist/
*.log
.env
.env.*
!.env.example
.vite/
.DS_Store
```

- [ ] **Step 6: Run `pnpm install`**

```bash
cd packages/zai
pnpm install
```

Expected: dependencies resolve; `node_modules` created.

- [ ] **Step 7: Commit**

```bash
cd /path/to/zn-agent-assets
git add packages/zai
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): scaffold package structure and shared types"
```

---

## Task 2: Backend `detect` service (TDD)

**Files:**
- Create: `packages/zai/src/server/services/detect.ts`
- Create: `packages/zai/test/server/detect.test.ts`

**Interfaces:**
- Consumes: `SystemInfo` from `src/shared/types.ts`
- Produces: `getSystemInfo(): Promise<SystemInfo>` — returns Node/npm info
- Produces: `getCliStatuses(): Promise<CliStatus[]>` — checks nova/opencode/opencc/agent-login

- [ ] **Step 1: Write the failing test**

Write `packages/zai/test/server/detect.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getSystemInfo, getCliStatuses } from '../../src/server/services/detect.js';

describe('getSystemInfo', () => {
  it('returns current Node version and major', async () => {
    const info = await getSystemInfo();
    expect(info.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
    expect(info.nodeMajor).toBeGreaterThanOrEqual(20);
  });

  it('returns npm version if installed', async () => {
    const info = await getSystemInfo();
    if (info.npmVersion) {
      expect(info.npmVersion).toMatch(/^\d+\./);
    }
  });

  it('returns npm prefix and registry', async () => {
    const info = await getSystemInfo();
    expect(info.npmPrefix).toBeTruthy();
    expect(info.npmRegistry).toBeTruthy();
  });
});

describe('getCliStatuses', () => {
  it('returns 4 entries with expected names', async () => {
    const list = await getCliStatuses();
    const names = list.map((c) => c.name);
    expect(names).toContain('nova');
    expect(names).toContain('opencode');
    expect(names).toContain('opencc');
    expect(names).toContain('agent-login');
  });

  it('each entry has installed boolean and optional path', async () => {
    const list = await getCliStatuses();
    for (const c of list) {
      expect(typeof c.installed).toBe('boolean');
      if (c.installed) {
        expect(c.path).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zai
pnpm test detect
```

Expected: FAIL with "Cannot find module '...detect.js'".

- [ ] **Step 3: Write minimal implementation**

Write `packages/zai/src/server/services/detect.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemInfo, CliStatus } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
  return stdout.trim();
}

async function safeRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    return await run(cmd, args);
  } catch {
    return null;
  }
}

async function which(cmd: string): Promise<string | null> {
  return safeRun('which', [cmd]);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split('.')[0], 10);

  const npmVersion = await safeRun('npm', ['--version']);
  const npmPrefix = (await safeRun('npm', ['config', 'get', 'prefix'])) ?? '';
  const npmRegistry = (await safeRun('npm', ['config', 'get', 'registry'])) ?? '';
  const npmBin = npmPrefix ? `${npmPrefix}/bin` : '';
  const npmBinInPath = npmBin ? process.env.PATH?.split(':').includes(npmBin) ?? false : false;

  return {
    nodeVersion,
    nodeMajor,
    npmVersion,
    npmPrefix,
    npmRegistry,
    npmBinInPath,
  };
}

export async function getCliStatuses(): Promise<CliStatus[]> {
  const targets: Array<{ name: CliStatus['name']; pkg: string; bin: string }> = [
    { name: 'nova', pkg: '@zn-ai/nova', bin: 'nova' },
    { name: 'opencode', pkg: 'opencode-ai', bin: 'opencode' },
    { name: 'opencc', pkg: '@zn-ai/opencc', bin: 'opencc' },
    { name: 'agent-login', pkg: '@zn-ai/agent-login', bin: 'agent-login' },
  ];

  const results: CliStatus[] = [];
  for (const t of targets) {
    const path = await which(t.bin);
    results.push({
      name: t.name,
      pkg: t.pkg,
      installed: !!path,
      path,
    });
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zai
pnpm test detect
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /path/to/zn-agent-assets
git add packages/zai/src/server/services/detect.ts packages/zai/test/server/detect.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add detect service for Node/npm/CLI status"
```

---

## Task 3: Backend `spawner` service (TDD)

**Files:**
- Create: `packages/zai/src/server/services/spawner.ts`
- Create: `packages/zai/test/server/spawner.test.ts`

**Interfaces:**
- Produces: `spawn(command, args, onLine) → Promise<{code, signal}>`
- `onLine: (event: SseEvent) => void`
- Default timeout: 5 min (300_000 ms)
- SIGTERM + 10s later SIGKILL on timeout

- [ ] **Step 1: Write the failing test**

Write `packages/zai/test/server/spawner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawn } from '../../src/server/services/spawner.js';
import type { SseEvent } from '../../src/shared/types.js';

describe('spawn', () => {
  it('emits start and exit events for a simple command', async () => {
    const events: SseEvent[] = [];
    const onLine = (e: SseEvent) => events.push(e);

    const result = await spawn('echo', ['hello'], onLine);

    expect(events[0]?.type).toBe('start');
    expect(events[0]?.command).toBe('echo hello');
    expect(events.some((e) => e.type === 'stdout' && e.line?.includes('hello'))).toBe(true);
    expect(events[events.length - 1]?.type).toBe('exit');
    expect(result.code).toBe(0);
  });

  it('captures stderr for failing commands', async () => {
    const events: SseEvent[] = [];
    await spawn('node', ['-e', 'console.error("oops"); process.exit(2)'], (e) => events.push(e));

    expect(events.some((e) => e.type === 'stderr' && e.line?.includes('oops'))).toBe(true);
    expect(events[events.length - 1]?.type).toBe('exit');
    expect(events[events.length - 1]?.code).toBe(2);
  });

  it('supports custom timeout', async () => {
    const events: SseEvent[] = [];
    // sleep 2s with 500ms timeout should error
    await spawn('sleep', ['2'], (e) => events.push(e), { timeout: 500 });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zai
pnpm test spawner
```

Expected: FAIL with "Cannot find module '...spawner.js'".

- [ ] **Step 3: Write minimal implementation**

Write `packages/zai/src/server/services/spawner.ts`:
```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { SseEvent } from '../../shared/types.js';

interface SpawnOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export async function spawn(
  command: string,
  args: string[],
  onLine: (event: SseEvent) => void,
  opts: SpawnOptions = {},
): Promise<{ code: number; signal: string | null }> {
  const timeout = opts.timeout ?? 300_000;

  onLine({ type: 'start', command: `${command} ${args.join(' ')}`.trim() });

  const child: ChildProcess = nodeSpawn(command, args, {
    env: { ...process.env, ...opts.env },
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      onLine({ type: 'stdout', line });
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      onLine({ type: 'stderr', line });
    }
  });

  const timeoutHandle = setTimeout(() => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 10_000);
    onLine({ type: 'error', message: `Process timed out after ${timeout}ms` });
  }, timeout);

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timeoutHandle);
      if (stdoutBuf) onLine({ type: 'stdout', line: stdoutBuf });
      if (stderrBuf) onLine({ type: 'stderr', line: stderrBuf });
      onLine({ type: 'exit', code: code ?? 1, signal: signal ?? undefined });
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zai
pnpm test spawner
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /path/to/zn-agent-assets
git add packages/zai/src/server/services/spawner.ts packages/zai/test/server/spawner.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add spawner service with timeout and SSE events"
```

---

## Task 4: Backend `fileStore` service (TDD)

**Files:**
- Create: `packages/zai/src/server/services/fileStore.ts`
- Create: `packages/zai/test/server/fileStore.test.ts`

**Interfaces:**
- Produces: `readConfig(tool) → Promise<ConfigFile>`
- Produces: `writeConfig(tool, content) → Promise<{ok: true}>`
- `tool ∈ 'nova' | 'opencode' | 'opencc'`
- Atomic write via `.tmp` + `fs.rename`

- [ ] **Step 1: Write the failing test**

Write `packages/zai/test/server/fileStore.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/server/services/fileStore.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-test-'));
  process.env.HOME = tempHome;
  // Pre-create nova dir
  mkdirSync(join(tempHome, '.nova'), { recursive: true });
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('returns missing:true when config file does not exist', async () => {
    const result = await readConfig('nova');
    expect(result.exists).toBe(false);
    expect(result.missing).toBe(true);
  });
});

describe('writeConfig + readConfig roundtrip', () => {
  it('writes and reads back content atomically', async () => {
    const content = { env: { TEST: '1' } };
    await writeConfig('nova', content);
    const result = await readConfig('nova');
    expect(result.exists).toBe(true);
    expect(result.content).toEqual(content);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zai
pnpm test fileStore
```

Expected: FAIL with "Cannot find module '...fileStore.js'".

- [ ] **Step 3: Write minimal implementation**

Write `packages/zai/src/server/services/fileStore.ts`:
```ts
import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigFile, ConfigTool } from '../../shared/types.js';

const CONFIG_PATHS: Record<ConfigTool, string> = {
  nova: join(homedir(), '.nova', 'settings.json'),
  opencode: join(homedir(), '.config', 'opencode', 'opencode.json'),
  opencc: join(homedir(), '.claude', 'settings.json'),
};

export async function readConfig(tool: ConfigTool): Promise<ConfigFile> {
  const path = CONFIG_PATHS[tool];
  try {
    const raw = await readFile(path, 'utf-8');
    return { path, exists: true, content: JSON.parse(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: {}, missing: true };
    }
    throw err;
  }
}

export async function writeConfig(
  tool: ConfigTool,
  content: Record<string, unknown>,
): Promise<{ ok: true }> {
  const path = CONFIG_PATHS[tool];
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
  await rename(tmpPath, path);
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zai
pnpm test fileStore
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /path/to/zn-agent-assets
git add packages/zai/src/server/services/fileStore.ts packages/zai/test/server/fileStore.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add fileStore service for atomic config R/W"
```

---

## Task 5: Backend `osascript` service (TDD)

**Files:**
- Create: `packages/zai/src/server/services/osascript.ts`
- Create: `packages/zai/test/server/osascript.test.ts`

**Interfaces:**
- Produces: `openLoginInTerminal(type: LoginType) → Promise<{ok: true, pid: number}>`
- Spawns `osascript` that opens `Terminal.app` and runs `npx @zn-ai/agent-login@latest <type>`
- macOS-only; returns `{ok: false, message}` on non-macOS

- [ ] **Step 1: Write the failing test**

Write `packages/zai/test/server/osascript.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openLoginInTerminal } from '../../src/server/services/osascript.js';

describe('openLoginInTerminal', () => {
  it('returns ok:true with pid on macOS (or ok:false on non-macOS)', async () => {
    const result = await openLoginInTerminal('pa');
    if (process.platform === 'darwin') {
      expect(result.ok).toBe(true);
      if (result.ok) expect(typeof result.pid).toBe('number');
    } else {
      expect(result.ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zai
pnpm test osascript
```

Expected: FAIL with "Cannot find module '...osascript.js'".

- [ ] **Step 3: Write minimal implementation**

Write `packages/zai/src/server/services/osascript.ts`:
```ts
import { spawn } from 'node:child_process';
import type { LoginType } from '../../shared/types.js';

type OpenResult =
  | { ok: true; pid: number }
  | { ok: false; message: string };

export async function openLoginInTerminal(type: LoginType): Promise<OpenResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'macOS required for Terminal.app spawn' };
  }

  const argsMap: Record<LoginType, string[]> = {
    pa: ['pa'],
    op: ['op'],
    'op-stg': ['op', '--stg'],
  };

  const agentLoginArgs = ['@zn-ai/agent-login@latest', ...argsMap[type]].join(' ');
  const script = `tell application "Terminal"
  do script "npx ${agentLoginArgs}"
end tell`;

  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('spawn', () => resolve({ ok: true, pid: child.pid ?? 0 }));
    child.on('error', (err) => resolve({ ok: false, message: String(err) }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zai
pnpm test osascript
```

Expected: PASS (on macOS).

- [ ] **Step 5: Commit**

```bash
cd /path/to/zn-agent-assets
git add packages/zai/src/server/services/osascript.ts packages/zai/test/server/osascript.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add osascript service for macOS Terminal.app login"
```

---

## Task 6: SSE stream helper

**Files:**
- Create: `packages/zai/src/server/routes/stream.ts`

**Interfaces:**
- Produces: `createSseStream(res) → { send, end }` — helper for Express responses
- Sets headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`

- [ ] **Step 1: Write implementation**

Write `packages/zai/src/server/routes/stream.ts`:
```ts
import type { Response } from 'express';
import type { SseEvent } from '../../shared/types.js';

export interface SseStream {
  send: (event: SseEvent) => void;
  end: () => void;
}

export function createSseStream(res: Response): SseStream {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  return {
    send(event: SseEvent) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      res.end();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/zai/src/server/routes/stream.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add SSE stream helper"
```

---

## Task 7: Backend routes — `/api/health`, `/api/system`, `/api/cli`

**Files:**
- Create: `packages/zai/src/server/routes/health.ts`
- Create: `packages/zai/src/server/routes/system.ts`
- Create: `packages/zai/src/server/routes/cli.ts`
- Create: `packages/zai/test/server/health.test.ts`
- Create: `packages/zai/test/server/system.test.ts`

**Interfaces:**
- Consumes: `getSystemInfo`, `getCliStatuses` from `services/detect.js`
- Produces: Express Routers mounted under `/api`

- [ ] **Step 1: Write the failing test**

Write `packages/zai/test/server/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import healthRouter from '../../src/server/routes/health.js';

describe('GET /api/health', () => {
  it('returns 200 with ok:true', async () => {
    const app = express().use('/api', healthRouter);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toMatch(/^\d+\./);
  });
});
```

Write `packages/zai/test/server/system.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import systemRouter from '../../src/server/routes/system.js';
import cliRouter from '../../src/server/routes/cli.js';

describe('GET /api/system', () => {
  it('returns nodeVersion and npmPrefix', async () => {
    const app = express().use('/api', systemRouter);
    const res = await request(app).get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.nodeVersion).toMatch(/^v\d+/);
    expect(typeof res.body.npmPrefix).toBe('string');
  });
});

describe('GET /api/cli', () => {
  it('returns array with 4 entries', async () => {
    const app = express().use('/api', cliRouter);
    const res = await request(app).get('/api/cli');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zai
pnpm test health
pnpm test system
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Write implementations**

Write `packages/zai/src/server/routes/health.ts`:
```ts
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const router = Router();

router.get('/health', async (_req, res) => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    res.json({ ok: true, version: pkg.version });
  } catch {
    res.json({ ok: true, version: '0.0.0' });
  }
});

export default router;
```

Write `packages/zai/src/server/routes/system.ts`:
```ts
import { Router } from 'express';
import { getSystemInfo } from '../services/detect.js';

const router = Router();

router.get('/system', async (_req, res) => {
  try {
    const info = await getSystemInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

Write `packages/zai/src/server/routes/cli.ts`:
```ts
import { Router } from 'express';
import { getCliStatuses } from '../services/detect.js';

const router = Router();

router.get('/cli', async (_req, res) => {
  try {
    const list = await getCliStatuses();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zai
pnpm test health
pnpm test system
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes packages/zai/test/server
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add /api/health, /api/system, /api/cli routes"
```

---

## Task 8: Backend routes — `/api/dirs`, `/api/login/:type`, `/api/config/:tool`, `/api/resources/:type`, `/api/install/*`, `/api/quickstart`

**Files:**
- Create: `packages/zai/src/server/routes/dirs.ts`
- Create: `packages/zai/src/server/routes/login.ts`
- Create: `packages/zai/src/server/routes/config.ts`
- Create: `packages/zai/src/server/routes/resources.ts`

**Interfaces:**
- `dirs`: reads `~/.nova` `~/.config/opencode` `~/.claude` `~/.agents/skills` tree
- `login`: invokes `openLoginInTerminal(type)` from osascript service
- `config`: GET reads via fileStore; PUT writes atomically
- `resources`: spawns `npx @zn-ai/plugin@latest list <type>`, parses stdout
- `install/*`: SSE streaming via `createSseStream`
- `quickstart`: serial SSE stream: check missing → install → set registry

- [ ] **Step 1: Write `dirs.ts`**

Write `packages/zai/src/server/routes/dirs.ts`:
```ts
import { Router } from 'express';
import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DirectoryStatus, DirInfo, FileCount } from '../../shared/types.js';

const router = Router();

async function countDir(path: string): Promise<FileCount> {
  try {
    const items = await readdir(path);
    return { count: items.length, items };
  } catch {
    return { count: 0, items: [] };
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildDirInfo(basePath: string): Promise<DirInfo> {
  const exists = await dirExists(basePath);
  return {
    path: basePath,
    exists,
    agents: await countDir(join(basePath, 'agents')),
    commands: await countDir(join(basePath, 'commands')),
    skills: await countDir(join(basePath, 'skills')),
    extensions: await countDir(join(basePath, 'extensions')),
  };
}

router.get('/dirs', async (_req, res) => {
  try {
    const home = homedir();
    const status: DirectoryStatus = {
      nova: await buildDirInfo(join(home, '.nova')),
      opencode: await buildDirInfo(join(home, '.config', 'opencode')),
      opencc: await buildDirInfo(join(home, '.claude')),
      globalSkills: await buildDirInfo(join(home, '.agents', 'skills')),
    };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 2: Write `login.ts`**

Write `packages/zai/src/server/routes/login.ts`:
```ts
import { Router } from 'express';
import { z } from 'zod';
import { openLoginInTerminal } from '../services/osascript.js';
import type { LoginType } from '../../shared/types.js';

const router = Router();
const LoginTypeSchema = z.enum(['pa', 'op', 'op-stg']);

router.post('/login/:type', async (req, res) => {
  const parsed = LoginTypeSchema.safeParse(req.params.type);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid login type: ${req.params.type}` });
  }
  const type: LoginType = parsed.data;
  const result = await openLoginInTerminal(type);
  if (!result.ok) {
    return res.status(500).json({ error: result.message });
  }
  res.json({ ok: true, pid: result.pid });
});

export default router;
```

- [ ] **Step 3: Write `config.ts`**

Write `packages/zai/src/server/routes/config.ts`:
```ts
import { Router } from 'express';
import { z } from 'zod';
import { readConfig, writeConfig } from '../services/fileStore.js';
import type { ConfigTool } from '../../shared/types.js';

const router = Router();
const ConfigToolSchema = z.enum(['nova', 'opencode', 'opencc']);

router.get('/config/:tool', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  try {
    const result = await readConfig(parsed.data as ConfigTool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/:tool', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  try {
    await writeConfig(parsed.data as ConfigTool, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 4: Write `resources.ts`**

Write `packages/zai/src/server/routes/resources.ts`:
```ts
import { Router } from 'express';
import { z } from 'zod';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';
import type { ResourceType, ResourceItem } from '../../shared/types.js';

const router = Router();
const ResourceTypeSchema = z.enum(['skills', 'commands', 'extensions', 'agents']);

router.get('/resources/:type', async (req, res) => {
  const parsed = ResourceTypeSchema.safeParse(req.params.type);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid resource type: ${req.params.type}` });
  }
  const type = parsed.data as ResourceType;

  const lines: string[] = [];
  await spawn('npx', ['-y', '@zn-ai/plugin@latest', 'list', type], (ev) => {
    if (ev.type === 'stdout' && ev.line) lines.push(ev.line);
  });

  // Parse plugin output: each line like "  - skillname" or "skillname"
  const items: ResourceItem[] = lines
    .map((l) => l.replace(/^[\s-*]+/, '').trim())
    .filter(Boolean)
    .map((name) => ({ name, type }));

  res.json(items);
});

router.post('/install/resource', async (req, res) => {
  const parsed = z
    .object({ type: ResourceTypeSchema, name: z.string().regex(/^[a-z0-9_-]+$/i) })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' });
  }

  const stream = createSseStream(res);
  await spawn(
    'npx',
    ['-y', '@zn-ai/plugin@latest', 'install', parsed.data.type, parsed.data.name],
    (ev) => stream.send(ev),
  );
  stream.end();
});

export default router;
```

- [ ] **Step 5: Add install routes to `cli.ts`**

Edit `packages/zai/src/server/routes/cli.ts` to add:
```ts
// append after existing route definitions
import { z } from 'zod';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';

const InstallCliSchema = z.object({
  pkg: z.string().regex(/^@zn-ai\/[a-z-]+(@latest)?$/),
});

router.post('/install/cli', async (req, res) => {
  const parsed = InstallCliSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid pkg' });
  }

  const stream = createSseStream(res);
  await spawn('npm', ['install', '-g', parsed.data.pkg, '--registry=http://maven.paic.com.cn/repository/npm/'], (ev) => stream.send(ev));
  stream.end();
});
```

- [ ] **Step 6: Add quickstart route (create new file or extend cli)**

Create `packages/zai/src/server/routes/quickstart.ts`:
```ts
import { Router } from 'express';
import { getCliStatuses } from '../services/detect.js';
import { spawn } from '../services/spawner.js';
import { createSseStream } from './stream.js';

const router = Router();

router.post('/quickstart', async (_req, res) => {
  const stream = createSseStream(res);

  // 1. Check missing CLIs
  const statuses = await getCliStatuses();
  const missing = statuses.filter((s) => !s.installed);

  // 2. Install missing
  for (const cli of missing) {
    await spawn(
      'npm',
      ['install', '-g', cli.pkg, '--registry=http://maven.paic.com.cn/repository/npm/'],
      (ev) => stream.send(ev),
    );
  }

  // 3. Set registry
  await spawn('npm', ['config', 'set', 'registry', 'http://maven.paic.com.cn/repository/npm/'], (ev) => stream.send(ev));

  stream.send({ type: 'stdout', line: '✅ Quickstart complete' });
  stream.end();
});

export default router;
```

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/routes
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add dirs/login/config/resources/install/quickstart routes"
```

---

## Task 9: Backend `createApp` (Express app composition)

**Files:**
- Create: `packages/zai/src/server/index.ts`
- Create: `packages/zai/src/server/types.ts`

**Interfaces:**
- Produces: `createApp(opts: {token: string}) → Express` — mounts all routes + token auth middleware
- `opts.token` is checked via `X-Zai-Token` header on write routes

- [ ] **Step 1: Write `src/server/types.ts`**

Write `packages/zai/src/server/types.ts`:
```ts
export interface AppOptions {
  token: string;
  port?: number;
}
```

- [ ] **Step 2: Write `src/server/index.ts`**

Write `packages/zai/src/server/index.ts`:
```ts
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppOptions } from './types.js';
import healthRouter from './routes/health.js';
import systemRouter from './routes/system.js';
import cliRouter from './routes/cli.js';
import dirsRouter from './routes/dirs.js';
import loginRouter from './routes/login.js';
import configRouter from './routes/config.js';
import resourcesRouter from './routes/resources.js';
import quickstartRouter from './routes/quickstart.js';

export function createApp(opts: AppOptions): express.Express {
  const app = express();
  app.use(express.json());

  // Read routes: no token needed
  app.use('/api', healthRouter);
  app.use('/api', systemRouter);
  app.use('/api', cliRouter);
  app.use('/api', dirsRouter);
  app.use('/api', configRouter);
  app.use('/api', resourcesRouter);

  // Write routes: require token
  const tokenGuard = (req: Request, res: Response, next: NextFunction) => {
    if (req.header('X-Zai-Token') !== opts.token) {
      return res.status(401).json({ error: 'invalid token' });
    }
    next();
  };
  app.use('/api/login', tokenGuard, loginRouter);
  app.use('/api/install', tokenGuard, cliRouter);
  app.use('/api/install', tokenGuard, resourcesRouter);
  app.use('/api/config', tokenGuard, configRouter);
  app.use('/api/quickstart', tokenGuard, quickstartRouter);

  return app;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/index.ts packages/zai/src/server/types.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): compose Express app with token guard middleware"
```

---

## Task 10: CLI commands — `dev` + `start`

**Files:**
- Create: `packages/zai/src/cli/index.ts`
- Create: `packages/zai/src/cli/dev.ts`
- Create: `packages/zai/src/cli/start.ts`

**Interfaces:**
- Consumes: `createApp` from `src/server/index.ts`
- Produces: `zai dev` and `zai start` sub-commands via commander

- [ ] **Step 1: Write `src/cli/index.ts`**

Write `packages/zai/src/cli/index.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { runDev } from './dev.js';
import { runStart } from './start.js';

const program = new Command();

program
  .name('zai')
  .description('知鸟AI 统一工具平台')
  .version('0.1.0');

program
  .command('dev')
  .description('Development mode (Vite HMR + Express)')
  .option('--port <port>', 'Vite dev server port', '5173')
  .option('--api-port <port>', 'Express API port', '7715')
  .option('--no-open', 'Do not auto-open browser')
  .action(runDev);

program
  .command('start')
  .description('Production mode (static SPA + API)')
  .option('--port <port>', 'Express port', '7715')
  .option('--no-open', 'Do not auto-open browser')
  .action(runStart);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Write `src/cli/dev.ts`**

Write `packages/zai/src/cli/dev.ts`:
```ts
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';

interface DevOptions {
  port: string;
  apiPort: string;
  open: boolean;
}

export async function runDev(options: DevOptions) {
  const apiPort = Number.parseInt(options.apiPort, 10);
  const vitePort = options.port;
  const token = randomBytes(16).toString('hex');

  console.log(`[zai] dev token: ${token}`);

  // 1. Start Express
  const app = createApp({ token });
  const server = app.listen(apiPort, () => {
    console.log(`[zai] API server on http://localhost:${apiPort}`);
  });

  // 2. Start Vite
  const vite = spawn('vite', ['--port', vitePort], {
    cwd: new URL('../web/', import.meta.url).pathname,
    stdio: 'inherit',
  });

  // 3. Auto-open browser
  if (options.open) {
    setTimeout(() => {
      spawn('open', [`http://localhost:${vitePort}`], { stdio: 'ignore' });
    }, 2000);
  }

  // 4. Cleanup on SIGINT
  const cleanup = () => {
    vite.kill('SIGTERM');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
```

- [ ] **Step 3: Write `src/cli/start.ts`**

Write `packages/zai/src/cli/start.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';
import express from 'express';

interface StartOptions {
  port: string;
  open: boolean;
}

export async function runStart(options: StartOptions) {
  const port = Number.parseInt(options.port, 10);
  const token = randomBytes(16).toString('hex');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDir = join(__dirname, '..', 'web');

  if (!existsSync(webDir)) {
    console.error(`[zai] dist/web not found. Run 'npm run build:web' first.`);
    process.exit(1);
  }

  console.log(`[zai] start token: ${token}`);

  const app = createApp({ token });
  app.use(express.static(webDir));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(webDir, 'index.html'));
  });

  app.listen(port, () => {
    console.log(`[zai] Production server on http://localhost:${port}`);
    if (options.open) {
      spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' });
    }
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/cli
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add CLI dev and start commands"
```

---

## Task 11: Frontend scaffold — Vite + React + Tailwind + Antd + Router

**Files:**
- Create: `packages/zai/vite.config.ts`
- Create: `packages/zai/tailwind.config.ts`
- Create: `packages/zai/postcss.config.js`
- Create: `packages/zai/src/web/index.html`
- Create: `packages/zai/src/web/src/main.tsx`
- Create: `packages/zai/src/web/src/App.tsx`
- Create: `packages/zai/src/web/src/router.tsx`
- Create: `packages/zai/src/web/src/lib/api.ts`
- Create: `packages/zai/src/web/src/lib/sse.ts`
- Create: `packages/zai/src/web/src/store/useAppStore.ts`

**Interfaces:**
- Consumes: shared types via path alias `@shared/*`
- Produces: working Vite dev server with `zai dev` (frontend only initially)

- [ ] **Step 1: Write `vite.config.ts`**

Write `packages/zai/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'src', 'web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src', 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:7715',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist', 'web'),
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Write `tailwind.config.ts`**

Write `packages/zai/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/web/src/**/*.{ts,tsx}', './src/web/index.html'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 3: Write `postcss.config.js`**

Write `packages/zai/postcss.config.js`:
```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 4: Write `src/web/index.html`**

Write `packages/zai/src/web/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>知鸟AI 平台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `src/web/src/main.tsx`**

Write `packages/zai/src/web/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Write `src/web/src/App.tsx`**

Write `packages/zai/src/web/src/App.tsx`:
```tsx
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppRouter from './router';

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ConfigProvider>
  );
}
```

- [ ] **Step 7: Write `src/web/src/router.tsx`**

Write `packages/zai/src/web/src/router.tsx`:
```tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Tools from './pages/Tools';
import Resources from './pages/Resources';
import Login from './pages/Login';
import Config from './pages/Config';
import Directory from './pages/Directory';

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/tools" element={<Tools />} />
      <Route path="/resources" element={<Resources />} />
      <Route path="/login" element={<Login />} />
      <Route path="/config" element={<Config />} />
      <Route path="/dirs" element={<Directory />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 8: Write `src/web/src/lib/api.ts`**

Write `packages/zai/src/web/src/lib/api.ts`:
```ts
const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
```

- [ ] **Step 9: Write `src/web/src/lib/sse.ts`**

Write `packages/zai/src/web/src/lib/sse.ts`:
```ts
import type { SseEvent } from '@shared/types';

export function useSse(
  url: string,
  onEvent: (ev: SseEvent) => void,
  onEnd?: () => void,
): () => void {
  const source = new EventSource(url, { withCredentials: true });
  source.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as SseEvent;
      onEvent(ev);
      if (ev.type === 'exit' || ev.type === 'error') {
        source.close();
        onEnd?.();
      }
    } catch {}
  };
  source.onerror = () => {
    source.close();
    onEnd?.();
  };
  return () => source.close();
}
```

- [ ] **Step 10: Write `src/web/src/store/useAppStore.ts`**

Write `packages/zai/src/web/src/store/useAppStore.ts`:
```ts
import { create } from 'zustand';

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: localStorage.getItem('zai-sidebar-collapsed') === 'true',
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      localStorage.setItem('zai-sidebar-collapsed', String(next));
      return { sidebarCollapsed: next };
    }),
}));
```

- [ ] **Step 11: Create empty page stubs**

Create minimal stubs for all pages (Dashboard, Tools, Resources, Login, Config, Directory) so the router compiles. Each file should export a default component that renders `<div>PageName (stub)</div>`.

- [ ] **Step 12: Commit**

```bash
git add packages/zai/vite.config.ts packages/zai/tailwind.config.ts packages/zai/postcss.config.js packages/zai/src/web
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): scaffold Vite + React + Tailwind + Antd frontend"
```

---

## Task 12: Frontend Layout + LogPanel

**Files:**
- Create: `packages/zai/src/web/src/components/Layout.tsx`
- Create: `packages/zai/src/web/src/components/LogPanel.tsx`
- Create: `packages/zai/src/web/src/components/StatusDot.tsx`
- Create: `packages/zai/src/web/src/components/ConfirmButton.tsx`

**Interfaces:**
- `Layout`: antd Layout with Sider + Header + Content, renders `<Outlet />`
- `LogPanel`: Drawer with virtualized log lines, accepts `events: SseEvent[]` + `onCancel`
- `StatusDot`: green/red/gray dot based on `installed` boolean
- `ConfirmButton`: Button with Modal confirm

- [ ] **Step 1: Write components (implementation details per component)**

Implement each component with full TypeScript + Tailwind + Antd. Details omitted for brevity (each file ~50-100 lines).

- [ ] **Step 2: Commit**

```bash
git add packages/zai/src/web/src/components
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add Layout, LogPanel, StatusDot, ConfirmButton components"
```

---

## Task 13: Frontend pages — Dashboard + Tools

**Files:**
- Modify: `packages/zai/src/web/src/pages/Dashboard.tsx`
- Modify: `packages/zai/src/web/src/pages/Tools.tsx`

**Interfaces:**
- `Dashboard`: fetches `/api/system` + `/api/cli` on mount, renders 4 status cards + quickstart button
- `Tools`: table with CLI status + install/upgrade button per row

- [ ] **Step 1: Implement Dashboard**

Full implementation with antd Card, Statistic, Spin, Button.

- [ ] **Step 2: Implement Tools**

Full implementation with antd Table, Button, message notification.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/pages/Dashboard.tsx packages/zai/src/web/src/pages/Tools.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): implement Dashboard and Tools pages"
```

---

## Task 14: Frontend pages — Resources + Login + Config + Directory

**Files:**
- Modify: `packages/zai/src/web/src/pages/Resources.tsx`
- Modify: `packages/zai/src/web/src/pages/Login.tsx`
- Modify: `packages/zai/src/web/src/pages/Config.tsx`
- Modify: `packages/zai/src/web/src/pages/Directory.tsx`

**Interfaces:**
- `Resources`: Tabs for skills/commands/extensions/agents; list + install button per item
- `Login`: 3 buttons (PA / OpenPlatform / OpenPlatform-stg) that POST /api/login/:type
- `Config`: Tabs per tool; antd Form with known env fields + JSON preview; save button
- `Directory`: Tree view of ~/.nova etc. with counts

- [ ] **Step 1-4: Implement each page**

Full implementations.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/pages
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): implement Resources, Login, Config, Directory pages"
```

---

## Task 15: Integration test + end-to-end smoke

**Files:**
- Modify: `packages/zai/package.json` (add `test:e2e` script)

**Interfaces:**
- Manual smoke test: `pnpm build && pnpm start` → browser opens → verify all pages load

- [ ] **Step 1: Run build**

```bash
cd packages/zai
pnpm build
```

- [ ] **Step 2: Start production server**

```bash
pnpm start
```

- [ ] **Step 3: Verify pages**

Open `http://localhost:7715` in browser, click through each menu item.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): integration smoke test complete"
```

---

## Self-Review Checklist

After completing all tasks, verify:
- [ ] `pnpm build` succeeds without errors
- [ ] `pnpm test` passes all tests
- [ ] `zai dev` spawns both Vite + Express, opens browser
- [ ] `zai start` serves static SPA + API on port 7715
- [ ] All 6 pages render correctly in browser
- [ ] LogPanel shows SSE events for install commands
- [ ] Config editor saves and reloads settings.json
