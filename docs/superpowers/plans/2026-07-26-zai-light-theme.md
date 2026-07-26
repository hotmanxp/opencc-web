# zai 白色主题与主题切换(阶段 1)— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 light / dark / auto 三档主题即时切换(auto 跟随系统 `prefers-color-scheme`),并在 Settings 面板已有的 Theme 选项中真正生效。

**Architecture:** 三层 — `useAppStore.settingsTheme`(state,已存在)→ `useEffectiveTheme()` 解析层(新增,综合 setting + matchMedia)→ `App.tsx` 应用层(写 `documentElement.dataset.theme` + AntD `ConfigProvider.algorithm/token`)。CSS 变量在 `index.css` 中按 `[data-theme]` 选择器拆 dark/light 两套。

**Tech Stack:** React 18、Zustand 4、AntD 5(`ConfigProvider` + `theme.darkAlgorithm`/`defaultAlgorithm`)、`matchMedia('(prefers-color-scheme: dark)')`、Vitest 4 + happy-dom + `@testing-library/react`、`packages/zai` workspace(`pnpm --filter zai test`)。

## Global Constraints

- **范围**:阶段 1,light/dark/auto 即时切换。**不**做持久化(`localStorage` / `~/.zai/settings.json` / server 端点)——刷新后回到默认 `auto`。
- **store 契约冻结**:`useAppStore.settingsTheme` 类型 `'auto' | 'dark' | 'light' | 'high-contrast'`、`setSettingsTheme` setter、`'auto'` 默认值一律不动。`SettingsDrawer.test.tsx` 与 `SettingsButton.test.tsx` 回归测试必须保持绿。
- **已知 YAGNI 限制**(AC 接受,不动):
  - `<Layout>` 边栏 `<Menu theme="dark">` 继续暗色。
  - CodeMirror 编辑器继续暗色。
  - `high-contrast` 选项 UI 沿用 `SettingsDrawer.tsx:634` 现状(映射回 `'auto'`)。
  - 剩余 ~85 处分散内联硬编码颜色不在本期范围(本 plan 只动 `QuestionCard` / `TaskDock` / `TaskDrawer` / `MessageBubble`)。
- **AntD 主色**(`#ff6600`)不变。
- **Node ≥ 20**(per `package.json` engines)。

---

## File Structure(plan 总览)

| 文件 | 角色 | 任务 |
|---|---|---|
| `packages/zai/src/web/src/hooks/useEffectiveTheme.ts` | 新增:解析层 hook | Task 1 |
| `packages/zai/src/web/src/hooks/useEffectiveTheme.test.ts` | 新增:7 个单测 | Task 1 |
| `packages/zai/src/web/src/index.css` | 修改:`:root[data-theme='light']` 覆盖块(16 变量 light 套)+ `color-scheme` | Task 2 |
| `packages/zai/src/web/src/App.tsx` | 修改:`ConfigProvider` 改为受控 + 写 `documentElement.dataset.theme` | Task 3 |
| `packages/zai/src/web/src/App.test.tsx` | 新增:3 个 smoke 用例 | Task 3 |
| `packages/zai/src/web/src/components/QuestionCard.tsx` | 修改:14 处硬编码颜色 → CSS 变量 | Task 4 |
| `packages/zai/src/web/src/components/TaskDock.tsx` | 修改:~13 处硬编码颜色 → CSS 变量 | Task 5 |
| `packages/zai/src/web/src/components/TaskDrawer.tsx` | 修改:~13 处硬编码颜色 → CSS 变量 | Task 6 |
| `packages/zai/src/web/src/components/transcript/MessageBubble.tsx` | 修改:~9 处硬编码颜色 → CSS 变量 | Task 7 |
| `packages/zai/src/web/src/store/useAppStore.ts` | 修改:注释更新(`'auto 跟随系统'` 加入) | Task 8 |
| 全量测试 + typecheck | — | Task 8 |

---

### Task 1: 新增 `useEffectiveTheme` hook + 7 个单测

**Files:**
- Create: `packages/zai/src/web/src/hooks/useEffectiveTheme.ts`
- Create: `packages/zai/src/web/src/hooks/useEffectiveTheme.test.ts`

**Interfaces:**
- Consumes: `useAppStore` 的 `settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast'`(`packages/zai/src/web/src/store/useAppStore.ts:69`)
- Produces: `export function useEffectiveTheme(): 'dark' | 'light'`(同模块唯一导出)

- [ ] **Step 1: 写失败的测试**

在 `packages/zai/src/web/src/hooks/useEffectiveTheme.test.ts`(新建)写入:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEffectiveTheme } from './useEffectiveTheme.js'
import { useAppStore } from '../store/useAppStore.js'

type Listener = (e: MediaQueryListEvent) => void

function mockMatchMedia(matches: boolean) {
  const listeners: Listener[] = []
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: 'change', cb: Listener) => { listeners.push(cb) },
    removeEventListener: (_: 'change', cb: Listener) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    addListener: (cb: Listener) => { listeners.push(cb) },
    removeListener: (cb: Listener) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql)
  return { mql, fire: (next: boolean) => listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent)) }
}

describe('useEffectiveTheme', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsTheme: 'auto' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns dark for settingsTheme=dark regardless of system', () => {
    mockMatchMedia(false)
    useAppStore.setState({ settingsTheme: 'dark' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
  })

  it('returns light for settingsTheme=light regardless of system', () => {
    mockMatchMedia(true)
    useAppStore.setState({ settingsTheme: 'light' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('auto + system dark → dark', () => {
    mockMatchMedia(true)
    useAppStore.setState({ settingsTheme: 'auto' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
  })

  it('auto + system light → light', () => {
    mockMatchMedia(false)
    useAppStore.setState({ settingsTheme: 'auto' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('high-contrast follows auto semantics (system light → light)', () => {
    mockMatchMedia(false)
    useAppStore.setState({ settingsTheme: 'high-contrast' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('falls back to dark when matchMedia is unavailable', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('matchMedia not supported')
    })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
  })

  it('reacts to system change while auto', () => {
    const { fire } = mockMatchMedia(true)
    useAppStore.setState({ settingsTheme: 'auto' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
    act(() => { fire(false) })
    expect(result.current).toBe('light')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/hooks/useEffectiveTheme.test.ts
```
Expected: FAIL with `Failed to resolve import "./useEffectiveTheme.js"`。

- [ ] **Step 3: 实现 hook**

在 `packages/zai/src/web/src/hooks/useEffectiveTheme.ts`(新建)写入:

```ts
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'

export type EffectiveTheme = 'dark' | 'light'

/**
 * 解析 `useAppStore.settingsTheme` 为最终渲染档位:
 * - 'dark' / 'light' → 直接返回
 * - 'auto' / 'high-contrast' → 跟随 `prefers-color-scheme: dark`
 *
 * 行为:
 * - matchMedia 不可用时降级到 'dark'
 * - 监听 matchMedia change 事件,系统主题变化时同步更新返回值
 * - SSR-safe: window 缺失时早返回 'dark'
 */
export function useEffectiveTheme(): EffectiveTheme {
  const setting = useAppStore((s) => s.settingsTheme)
  const [resolved, setResolved] = useState<EffectiveTheme>('dark')

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setResolved('dark')
      return
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (next: boolean) => setResolved(next ? 'dark' : 'light')

    if (setting === 'dark' || setting === 'light') {
      setResolved(setting)
      return
    }
    // 'auto' / 'high-contrast' → 跟随系统
    apply(mql.matches)
    const handler = (e: MediaQueryListEvent) => apply(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [setting])

  return resolved
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/hooks/useEffectiveTheme.test.ts
```
Expected: 7 passed。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/hooks/useEffectiveTheme.ts packages/zai/src/web/src/hooks/useEffectiveTheme.test.ts
git commit -m "feat(web): add useEffectiveTheme hook resolving auto via matchMedia"
```

---

### Task 2: `index.css` 增加 light 套 CSS 变量覆盖

**Files:**
- Modify: `packages/zai/src/web/src/index.css`(第 1-21 行的 `:root { ... }` 不动;在后面追加 `:root[data-theme='light'] { ... }` 覆盖块 + `color-scheme` 声明)

**Interfaces:**
- Consumes: 已存在的 16 个 CSS 变量名(`--bg-body`, `--bg-card`, `--bg-card-hover`, `--bg-sidebar`, `--bg-input`, `--border-subtle`, `--border-active`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--accent-start`, `--accent-end`, `--glow`, `--success`, `--error`, `--warning`),以及 `.question-card-scope` 命名空间内已有的浅色样式(`index.css:193-256`)
- Produces: `:root[data-theme='light']` 选择器命中后所有 16 变量切到 light 套;`color-scheme: light dark` 让浏览器原生控件跟随

- [ ] **Step 1: 在 `index.css` 第 21 行后追加 light 覆盖块 + color-scheme**

读取当前 `packages/zai/src/web/src/index.css`,确认第 21 行是 `:root { ... }` 的结束 `}`。在 `}` 之后(`* { margin: 0; padding: 0; box-sizing: border-box; }` 之前)追加:

```css
:root { color-scheme: light dark; }

:root[data-theme='light'] {
  --bg-body: #f8fafc;
  --bg-card: #ffffff;
  --bg-card-hover: #f1f5f9;
  --bg-sidebar: #f1f5f9;
  --bg-input: #ffffff;
  --border-subtle: rgba(15, 23, 42, 0.10);
  --border-active: rgba(255, 102, 0, 0.50);
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-tertiary: #94a3b8;
  --accent-start: #ff6600;
  --accent-end: #ff8533;
  --glow: rgba(255, 102, 0, 0.12);
  --success: #16a34a;
  --error: #dc2626;
  --warning: #d97706;
}

/* light 主题下, 半透明 header 需要更亮一些 */
:root[data-theme='light'] .ant-layout-header {
  background: rgba(255, 255, 255, 0.8) !important;
}
:root[data-theme='light'] .ant-table-tbody > tr > td {
  border-bottom-color: rgba(15, 23, 42, 0.05) !important;
}
:root[data-theme='light'] .ant-list-item {
  border-bottom-color: rgba(15, 23, 42, 0.05) !important;
}
:root[data-theme='light'] [data-testid="fs-tree"] .ant-tree-node-selected {
  background: rgba(255, 102, 0, 0.12) !important;
}
```

**不要**触碰 `.question-card-scope`(第 193-256 行):它已经按浅色卡片 + 深色文字设计,在 dark/light 全局下都成立。

- [ ] **Step 2: 跑既有 `SettingsDrawer` / `Layout` 测试 + typecheck**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/SettingsDrawer.test.tsx && pnpm typecheck
```
Expected:既有测试全绿;typecheck 无新增错误。

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/index.css
git commit -m "feat(web): add light theme CSS variable override block"
```

---

### Task 3: `App.tsx` 接入 hook + 新建 `App.test.tsx`

**Files:**
- Modify: `packages/zai/src/web/src/App.tsx`(整个 32 行文件重写为受控组件)
- Create: `packages/zai/src/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `useEffectiveTheme()`(Task 1)、`useAppStore.settingsTheme`(已有)、AntD `ConfigProvider` + `theme.darkAlgorithm` / `theme.defaultAlgorithm`
- Produces: `<ConfigProvider>` 根据 effective theme 切 `algorithm` + token;`document.documentElement.dataset.theme` 同步设置

- [ ] **Step 1: 写失败的 `App.test.tsx`**

在 `packages/zai/src/web/src/App.test.tsx`(新建)写入:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import App from './App.js'
import { useAppStore } from './store/useAppStore.js'

function mockMatchMedia(matches: boolean) {
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql)
}

describe('App theme wiring', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsTheme: 'auto' })
    document.documentElement.dataset.theme = ''
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.dataset.theme = ''
  })

  it('auto + system dark → dataset.theme=dark', () => {
    mockMatchMedia(true)
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('auto + system light → dataset.theme=light', () => {
    mockMatchMedia(false)
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('settingsTheme=light overrides system dark', () => {
    mockMatchMedia(true)
    useAppStore.setState({ settingsTheme: 'light' })
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('settingsTheme=dark overrides system light', () => {
    mockMatchMedia(false)
    useAppStore.setState({ settingsTheme: 'dark' })
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/App.test.tsx
```
Expected: 4 failed with `expected 'dark' to be ''`(因为当前 `App.tsx` 没有写 dataset)。

- [ ] **Step 3: 重写 `App.tsx`**

把 `packages/zai/src/web/src/App.tsx`(32 行)整个文件替换为:

```tsx
import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppRouter from './router';
import { useEventStream } from './store/useEventStream';
import { useEffectiveTheme } from './hooks/useEffectiveTheme.js';

const DARK_TOKENS = {
  colorPrimary: '#ff6600',
  colorBgContainer: '#12121a',
  colorBgElevated: '#1a1a2e',
  colorBgLayout: '#0a0a0f',
  colorText: '#f1f5f9',
  colorTextSecondary: '#94a3b8',
  colorBorder: 'rgba(255, 102, 0, 0.15)',
  borderRadius: 8,
} as const;

const LIGHT_TOKENS = {
  colorPrimary: '#ff6600',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgLayout: '#f8fafc',
  colorText: '#0f172a',
  colorTextSecondary: '#475569',
  colorBorder: 'rgba(15, 23, 42, 0.10)',
  borderRadius: 8,
} as const;

export default function App() {
  useEventStream();
  const effective = useEffectiveTheme();

  // 同步 <html data-theme="..."> 让 index.css 的 [data-theme] 选择器命中
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = effective;
    }
  }, [effective]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: effective === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: effective === 'dark' ? DARK_TOKENS : LIGHT_TOKENS,
      }}
    >
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ConfigProvider>
  );
}
```

**注意**:`App.tsx` 导出的 `default function App()` 名称不变,以免其他文件的 default import 断链(`AppRouter`、`useEventStream` 等内部导入名也不变)。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/App.test.tsx
```
Expected: 4 passed。

- [ ] **Step 5: 跑既有全量测试确认无回归**

Run:
```bash
cd packages/zai && pnpm vitest run
```
Expected:全部 passed;若 `SettingsDrawer.test.tsx` / `SettingsButton.test.tsx` 失败需立即排查(应不动)。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/App.tsx packages/zai/src/web/src/App.test.tsx
git commit -m "feat(web): wire App.tsx to useEffectiveTheme with dark/light token tables"
```

---

### Task 4: `QuestionCard.tsx` 14 处硬编码颜色 → CSS 变量

**Files:**
- Modify: `packages/zai/src/web/src/components/QuestionCard.tsx`

**Interfaces:**
- Consumes: 已有的 `--bg-card` / `--text-primary` / `--accent-start` / `--bg-body`(由 Task 2 注入 light 套值)
- Produces: 内联 `style` 里的 `#fff0e2` / `#1f1f1f` / `#595959` / `#ff6600` / `#fff2f0` / `#ff4d4f` / `#8c8c8c` / `#fff` / `#d9d9d9` 全部替换

- [ ] **Step 1: 跑既有测试建立基线**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/QuestionCard.test.tsx 2>/dev/null || pnpm vitest run src/web/src/components/QuestionCard
```
Expected:既有测试全绿(若没有该测试文件,跳过,直接做 Step 2)。

- [ ] **Step 2: 替换 14 处硬编码颜色**

在 `packages/zai/src/web/src/components/QuestionCard.tsx` 中,逐行替换以下模式(用 Edit 工具的 replace_all 或多次单替换):

| 原值 | 新值 |
|---|---|
| `color: '#1f1f1f'` | `color: 'var(--text-primary)'` |
| `color: '#595959'` | `color: 'var(--text-secondary)'` |
| `color: '#8c8c8c'` | `color: 'var(--text-tertiary)'` |
| `background: '#fff0e2'` | `background: 'var(--bg-card-hover)'` |
| `borderLeft: '3px solid #ff6600'` | `borderLeft: '3px solid var(--accent-start)'` |
| `background: '#fff2f0'` | `background: 'var(--bg-body)'` |
| `border: '1px solid #ff4d4f'` | `border: '1px solid var(--error)'` |

**不要**替换 `.question-card-scope` 内 CSS(`index.css:193-256` 已有暗色独立样式):那部分 CSS 已经写好,只动 `.tsx` 里的内联 style 即可。

文件里出现的 `#fff0e2`/`#1f1f1f`/`#595959`/`#8c8c8c`/`#ff6600`/`#fff2f0`/`#ff4d4f`/`#fff`/`#d9d9d9` 全在内联 style 上,逐处替换为对应 CSS 变量。

- [ ] **Step 3: 跑测试确认无回归**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/QuestionCard
```
Expected:全绿。

- [ ] **Step 4: 跑 typecheck**

Run:
```bash
cd packages/zai && pnpm typecheck
```
Expected:无新增错误。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/QuestionCard.tsx
git commit -m "refactor(web): replace QuestionCard hardcoded colors with CSS variables"
```

---

### Task 5: `TaskDock.tsx` ~13 处硬编码颜色 → CSS 变量

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDock.tsx`

**Interfaces:**
- Consumes: `--bg-card` / `--text-primary` / `--text-secondary` / `--text-tertiary` / `--accent-start` / `--border-subtle` / `--bg-body`
- Produces: 内联 `style` 里的硬编码颜色全部替换

- [ ] **Step 1: 跑既有测试建立基线**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/TaskDock.test.tsx
```
Expected:全绿。

- [ ] **Step 2: 列出文件中的硬编码颜色**

Run:
```bash
grep -nE "(color|background|border)[a-zA-Z-]*\s*:\s*['\"]#" packages/zai/src/web/src/components/TaskDock.tsx
```

记录每行的原值,按下列映射替换:

| 原值 | 新值 |
|---|---|
| `'#0a0a0f'` | `'var(--bg-body)'` |
| `'#12121a'` | `'var(--bg-card)'` |
| `'#1a1a2e'` | `'var(--bg-card-hover)'` |
| `'#1f1f1f'` | `'var(--text-primary)'` |
| `'#94a3b8'` | `'var(--text-secondary)'` |
| `'#64748b'` | `'var(--text-tertiary)'` |
| `'#f1f5f9'` | `'var(--text-primary)'` |
| `'rgba(255, 102, 0, 0.x)'`(非 border/glow) | `'var(--accent-start)'` |
| `'rgba(255, 255, 255, 0.x)'`(深色背景下用) | `'var(--bg-card-hover)'` |

边界情况(非简单一对一映射,如 `borderLeft: '3px solid #xxx'` 的复合值)按上下文判断:能拆就拆成 `{ borderLeft: '3px solid', borderLeftColor: 'var(--xxx)' }`,不能拆就保留原 hex 并加 `// TODO` 注释(留待后续 phase)。

- [ ] **Step 3: 替换并跑测试**

替换后跑:

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/TaskDock.test.tsx && pnpm typecheck
```
Expected:全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/components/TaskDock.tsx
git commit -m "refactor(web): replace TaskDock hardcoded colors with CSS variables"
```

---

### Task 6: `TaskDrawer.tsx` ~13 处硬编码颜色 → CSS 变量

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx`

**Interfaces:** 与 Task 5 同套 CSS 变量。

- [ ] **Step 1: 跑既有测试建立基线**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/TaskDrawer.test.tsx
```
Expected:全绿。

- [ ] **Step 2: 列出并替换硬编码颜色**

Run:
```bash
grep -nE "(color|background|border)[a-zA-Z-]*\s*:\s*['\"]#" packages/zai/src/web/src/components/TaskDrawer.tsx
```

按 Task 5 Step 2 的映射表替换(同一个项目里同名变量含义一致)。

- [ ] **Step 3: 跑测试 + typecheck**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/TaskDrawer.test.tsx && pnpm typecheck
```
Expected:全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/components/TaskDrawer.tsx
git commit -m "refactor(web): replace TaskDrawer hardcoded colors with CSS variables"
```

---

### Task 7: `MessageBubble.tsx` ~9 处硬编码颜色 → CSS 变量

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`

**Interfaces:** 与 Task 5 同套 CSS 变量。

- [ ] **Step 1: 跑既有测试建立基线**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/transcript/MessageBubble.test.tsx
```
Expected:全绿。

- [ ] **Step 2: 列出并替换硬编码颜色**

Run:
```bash
grep -nE "(color|background|border)[a-zA-Z-]*\s*:\s*['\"]#" packages/zai/src/web/src/components/transcript/MessageBubble.tsx
```

按 Task 5 Step 2 的映射表替换。MessageBubble 经常包含 hex 颜色(如 user 气泡背景、assistant 气泡背景),按上下文区分:`'#1a1a2e'`(user 气泡背景,深色)→ `'var(--bg-card-hover)'`;`'#0d0d14'`(assistant 气泡背景,更深)→ `'var(--bg-sidebar)'`。

- [ ] **Step 3: 跑测试 + typecheck**

Run:
```bash
cd packages/zai && pnpm vitest run src/web/src/components/transcript/MessageBubble.test.tsx && pnpm typecheck
```
Expected:全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx
git commit -m "refactor(web): replace MessageBubble hardcoded colors with CSS variables"
```

---

### Task 8: 更新 `useAppStore.ts` 注释 + 全量验证

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`(只改注释,不改代码)

**Interfaces:** 不变。

- [ ] **Step 1: 更新注释**

在 `packages/zai/src/web/src/store/useAppStore.ts` 第 67 行:

原:
```ts
  // Theme 仅前端暂存(SPEC 阶段 1),刷新/重开 Drawer 后还原为 'auto'.
```

新:
```ts
  // Theme 仅前端暂存(SPEC 阶段 1:不持久化),刷新/重开 Drawer 后还原为 'auto'.
  // 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统 prefers-color-scheme.
  // 持久化与高对比度真实主题实现见后续 phase.
```

- [ ] **Step 2: 跑全量测试**

Run:
```bash
cd packages/zai && pnpm vitest run
```
Expected:全部 passed;特别确认以下回归测试绿:
- `src/web/src/components/SettingsDrawer.test.tsx`
- `src/web/src/components/SettingsButton.test.tsx`(若有)
- `src/web/src/store/useAppStore.test.ts`(若有)
- `src/web/src/App.test.tsx`(本 plan 新增,Task 3)
- `src/web/src/hooks/useEffectiveTheme.test.ts`(本 plan 新增,Task 1)
- `src/web/src/components/{QuestionCard,TaskDock,TaskDrawer}.test.tsx`(Task 4-7)
- `src/web/src/components/transcript/MessageBubble.test.tsx`(Task 7)

- [ ] **Step 3: 跑 typecheck**

Run:
```bash
cd packages/zai && pnpm typecheck
```
Expected:无错误。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts
git commit -m "docs(web): document useEffectiveTheme auto semantics in useAppStore"
```

---

## 自审 checklist(执行前自查)

1. **Spec 覆盖**:
   - §2.1 目标 1(即时切)→ Task 3 + Task 8 验证
   - §2.1 目标 2(auto 跟随系统)→ Task 1 + Task 3 测试
   - §2.1 目标 3(AntD + 4 高优先组件换色)→ Task 2(CSS 变量) + Task 3(token 表) + Task 4-7(组件硬编码)
   - §2.1 目标 4(不破坏既有契约)→ Task 8 全量回归
   - §5.1-5.3 三种数据流 → Task 1 全部覆盖(system light/dark/SSR/matchMedia 不可用)
   - §6 CSS 变量 light 套初值 → Task 2 逐字落地
   - §7 测试策略 → Task 1 7 cases、Task 3 4 cases、Task 4-7 各组件回归

2. **Placeholder 扫描**:无 `TBD` / `TODO(待填)` / `fill in details` / `similar to Task N`。`// TODO(留待后续 phase)` 在 Task 5/6 显式说明(指不能简单拆 CSS 变量的复合 border 值),非隐藏工作量。

3. **类型/名称一致性**:
   - `useEffectiveTheme` 在 Task 1 定义、Task 3 消费 — 签名一致。
   - CSS 变量名 `--bg-body` / `--bg-card` / `--bg-card-hover` / `--bg-sidebar` / `--bg-input` / `--border-subtle` / `--border-active` / `--text-primary` / `--text-secondary` / `--text-tertiary` / `--accent-start` / `--accent-end` / `--glow` / `--success` / `--error` / `--warning` 在 Task 2 定义,Task 4-7 消费 — 16 个变量名完全一致。
   - `document.documentElement.dataset.theme` 在 Task 3 写、Task 3 测试断言 — 一致。

4. **AC 可验证**:每个 AC 都映射到 Task(§8 AC 1-9 → Task 3 + Task 1-8)。
   - §2.