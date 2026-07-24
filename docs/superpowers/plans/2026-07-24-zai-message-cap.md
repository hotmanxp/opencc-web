# zai 对话区消息上限 + 折叠还原 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 设置抽屉新增"消息最大显示条数"项（number 类型，默认 20）；主对话区消息超过上限时折叠早期消息，顶部显示"显示全部 (N 条隐藏)" pill；点 pill 还原全部。

**Architecture:** 沿用 outputStyle 已有的三层模式 —— `ZaiSettings` schema 加字段 + `useAppStore` 加状态 + `PUT /api/agent/settings/max-visible-messages` 路由写盘 + `SettingsDrawer` 加 number 行 + `Agent.tsx` 用 `useMemo` 切 visibleMessages + 顶部 sticky pill。store 不裁剪，仅 UI 折叠。

**Tech Stack:** TypeScript, React 18, Zustand, AntD (`Button`, `UpOutlined`, `Drawer`), Express, vitest + supertest.

## Global Constraints

- `packages/zai/src/shared/settings.ts`：`ZaiSettings.maxVisibleMessages?: number` + `BUILTIN_DEFAULT_SETTINGS.maxVisibleMessages: 20`
- `SettingsRow` 新增子类型 `{ kind:'number'; value:number; min?:number; max?:number; step?:number }`
- `useAppStore`：`maxVisibleMessages: number` 默认 20 + `setMaxVisibleMessages: (n:number)=>void`
- `PUT /api/agent/settings/max-visible-messages`：server clamp `[1, 1000]`
- `Agent.tsx`：仅 UI 隐藏；`messages.length` 不变
- 浮按钮：position:sticky; top:0; z-index:10; AntD Button shape="round"
- 所有现有测试 (test/server/agentSettings.test.ts, useAppStore.test.ts, Agent.test.tsx) 必须保持通过

---

### Task 1: 扩展 ZaiSettings 类型

**Files:**
- Modify: `packages/zai/src/shared/settings.ts`
- Test: 无（类型变更由后续 server / web 测试覆盖）

**Interfaces:**
- Consumes: 无
- Produces:
  - `ZaiSettings.maxVisibleMessages?: number`
  - `BUILTIN_DEFAULT_SETTINGS.maxVisibleMessages: number = 20`

- [ ] **Step 1: 修改 settings.ts 添加字段**

打开 `packages/zai/src/shared/settings.ts`，找到 `ZaiSettings` interface，在末尾添加字段：

```ts
export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. */
  models?: ModelEntry[]
  /** Default permission mode surfaced in the Settings drawer. */
  defaultMode?: string
  /** Web transcript output style — see OutputStyle. */
  outputStyle?: OutputStyle
  /**
   * 主对话区最大渲染消息条数. 超过时 UI 折叠早期消息,顶部浮按钮一键还原.
   * 默认 20. clamp [1, 1000].
   */
  maxVisibleMessages?: number
}
```

- [ ] **Step 2: 修改 BUILTIN_DEFAULT_SETTINGS 添加默认值**

在同一文件 `BUILTIN_DEFAULT_SETTINGS` 常量中追加字段：

```ts
export const BUILTIN_DEFAULT_SETTINGS: ZaiSettings = {
  env: {},
  defaultMode: 'default',
  outputStyle: 'default',
  maxVisibleMessages: 20,
}
```

- [ ] **Step 3: 验证编译**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai typecheck 2>&1 | tail -20`
Expected: 无 TS 错误。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/shared/settings.ts
git commit -m "feat(zai): add maxVisibleMessages to ZaiSettings"
```

---

### Task 2: server 端 PUT /api/agent/settings/max-visible-messages

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts`
- Test: `packages/zai/test/server/agentSettings-max-visible-messages.test.ts`

**Interfaces:**
- Consumes: `writeZaiSettings(settings: ZaiSettings): Promise<void>`, `readZaiSettings(): Promise<ZaiSettings>`
- Produces: `PUT /api/agent/settings/max-visible-messages` 请求 `{ value: number }` → 200 `{ value }` (clamped)

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/test/server/agentSettings-max-visible-messages.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 把 ZAI_DATA_DIR / HOME 隔离到一个临时目录, 避免污染真实 ~/.zai/settings.json
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-max-visible-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
})

// Import after env setup so the zaiSettingsStore picks up the temp HOME.
const { default: agentSettingsRouter } = await import(
  '../../src/server/routes/agentSettings.js'
)

const app = express()
app.use(express.json())
app.locals.instanceContext = { cwd: '/tmp', cwdName: 'test' }
app.use('/api', agentSettingsRouter)

describe('PUT /api/agent/settings/max-visible-messages', () => {
  it('persists value to settings.json and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 50 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 50 })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.maxVisibleMessages).toBe(50)
  })

  it('clamps value below 1 to 1', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: -10 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1 })
  })

  it('clamps value above 1000 to 1000', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 99999 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1000 })
  })

  it('rejects non-number value with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 'fifty' })
    expect(res.status).toBe(400)
  })

  it('rounds down fractional input', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 12.7 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 12 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- agentSettings-max-visible-messages 2>&1 | tail -30`
Expected: 5 个 it 全部 fail（404 not found，因为路由不存在）。

- [ ] **Step 3: 在 routes/agentSettings.ts 添加 PUT handler**

打开 `packages/zai/src/server/routes/agentSettings.ts`，在 `output-style` handler 之后追加：

```ts
/**
 * PUT /api/agent/settings/max-visible-messages — persist the web UI's
 * "消息最大显示条数" setting. Body is `{ value: number }`.
 * Server clamps to [1, 1000] and floors fractional inputs.
 *
 * Used by SettingsDrawer when the user changes the "消息最大显示条数" row.
 * Returns the persisted value so the client echoes back the canonical form.
 */
router.put(
  '/agent/settings/max-visible-messages',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: `invalid value: ${String(raw)}` })
    }
    const clamped = Math.max(1, Math.min(1000, Math.floor(n)))
    try {
      const settings = await readZaiSettings()
      const next: ZaiSettings = { ...settings, maxVisibleMessages: clamped }
      await writeZaiSettings(next)
      res.json({ value: next.maxVisibleMessages })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- agentSettings-max-visible-messages 2>&1 | tail -20`
Expected: 5 passed.

- [ ] **Step 5: 验证未破坏现有 agentSettings.test.ts**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- agentSettings 2>&1 | tail -15`
Expected: 全部通过（既有 + 新增）。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/server/routes/agentSettings.ts packages/zai/test/server/agentSettings-max-visible-messages.test.ts
git commit -m "feat(zai): add PUT /max-visible-messages route with clamp"
```

---

### Task 3: GET /api/agent/settings 返回 maxVisibleMessages

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts` (GET handler)
- Test: `packages/zai/test/server/agentSettings-max-visible-messages.test.ts` (追加测试)

**Interfaces:**
- Consumes: `readZaiSettings()`
- Produces: GET 响应 `{ maxVisibleMessages: number }` 字段

- [ ] **Step 1: 在现有测试文件追加 GET 测试**

在 `agentSettings-max-visible-messages.test.ts` 末尾追加：

```ts
describe('GET /api/agent/settings returns maxVisibleMessages', () => {
  it('returns persisted maxVisibleMessages', async () => {
    // 先 PUT 一次
    await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 75 })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.maxVisibleMessages).toBe(75)
  })

  it('returns default 20 when settings.json has no maxVisibleMessages', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.maxVisibleMessages).toBe(20)
  })
})
```

- [ ] **Step 2: 运行测试确认新测试 fail**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- agentSettings-max-visible-messages 2>&1 | tail -30`
Expected: GET 部分 fail（`maxVisibleMessages` undefined）。

- [ ] **Step 3: 修改 GET handler 返回字段**

在 `packages/zai/src/server/routes/agentSettings.ts` 的 `router.get('/agent/settings', ...)` 内，把 `res.json({...})` 改为：

```ts
const maxVisibleMessages =
  typeof settings.maxVisibleMessages === 'number'
    ? Math.max(1, Math.min(1000, Math.floor(settings.maxVisibleMessages)))
    : 20
res.json({
  defaultModel,
  baseURL,
  models,
  defaultMode: getDefaultMode(),
  outputStyle,
  maxVisibleMessages,
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- agentSettings-max-visible-messages 2>&1 | tail -15`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/agentSettings.ts packages/zai/test/server/agentSettings-max-visible-messages.test.ts
git commit -m "feat(zai): GET /agent/settings exposes maxVisibleMessages"
```

---

### Task 4: useAppStore 添加 maxVisibleMessages 状态

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`
- Test: `packages/zai/src/web/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `AppState.maxVisibleMessages: number` (默认 20)
  - `AppState.setMaxVisibleMessages: (n: number) => void`

- [ ] **Step 1: 在 useAppStore.test.ts 追加失败测试**

打开 `packages/zai/src/web/src/store/useAppStore.test.ts`，在文件末尾追加：

```ts
describe('maxVisibleMessages', () => {
  test('default value is 20', () => {
    useAppStore.setState({ maxVisibleMessages: 20 })
    expect(useAppStore.getState().maxVisibleMessages).toBe(20)
  })

  test('setMaxVisibleMessages(50) updates state', () => {
    useAppStore.setState({ maxVisibleMessages: 20 })
    useAppStore.getState().setMaxVisibleMessages(50)
    expect(useAppStore.getState().maxVisibleMessages).toBe(50)
  })
})
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- src/web/src/store/useAppStore.test 2>&1 | tail -20`
Expected: 2 failed (`setMaxVisibleMessages is not a function`)。

- [ ] **Step 3: 修改 useAppStore.ts**

打开 `packages/zai/src/web/src/store/useAppStore.ts`，修改两处：

(a) 在 `AppState` interface 中（`outputStyle` 字段附近）追加：

```ts
  /**
   * 主对话区最大渲染消息条数. 超过时 UI 折叠早期消息,顶部浮按钮一键还原.
   * 默认 20. Layout mount effect 用 GET /api/agent/settings 覆写.
   */
  maxVisibleMessages: number
  setMaxVisibleMessages: (n: number) => void
```

(b) 在 `create<AppState>((set) => ({...}))` 内（紧跟 `outputStyle: 'default'` 和 `setOutputStyle` 之后）追加：

```ts
  maxVisibleMessages: 20,
  setMaxVisibleMessages: (n) => set({ maxVisibleMessages: n }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- src/web/src/store/useAppStore.test 2>&1 | tail -15`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/store/useAppStore.test.ts
git commit -m "feat(zai): add maxVisibleMessages to useAppStore"
```

---

### Task 5: SettingsDrawer number 行类型 + number 行渲染

**Files:**
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx`
- Test: `packages/zai/src/web/src/components/SettingsDrawer.test.tsx` (新建)

**Interfaces:**
- Consumes: `useAppStore.setMaxVisibleMessages`, schema 中的 number row
- Produces: `SettingsRow.kind === 'number'` 的渲染分支（编辑态输入框 + ± 按钮）；onChange 触发 store 更新

- [ ] **Step 1: 创建 SettingsDrawer.test.tsx 失败测试**

创建 `packages/zai/src/web/src/components/SettingsDrawer.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SettingsList } from './SettingsDrawer.js'
import { useAppStore } from '../store/useAppStore.js'

beforeEach(() => {
  useAppStore.setState({ maxVisibleMessages: 20 })
})

const numberSchema = [
  {
    section: 'Display',
    rows: [
      {
        key: 'maxVisibleMessages',
        label: '消息最大显示条数',
        kind: 'number' as const,
        value: 20,
        min: 1,
        max: 1000,
        step: 1,
      },
    ],
  },
]

describe('SettingsList number row', () => {
  it('renders the row with current value', () => {
    render(<SettingsList schema={numberSchema} onClose={() => {}} />)
    expect(screen.getByText('消息最大显示条数')).toBeTruthy()
    // formatValue for number row returns String(value)
    expect(screen.getByText('20')).toBeTruthy()
  })

  it('Enter on selected number row enters edit mode and shows input', () => {
    render(<SettingsList schema={numberSchema} onClose={() => {}} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByDisplayValue('20') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.type).toBe('number')
  })

  it('submitting a new value calls onChange', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={numberSchema} onClose={() => {}} onChange={onChange} />,
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByDisplayValue('20') as HTMLInputElement
    fireEvent.change(input, { target: { value: '50' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 50)
  })

  it('Escape exits edit mode without calling onChange', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={numberSchema} onClose={() => {}} onChange={onChange} />,
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByDisplayValue('20') as HTMLInputElement
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('+ button increments by step and triggers onChange', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={numberSchema} onClose={() => {}} onChange={onChange} />,
    )
    const plusBtn = screen.getByTestId('number-row-plus-maxVisibleMessages')
    fireEvent.click(plusBtn)
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 21)
  })

  it('- button decrements by step and clamps to min', () => {
    const onChange = vi.fn()
    const lowSchema = [
      {
        section: 'Display',
        rows: [
          {
            key: 'maxVisibleMessages',
            label: '消息最大显示条数',
            kind: 'number' as const,
            value: 1,
            min: 1,
            max: 1000,
            step: 1,
          },
        ],
      },
    ]
    render(
      <SettingsList schema={lowSchema} onClose={() => {}} onChange={onChange} />,
    )
    const minusBtn = screen.getByTestId('number-row-minus-maxVisibleMessages')
    fireEvent.click(minusBtn)
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 1) // already at min
  })
})
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- SettingsDrawer 2>&1 | tail -30`
Expected: 多数 fail（编译/找不到 input/找不到 button）。

- [ ] **Step 3: 扩展 SettingsRow 类型**

打开 `packages/zai/src/web/src/components/SettingsDrawer.tsx`，修改 `SettingsRow` type：

```ts
export type SettingsRow =
  | { key: string; label: string; kind: 'boolean'; value: boolean }
  | { key: string; label: string; kind: 'enum'; value: string; options: EnumOption[] }
  | {
      key: string
      label: string
      kind: 'number'
      value: number
      min?: number
      max?: number
      step?: number
    }
```

- [ ] **Step 4: 修改 formatValue 支持 number**

找到 `function formatValue(row: SettingsRow): string`，在 boolean 分支后追加：

```ts
function formatValue(row: SettingsRow): string {
  if (row.kind === 'boolean') return row.value ? 'true' : 'false'
  if (row.kind === 'number') return String(row.value)
  // enum
  const opt = row.options.find((o) => o.value === row.value)
  return opt?.label ?? row.value
}
```

- [ ] **Step 5: 在 SettingsList 添加 number 编辑态 + ± 按钮**

(a) 在 `SettingsList` 函数体顶部 `useState` 区域追加（紧跟 `enumOverlay` 之后）：

```tsx
  // number row 编辑态: rowKey -> 暂存输入字符串. null 表示没在编辑.
  const [numberEdit, setNumberEdit] = useState<string | null>(null)
```

(b) 在 `selectedRow` 派生之后、`toggleBoolean` 之前添加：

```tsx
  // number row 操作
  const commitNumberEdit = useCallback(
    (row: Extract<SettingsRow, { kind: 'number' }>, raw: string) => {
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      const min = row.min ?? Number.NEGATIVE_INFINITY
      const max = row.max ?? Number.POSITIVE_INFINITY
      const clamped = Math.max(min, Math.min(max, Math.floor(n)))
      onChange?.(row.key, clamped)
    },
    [onChange],
  )
  const bumpNumber = useCallback(
    (row: Extract<SettingsRow, { kind: 'number' }>, dir: 1 | -1) => {
      const step = row.step ?? 1
      const min = row.min ?? Number.NEGATIVE_INFINITY
      const max = row.max ?? Number.POSITIVE_INFINITY
      const next = Math.max(min, Math.min(max, row.value + dir * step))
      onChange?.(row.key, next)
    },
    [onChange],
  )
```

(c) 在 `useEffect` 的 `enumOverlay` 键盘处理（line ~155-188）之前的键盘分支中添加 number 编辑态处理。在 `// 2) 搜索模式激活 — 输入框自身捕获字符...` 之前插入一段：

```tsx
      // 1.5) number 编辑态激活
      if (numberEdit !== null) {
        if (key === 'Escape') {
          e.preventDefault()
          setNumberEdit(null)
          return
        }
        if (key === 'Enter') {
          e.preventDefault()
          const row = flatRows.find((r) => r.key === numberEdit)
          if (row && row.kind === 'number') {
            commitNumberEdit(row, numberEditBuffer)
          }
          setNumberEdit(null)
          return
        }
        // 把数字字符写入 numberEditBuffer
        if (key === 'Backspace') {
          setNumberEditBuffer((b) => b.slice(0, -1))
          return
        }
        if (/^[0-9.]$/.test(key)) {
          setNumberEditBuffer((b) => b + key)
          return
        }
        return // 编辑态其它键不冒泡
      }
```

(d) 把 "2) 搜索模式" 的判断从 `// 3) 主列表导航` 的 Enter 处理改成 number 行专用：找到 `if (key === 'Enter') { ... if (selectedRow?.kind === 'enum') openEnumOverlay(selectedRow); ...}` 这段，改为：

```tsx
      if (key === 'Enter') {
        e.preventDefault()
        if (selectedRow?.kind === 'enum') openEnumOverlay(selectedRow)
        else if (selectedRow?.kind === 'number') {
          setNumberEdit(selectedRow.key)
          setNumberEditBuffer(String(selectedRow.value))
        }
        return
      }
```

(e) 在 `useState` 区域再追加一个：

```tsx
  const [numberEditBuffer, setNumberEditBuffer] = useState('')
```

(f) 修改渲染层（找到 `const displayValue = formatValue(row)` 那块），把整个 `<span>{displayValue}</span>` 替换成：

```tsx
                {row.kind === 'number' ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: 'rgba(255,255,255,0.65)',
                    }}
                  >
                    <Button
                      size="small"
                      type="text"
                      data-testid={`number-row-minus-${row.key}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        bumpNumber(row, -1)
                      }}
                      style={{ padding: '0 6px', minWidth: 0, height: 22 }}
                    >
                      −
                    </Button>
                    {numberEdit === row.key ? (
                      <input
                        autoFocus
                        type="number"
                        min={row.min}
                        max={row.max}
                        step={row.step}
                        value={numberEditBuffer}
                        onChange={(e) => setNumberEditBuffer(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitNumberEdit(row, numberEditBuffer)
                            setNumberEdit(null)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setNumberEdit(null)
                          }
                        }}
                        onBlur={() => {
                          commitNumberEdit(row, numberEditBuffer)
                          setNumberEdit(null)
                        }}
                        style={{
                          width: 60,
                          background: 'transparent',
                          border: '1px solid rgba(255,255,255,0.3)',
                          borderRadius: 2,
                          color: 'inherit',
                          font: 'inherit',
                          padding: '0 4px',
                        }}
                      />
                    ) : (
                      <span>{displayValue}</span>
                    )}
                    <Button
                      size="small"
                      type="text"
                      data-testid={`number-row-plus-${row.key}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        bumpNumber(row, 1)
                      }}
                      style={{ padding: '0 6px', minWidth: 0, height: 22 }}
                    >
                      +
                    </Button>
                  </span>
                ) : (
                  <span
                    style={{
                      color: 'rgba(255,255,255,0.65)',
                      textAlign: 'right',
                      maxWidth: '55%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayValue}
                  </span>
                )}
```

(g) 在 `SettingsList` 顶部 import 区域追加 Button：

```tsx
import { Button } from 'antd'
```

- [ ] **Step 6: 运行 SettingsDrawer 测试确认通过**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- SettingsDrawer 2>&1 | tail -30`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx packages/zai/src/web/src/components/SettingsDrawer.test.tsx
git commit -m "feat(zai): SettingsList supports number row with edit mode and +/- buttons"
```

---

### Task 6: SettingsDrawer 加入 Display section + maxVisibleMessages 行 + 写盘

**Files:**
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx`
- Test: 复用 Task 5 的测试 + 在 buildStaticSchema 顶部 useState 中渲染 maxVisibleMessages 行

**Interfaces:**
- Consumes: `useAppStore.maxVisibleMessages`, `useAppStore.setMaxVisibleMessages`
- Produces: schema 内含 maxVisibleMessages 行 + handleChange 写 store + PUT 请求

- [ ] **Step 1: 在 SettingsDrawer.test.tsx 追加 schema 包含性测试**

```tsx
import { SettingsDrawer } from './SettingsDrawer.js'
// ... 在 useAppStore.setState 后,新建 describe:

describe('SettingsDrawer schema', () => {
  it('includes maxVisibleMessages row under Display section', () => {
    useAppStore.setState({
      maxVisibleMessages: 30,
      settingsDrawerOpen: true,
    })
    render(<SettingsDrawer />)
    // SettingsDrawer 直接渲染 SettingsList, 抽屉 body 内可见
    expect(screen.getByText('消息最大显示条数')).toBeTruthy()
    expect(screen.getByText('30')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- SettingsDrawer 2>&1 | tail -20`
Expected: schema 包含性测试 fail（找不到行）。

- [ ] **Step 3: 修改 buildStaticSchema 加入 Display section**

打开 `SettingsDrawer.tsx`，找到 `buildStaticSchema` 函数签名，把它的参数扩展为：

```ts
function buildStaticSchema(
  theme: Theme,
  outputStyle: OutputStyle,
  maxVisibleMessages: number,
): SettingsSchema {
```

在 schema 数组尾部（Language 之后）追加：

```ts
    {
      section: 'Display',
      rows: [
        {
          key: 'maxVisibleMessages',
          label: '消息最大显示条数',
          kind: 'number',
          value: maxVisibleMessages,
          min: 1,
          max: 1000,
          step: 1,
        },
      ],
    },
```

- [ ] **Step 4: 修改 SettingsDrawer 函数调用 buildStaticSchema + 加订阅 + 加 handleChange 分支**

(a) 在 `SettingsDrawer` 函数体顶部追加订阅：

```tsx
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const setMaxVisibleMessages = useAppStore((s) => s.setMaxVisibleMessages)
```

(b) 修改 schema 初始 state：

```tsx
  const [schema, setSchema] = useState<SettingsSchema>(() =>
    buildStaticSchema(theme, outputStyle, maxVisibleMessages),
  )
```

(c) 加 effect 把 store 投影进 schema：

```tsx
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'maxVisibleMessages' && r.kind === 'number') {
            return { ...r, value: maxVisibleMessages }
          }
          return r
        }),
      })),
    )
  }, [maxVisibleMessages])
```

(d) 在 `handleChange` 内（outputStyle 分支之后，// 其它行 之前）追加：

```tsx
      if (key === 'maxVisibleMessages' && typeof value === 'number') {
        const clamped = Math.max(1, Math.min(1000, Math.floor(value)))
        setMaxVisibleMessages(clamped)
        void fetch('/api/agent/settings/max-visible-messages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: clamped }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘
        })
      }
```

(e) 修改 `useEffect` 依赖数组（handleChange）追加 `setMaxVisibleMessages`：

```tsx
    [setTheme, setOutputStyle, setTranscriptCollapsed, setMaxVisibleMessages],
```

(f) 修改 `handleChange` 内部 schema state 更新 setSchema 调用，让 number 行也能被回写（找到 `if (r.kind === 'enum' && typeof value === 'string')` 之后追加）：

```tsx
            if (r.kind === 'number' && typeof value === 'number') {
              return { ...r, value }
            }
```

- [ ] **Step 5: 运行 SettingsDrawer 测试**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- SettingsDrawer 2>&1 | tail -20`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx packages/zai/src/web/src/components/SettingsDrawer.test.tsx
git commit -m "feat(zai): add Display section with maxVisibleMessages row to SettingsDrawer"
```

---

### Task 7: Layout hydrate maxVisibleMessages

**Files:**
- Modify: `packages/zai/src/web/src/components/Layout.tsx`

**Interfaces:**
- Consumes: GET `/api/agent/settings` 返回 `{ maxVisibleMessages?: number }`
- Produces: `useAppStore.setMaxVisibleMessages(value ?? 20)`

- [ ] **Step 1: 修改 Layout.tsx**

打开 `packages/zai/src/web/src/components/Layout.tsx`，找到现有的 `useEffect`（line 62-83）hydrate outputStyle 的那段，紧跟 `setTranscriptCollapsed` 调用之后追加：

```tsx
        if (typeof data.maxVisibleMessages === 'number') {
          setMaxVisibleMessages(
            Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))),
          )
        }
```

在 `setOutputStyle` 解构旁追加：

```tsx
  const setMaxVisibleMessages = useAppStore((s) => s.setMaxVisibleMessages)
```

把 useEffect 依赖数组追加 `setMaxVisibleMessages`：

```tsx
  }, [setOutputStyle, setMaxVisibleMessages, setTranscriptCollapsed]);
```

- [ ] **Step 2: typecheck**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai typecheck 2>&1 | tail -10`
Expected: 无错。

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/components/Layout.tsx
git commit -m "feat(zai): Layout hydrate maxVisibleMessages from /agent/settings"
```

---

### Task 8: Agent.tsx 切 visibleMessages + sticky pill

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`
- Test: `packages/zai/src/web/src/pages/Agent.test.tsx`

**Interfaces:**
- Consumes: `useAppStore.maxVisibleMessages`, `useAgentStore.messages`
- Produces: `<MessageListView messages={visibleMessages} />` + `{showPill && <Pill />}`

- [ ] **Step 1: 写失败测试**

打开 `packages/zai/src/web/src/pages/Agent.test.tsx`，在文件末尾追加：

```tsx
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'

// mock 100 条 user 消息
const buildMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'user' as const,
    content: `msg ${i}`,
    ts: i,
  }))

describe('Agent message cap', () => {
  beforeEach(() => {
    useAgentStore.setState({ messages: buildMessages(100), sessionId: 's1' })
    useAppStore.setState({ maxVisibleMessages: 20 })
  })

  it('shows the show-all pill when messages exceed maxVisibleMessages', () => {
    render(<Agent />)
    const pill = screen.getByTestId('show-all-messages-pill')
    expect(pill).toBeTruthy()
    expect(pill.textContent).toMatch(/80\s*条隐藏/)
  })

  it('clicking pill shows all messages', () => {
    render(<Agent />)
    const pill = screen.getByTestId('show-all-messages-pill')
    fireEvent.click(pill)
    // pill 消失
    expect(screen.queryByTestId('show-all-messages-pill')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认 fail**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- Agent.test 2>&1 | tail -30`
Expected: 2 failed（找不到 pill）。

- [ ] **Step 3: 修改 Agent.tsx 添加派生逻辑 + pill JSX**

打开 `packages/zai/src/web/src/pages/Agent.tsx`。

(a) 在文件顶部 import 区域追加（紧跟现有 import 之后）：

```tsx
import { Button } from 'antd'
import { UpOutlined } from '@ant-design/icons'
```

(b) 找到 `const messages = useAgentStore((s) => s.messages);`，在它之后追加：

```tsx
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const [showAllMessages, setShowAllMessages] = useState(false)

  // 派生: hiddenCount 不受 showAllMessages 影响; visibleMessages 切片时考虑 showAllMessages
  const { hiddenCount, visibleMessages } = useMemo(() => {
    const hc = Math.max(0, messages.length - maxVisibleMessages)
    const eff = showAllMessages ? 0 : hc
    return { hiddenCount: hc, visibleMessages: messages.slice(eff) }
  }, [messages, maxVisibleMessages, showAllMessages])

  // 用户点开 pill 后,新消息持续进来,直到 messages.length 再次超出 limit,
  // 自动把 showAllMessages 重置为 false, pill 重新出现.
  useEffect(() => {
    if (showAllMessages && hiddenCount > 0) {
      setShowAllMessages(false)
    }
  }, [showAllMessages, hiddenCount])

  const showPill = hiddenCount > 0 && !showAllMessages
```

(c) 修改 `<MessageListView messages={messages} ...>` 这一行改为：

```tsx
          <MessageListView messages={visibleMessages} streaming={status === "streaming"} />
```

(d) 在同一渲染树内（紧跟 `<MessageListView>` 之后，pendingAsk 之前），插入 pill：

```tsx
          {showPill && (
            <div
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 10,
                display: 'flex',
                justifyContent: 'center',
                paddingTop: 8,
                paddingBottom: 4,
              }}
            >
              <Button
                shape="round"
                size="small"
                icon={<UpOutlined />}
                onClick={() => setShowAllMessages(true)}
                data-testid="show-all-messages-pill"
              >
                显示全部 ({hiddenCount} 条隐藏)
              </Button>
            </div>
          )}
```

- [ ] **Step 4: 运行 Agent.test.tsx 测试确认通过**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test -- Agent.test 2>&1 | tail -20`
Expected: 全部通过。

- [ ] **Step 5: typecheck**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai typecheck 2>&1 | tail -10`
Expected: 无错。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/pages/Agent.test.tsx
git commit -m "feat(zai): Agent.tsx cap visible messages + show-all sticky pill"
```

---

### Task 9: 全量回归测试

**Files:** 无（运行测试）

- [ ] **Step 1: 运行 zai 全量 vitest**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai test 2>&1 | tail -40`
Expected: 全部通过（新增 + 旧 case）。

- [ ] **Step 2: typecheck 全包**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -r typecheck 2>&1 | tail -10`
Expected: 无 TS 错误。

- [ ] **Step 3: 验证 build 不破**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -F zai build 2>&1 | tail -10`
Expected: build 成功。

- [ ] **Step 4: 提交验证报告**

若前几步有失败 → 修复后重新跑；全部通过则无需新 commit（Task 1-8 已分别提交）。

---

### Task 10: 文档 / 更新 AGENTS.md（可选）

**Files:**
- Modify: `AGENTS.md`（项目根）

**判断标准**：AGENTS.md 当前是否列出 UI 设置项？若无影响则跳过本任务。

- [ ] **Step 1: 检查 AGENTS.md 是否需更新**

Run: `grep -i "outputStyle\|maxVisible\|Settings" AGENTS.md | head -5`
Expected: 若 grep 无任何输出，跳过本任务；若已有 SettingsDrawer 描述，加一句"消息最大显示条数 (maxVisibleMessages)"。

- [ ] **Step 2: 若需更新则加描述**

在 AGENTS.md "## 关键文件" 区块的 `SettingsDrawer.tsx` 行后追加：

```markdown
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | `/api/agent/settings` 抽屉 + boolean/enum/number 行;outputStyle 走 PUT 写盘,maxVisibleMessages 同步 |
```

并把 `useAppStore.ts` 行追加：

```markdown
| `packages/zai/src/web/src/store/useAppStore.ts` | 全局 UI state:sidebarCollapsed, settingsDrawerOpen, settingsTheme, outputStyle, maxVisibleMessages |
```

- [ ] **Step 3: 提交**

```bash
git add AGENTS.md
git commit -m "docs: note maxVisibleMessages in AGENTS.md"
```

---

## 执行自检清单

- [ ] Task 1: `ZaiSettings.maxVisibleMessages?: number` 已加，`BUILTIN_DEFAULT_SETTINGS.maxVisibleMessages: 20` 已加
- [ ] Task 2: `PUT /api/agent/settings/max-visible-messages` 已加，clamp `[1, 1000]`，floor fractional
- [ ] Task 3: `GET /api/agent/settings` 返回 `maxVisibleMessages` 字段，缺失时 fallback `20`
- [ ] Task 4: `useAppStore.maxVisibleMessages` 默认 20，`setMaxVisibleMessages` action 存在
- [ ] Task 5: `SettingsRow.kind === 'number'` 子类型 + 编辑态 + ± 按钮已加，`SettingsList` 渲染分支正确
- [ ] Task 6: `buildStaticSchema` 含 Display section + maxVisibleMessages 行，handleChange 写 store + PUT
- [ ] Task 7: Layout mount effect hydrate `maxVisibleMessages`（含 `[1,1000]` clamp）
- [ ] Task 8: `Agent.tsx` 用 `useMemo` 派生 `hiddenCount`/`visibleMessages`，sticky pill 显示 `({hiddenCount} 条隐藏)`
- [ ] Task 9: zai 全量测试 + 全包 typecheck + build 全通过
- [ ] Task 10: AGENTS.md 若需要则已更新