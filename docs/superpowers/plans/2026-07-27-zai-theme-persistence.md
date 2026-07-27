# zai Theme 持久化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `useAppStore.settingsTheme` 持久化到 `~/.zai/settings.json`,沿用 `outputStyle` / `maxVisibleMessages` 的服务端路径,4 档全支持。

**Architecture:** 客户端 `Layout` mount 一次性 GET `/api/agent/settings` hydrate 进 store;SettingsDrawer 切主题时同步 PUT `/api/agent/settings/theme`。服务端 validation 镜像 `isValidOutputStyle`,未知值折叠为 `'auto'` 兜底。

**Tech Stack:** TypeScript · Express · zustand · AntD · vitest · supertest

## Global Constraints

- 持久化字段写在 `ZaiSettings` 接口(`packages/zai/src/shared/settings.ts`),可选字段
- 4 档:`'auto' | 'dark' | 'light' | 'high-contrast'`,服务端持久化原值,UI 渲染仍把 `high-contrast` 映射回 `auto` 显示
- 不动 `BUILTIN_DEFAULT_SETTINGS`(沿用 `outputStyle` 不写的做法 — settings 缺失由 `resolveTheme()` 兜底 `'auto'`)
- 所有 server-side 路径使用 atomic write(tmp + rename),见 `zaiSettingsStore.writeZaiSettings()`
- 测试用 `mkdtempSync` + `process.env.ZAI_DATA_DIR/HOME` 隔离临时目录,`__resetCacheForTests` 重置 cache
- TypeScript 严格模式,所有 export 显式标 `Theme` 类型
- commit message 格式:`HRMSV3-ZN-WEBSITE#668 <type>(<scope>): <desc>`,scope 限定 `zai` / `zai-web`

---

## 文件结构

| 文件 | 状态 | 职责 |
|------|------|------|
| `packages/zai/src/shared/settings.ts` | Modify | 加 `Theme` 类型 + `ZaiSettings.theme?` 字段 |
| `packages/zai/src/server/services/zaiSettingsStore.ts` | Modify | 加 `VALID_THEMES` Set + `resolveTheme()` + `isValidTheme()` |
| `packages/zai/src/server/routes/agentSettings.ts` | Modify | GET 响应加 `theme` + 新增 `PUT /agent/settings/theme` |
| `packages/zai/src/web/src/store/useAppStore.ts` | Modify | 注释清理(不动字段/类型) |
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | Modify | `handleChange` 里 `theme` 走 PUT |
| `packages/zai/src/web/src/components/Layout.tsx` | Modify | mount effect hydrate `theme` |
| `packages/zai/test/server/agentSettings-theme.test.ts` | Create | 6 个 vitest 用例(见 Task 1) |

---

### Task 1: 共享层加 `Theme` 类型 + `ZaiSettings.theme?`

**Files:**
- Modify: `packages/zai/src/shared/settings.ts:49-67`

**Interfaces:**
- Consumes: 无
- Produces: `type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'`(后续 task 引用此名);`ZaiSettings.theme?: Theme`

- [ ] **Step 1: 在 `settings.ts` 加 `Theme` 类型和字段**

打开 `packages/zai/src/shared/settings.ts`。在 `OutputStyle` 类型别名(line 49)下方插入:

```typescript
/**
 * 用户主题偏好. 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统
 * prefers-color-scheme,见 packages/zai/src/web/src/hooks/useEffectiveTheme.ts.
 *
 * 持久化到 ~/.zai/settings.json(settings.theme),见 docs/superpowers/specs/
 * 2026-07-27-zai-theme-persistence-design.md.
 */
export type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'
```

在 `ZaiSettings` 接口内(line 66 之后),`maxVisibleMessages?` 字段之后加:

```typescript
  /**
   * Web UI 主题偏好 — see Theme. 持久化到 ~/.zai/settings.json.
   * 缺失 / 未知值由 resolveTheme() 折叠为 'auto'.
   */
  theme?: Theme
```

- [ ] **Step 2: 跑 typecheck 确认**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors(只新增类型/字段,无消费者)。

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/shared/settings.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): add Theme type + ZaiSettings.theme field"
```

---

### Task 2: server validation helpers

**Files:**
- Modify: `packages/zai/src/server/services/zaiSettingsStore.ts:47-69`

**Interfaces:**
- Consumes: `Theme` from `../../shared/settings.js`(Task 1)
- Produces: `VALID_THEMES: ReadonlySet<Theme>`;`resolveTheme(settings: ZaiSettings): Theme`;`isValidTheme(value: unknown): value is Theme`(后续 task 引用)

- [ ] **Step 1: 加 imports**

打开 `packages/zai/src/server/services/zaiSettingsStore.ts:4`,把:

```typescript
import type { OutputStyle, ZaiSettings } from '../../shared/settings.js'
```

改成:

```typescript
import type { OutputStyle, Theme, ZaiSettings } from '../../shared/settings.js'
```

- [ ] **Step 2: 在 line 69 之后追加 helpers**

在 `isValidOutputStyle` 函数(line 67-69)之后追加:

```typescript
const VALID_THEMES: ReadonlySet<Theme> = new Set<Theme>([
  'auto',
  'dark',
  'light',
  'high-contrast',
])

/**
 * Resolve the persisted theme with validation. Unknown / missing values
 * collapse to 'auto' so a hand-edited settings.json can never leave the
 * UI stuck in an unrenderable state. Mirrors resolveOutputStyle().
 */
export function resolveTheme(settings: ZaiSettings): Theme {
  const candidate = settings.theme
  if (typeof candidate === 'string' && VALID_THEMES.has(candidate as Theme)) {
    return candidate as Theme
  }
  return 'auto'
}

/** Validate a candidate theme value before persisting. */
export function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && VALID_THEMES.has(value as Theme)
}
```

- [ ] **Step 3: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/server/services/zaiSettingsStore.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-server): add resolveTheme + isValidTheme"
```

---

### Task 3: server 路由 PUT + GET 暴露

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts:1-15, 116-139, 152-167`

**Interfaces:**
- Consumes: `Theme` from `../../shared/settings.js`(Task 1);`isValidTheme` / `resolveTheme` from `zaiSettingsStore.js`(Task 2)
- Produces: `PUT /api/agent/settings/theme` 接收 `{ theme: Theme }` 落盘,无效值 400;`GET /api/agent/settings` 响应新增 `theme: Theme`

- [ ] **Step 1: 扩 imports**

打开 `packages/zai/src/server/routes/agentSettings.ts:6`,把:

```typescript
import type { ModelEntry, OutputStyle, ZaiSettings } from '../../shared/settings.js'
```

改成:

```typescript
import type { ModelEntry, OutputStyle, Theme, ZaiSettings } from '../../shared/settings.js'
```

打开 `packages/zai/src/server/routes/agentSettings.ts:10-15`,把:

```typescript
import {
  isValidOutputStyle,
  readZaiSettings,
  resolveOutputStyle,
  writeZaiSettings,
} from '../services/zaiSettingsStore.js'
```

改成:

```typescript
import {
  isValidOutputStyle,
  isValidTheme,
  readZaiSettings,
  resolveOutputStyle,
  resolveTheme,
  writeZaiSettings,
} from '../services/zaiSettingsStore.js'
```

- [ ] **Step 2: GET 响应加 theme 字段**

在 `router.get('/agent/settings', ...)` handler 内(line 116-139),找到 line 123 之后 `const outputStyle = resolveOutputStyle(settings)`,在它后面加:

```typescript
    const theme = resolveTheme(settings)
```

把 `res.json({...})`(line 128-135)改成:

```typescript
    res.json({
      defaultModel,
      baseURL,
      models,
      defaultMode: getDefaultMode(),
      outputStyle,
      theme,
      maxVisibleMessages,
    })
```

- [ ] **Step 3: 加 PUT /agent/settings/theme handler**

在 `PUT /agent/settings/output-style` handler 之后(line 152-167)、`PUT /agent/settings/max-visible-messages` handler 之前(line 177),插入:

```typescript
/**
 * PUT /api/agent/settings/theme — persist the web UI's theme preference.
 * Body is `{ theme: 'auto' | 'dark' | 'light' | 'high-contrast' }`. The
 * server validates the value and round-trips the existing settings.json
 * (other fields preserved).
 *
 * Used by SettingsDrawer when the user changes the "主题" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put('/agent/settings/theme', async (req: Request, res: Response) => {
  const candidate = (req.body as { theme?: unknown } | undefined)?.theme
  if (!isValidTheme(candidate)) {
    return res.status(400).json({ error: `invalid theme: ${String(candidate)}` })
  }
  try {
    const settings = await readZaiSettings()
    const next: ZaiSettings = { ...settings, theme: candidate as Theme }
    await writeZaiSettings(next)
    res.json({ theme: next.theme })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 4: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/agentSettings.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-server): PUT /api/agent/settings/theme + GET exposes theme"
```

---

### Task 4: 服务端单元测试

**Files:**
- Create: `packages/zai/test/server/agentSettings-theme.test.ts`

**Interfaces:**
- Consumes: `agentSettings` router(Task 3)、`__resetCacheForTests`(已有)
- Produces: vitest 用例,覆盖 PUT 4 档 / 无效 400 / GET 兜底 'auto' / round-trip 保留其它字段

- [ ] **Step 1: 创建测试文件**

新建 `packages/zai/test/server/agentSettings-theme.test.ts`,内容如下(镜像 `agentSettings-max-visible-messages.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 把 ZAI_DATA_DIR / HOME 隔离到一个临时目录, 避免污染真实 ~/.zai/settings.json
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-theme-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  // 重置 in-process cache + 重新 import router, 让每个 test 拿到全新模块实例
  const { __resetCacheForTests } = await import(
    '../../src/server/services/zaiSettingsCache.js'
  )
  __resetCacheForTests()
  const { default: agentSettingsRouter } = await import(
    '../../src/server/routes/agentSettings.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'test' }
  app.use('/api', agentSettingsRouter)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('PUT /api/agent/settings/theme', () => {
  it('persists dark theme and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'dark' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ theme: 'dark' })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.theme).toBe('dark')
  })

  it('persists high-contrast theme (4 档全支持)', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'high-contrast' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ theme: 'high-contrast' })
  })

  it('rejects invalid theme with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'rainbow' })
    expect(res.status).toBe(400)
  })

  it('rejects missing theme field with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({})
    expect(res.status).toBe(400)
  })

  it('preserves other settings fields (outputStyle + maxVisibleMessages)', async () => {
    // 先 PUT 一条 outputStyle + maxVisibleMessages
    await request(app)
      .put('/api/agent/settings/output-style')
      .send({ outputStyle: 'compact' })
    await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 50 })
    // 再 PUT theme
    await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'light' })

    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.theme).toBe('light')
    expect(onDisk.outputStyle).toBe('compact')
    expect(onDisk.maxVisibleMessages).toBe(50)
  })
})

describe('GET /api/agent/settings returns theme', () => {
  it('returns persisted theme', async () => {
    await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'dark' })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('dark')
  })

  it('defaults to auto when settings.json has no theme', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('auto')
  })

  it('defaults to auto when settings.json theme is unknown (兜底)', async () => {
    // 直接写一个垃圾值到磁盘
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = join(dataDir, '.zai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ theme: 'rainbow' }),
      'utf-8',
    )
    // 重置 cache 让它重新读
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()

    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('auto')
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `cd packages/zai && pnpm test test/server/agentSettings-theme.test.ts`
Expected: 9 tests pass(5 PUT + 3 GET theme + 1 unknown-兜底 = 9 个 it)。

- [ ] **Step 3: 跑全部 server 测试确认没回归**

Run: `cd packages/zai && pnpm test test/server/`
Expected: 全部通过,无回归(`agentSettings-max-visible-messages.test.ts` 8 个 case + 新加 9 个 case + 其它不动)。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/test/server/agentSettings-theme.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 test(zai-server): cover PUT theme + GET resolveTheme"
```

---

### Task 5: 前端 store 注释清理

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts:68-72`

**Interfaces:**
- Consumes: 现有 `settingsTheme` / `setSettingsTheme`(不动)
- Produces: 更准确的 JSDoc,反映"已持久化"语义

- [ ] **Step 1: 替换注释**

打开 `packages/zai/src/web/src/store/useAppStore.ts:68-72`,把:

```typescript
  // Theme 仅前端暂存(SPEC 阶段 1:不持久化),刷新/重开 Drawer 后还原为 'auto'.
  // 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统 prefers-color-scheme.
  // 持久化与高对比度真实主题实现见后续 phase.
  // 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';
```

改成:

```typescript
  /**
   * Web UI 主题偏好 — 持久化到 ~/.zai/settings.json(settings.theme).
   * Layout mount 时一次性 GET /api/agent/settings hydrate;SettingsDrawer 切主题
   * 时同步 PUT settings.json,失败 swallow(下次启动仍可重写).
   *
   * 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统
   * prefers-color-scheme,见 packages/zai/src/web/src/hooks/useEffectiveTheme.ts.
   *
   * 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
   */
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';
```

- [ ] **Step 2: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 docs(zai-web): update settingsTheme JSDoc for persistence"
```

---

### Task 6: SettingsDrawer PUT 切主题

**Files:**
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx:775-832`

**Interfaces:**
- Consumes: `Theme` from `../../../shared/settings.js`(Task 1)
- Produces: 切换主题时 `setTheme(next)` + fire-and-forget `PUT /api/agent/settings/theme` body `{ theme: next }`,失败 swallow

- [ ] **Step 1: 扩 imports**

打开 `packages/zai/src/web/src/components/SettingsDrawer.tsx` 顶部,找 `OutputStyle` 导入行(参考 line 18 `import type { OutputStyle } from '../../../shared/settings.js'` 之类),在同源加 `Theme` 的导入。改成:

```typescript
import type { OutputStyle, Theme } from '../../../shared/settings.js'
```

(若当前文件已经有 `import type { Theme } from '...'` 或本地 `type Theme = 'auto' | ...'` 定义 — 见 line 570 — 则**不重复 import**,直接用本地 `Theme` 类型。本地类型与共享 `Theme` 等价,继续用本地 `Theme` 不破坏类型一致性。优先复用本地定义,不引入新 import。)

- [ ] **Step 2: handleChange 里 theme 走 PUT**

打开 `packages/zai/src/web/src/components/SettingsDrawer.tsx:775-832`,在 `handleChange` 内 `if (key === 'theme' && typeof value === 'string')` 块(line 778-780):

```typescript
      // 主题行直接写回 store(阶段 1 不持久化,只 frontend state)
      if (key === 'theme' && typeof value === 'string') {
        setTheme(value as Theme)
      }
```

改成:

```typescript
      // 主题行走完整持久化路径:写 store 让 useEffectiveTheme() 立即生效,
      // 同时 PUT settings.json 跨刷新保存.失败不打断 UI(下次启动仍可重写).
      if (key === 'theme' && typeof value === 'string') {
        const next = value as Theme
        setTheme(next)
        void fetch('/api/agent/settings/theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: next }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
```

- [ ] **Step 3: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): SettingsDrawer PUT theme on change"
```

---

### Task 7: Layout mount hydrate theme

**Files:**
- Modify: `packages/zai/src/web/src/components/Layout.tsx:39, 82-110`

**Interfaces:**
- Consumes: `Theme` from `../../shared/settings.js`(Task 1);`setSettingsTheme` from `useAppStore`(已有)
- Produces: mount effect 拿到 `data.theme` 后 `setSettingsTheme(value)`(无效值不动 store)

- [ ] **Step 1: 扩 imports**

打开 `packages/zai/src/web/src/components/Layout.tsx:18`,把:

```typescript
import type { OutputStyle } from '../../shared/settings.js';
```

改成:

```typescript
import type { OutputStyle, Theme } from '../../shared/settings.js';
```

- [ ] **Step 2: destructure 加 setSettingsTheme**

打开 `packages/zai/src/web/src/components/Layout.tsx:39`,把:

```typescript
  const { sidebarCollapsed, toggleSidebar, setInstanceContext, setOutputStyle, setMaxVisibleMessages } = useAppStore();
```

改成:

```typescript
  const { sidebarCollapsed, toggleSidebar, setInstanceContext, setSettingsTheme, setOutputStyle, setMaxVisibleMessages } = useAppStore();
```

- [ ] **Step 3: hydrate effect 加 theme 分支**

打开 `packages/zai/src/web/src/components/Layout.tsx:82-110`(mount effect)。把:

```typescript
  useEffect(() => {
    let cancelled = false
    api
      .get<{ outputStyle?: OutputStyle; maxVisibleMessages?: number }>('/agent/settings')
      .then((data) => {
        if (cancelled) return
        if (
          data.outputStyle === 'default' ||
          data.outputStyle === 'compact' ||
          data.outputStyle === 'verbose'
        ) {
          setOutputStyle(data.outputStyle)
          setTranscriptCollapsed(data.outputStyle === 'compact')
        }
        if (typeof data.maxVisibleMessages === 'number') {
          // Mirror server-side clamp from settings/max-visible-messages PUT handler
          // so a tampered settings.json can't break the UI with a 0/negative/NaN.
          setMaxVisibleMessages(
            Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))),
          )
        }
      })
      .catch(() => {
        // swallow — keep default
      })
    return () => {
      cancelled = true
    }
  }, [setOutputStyle, setMaxVisibleMessages, setTranscriptCollapsed]);
```

改成:

```typescript
  useEffect(() => {
    let cancelled = false
    api
      .get<{ outputStyle?: OutputStyle; theme?: Theme; maxVisibleMessages?: number }>(
        '/agent/settings',
      )
      .then((data) => {
        if (cancelled) return
        if (
          data.outputStyle === 'default' ||
          data.outputStyle === 'compact' ||
          data.outputStyle === 'verbose'
        ) {
          setOutputStyle(data.outputStyle)
          setTranscriptCollapsed(data.outputStyle === 'compact')
        }
        // hydrate 主题:服务端已在 GET handler 走 resolveTheme() 把未知值折叠为 'auto',
        // 这里 4 档白名单校验是防御层(防 cache stale / transport 异常).
        if (
          data.theme === 'auto' ||
          data.theme === 'dark' ||
          data.theme === 'light' ||
          data.theme === 'high-contrast'
        ) {
          setSettingsTheme(data.theme)
        }
        if (typeof data.maxVisibleMessages === 'number') {
          // Mirror server-side clamp from settings/max-visible-messages PUT handler
          // so a tampered settings.json can't break the UI with a 0/negative/NaN.
          setMaxVisibleMessages(
            Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))),
          )
        }
      })
      .catch(() => {
        // swallow — keep default
      })
    return () => {
      cancelled = true
    }
  }, [setOutputStyle, setSettingsTheme, setMaxVisibleMessages, setTranscriptCollapsed]);
```

- [ ] **Step 4: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/Layout.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): Layout hydrate theme from GET /agent/settings"
```

---

### Task 8: 全量验证

**Files:** 无新文件

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm -r typecheck` (从 repo 根)
Expected: 0 errors。

- [ ] **Step 2: 全量测试**

Run: `pnpm -r test`
Expected: 全部通过(`packages/zai` 28+ files / 200+ tests + 9 new theme tests = pass)。

- [ ] **Step 3: lint**

Run: `pnpm -r lint`(若脚本存在)
Expected: 0 errors。若 lint 脚本不存在,跳过。

- [ ] **Step 4: 手动烟测**

启动 dev server:

```bash
cd packages/zai && pnpm dev
```

- 打开设置 → 切 Dark → 看 `<html data-theme="dark">`
- 浏览器刷新 → 仍是 Dark(磁盘 ~/.zai/settings.json.theme === 'dark')
- 切回 Auto → 刷新 → Auto
- 切 High contrast → 刷新 → useEffectiveTheme 走 system 解析(行为不变)
- `cat ~/.zai/settings.json` 确认字段存在

- [ ] **Step 5: 最终提交(若前 7 步都已 commit,此步空跑;否则 amend 修复)**

```bash
git log --oneline -10
# 确认 7 个新 commit + 1 个 spec commit = 8 个新提交
```