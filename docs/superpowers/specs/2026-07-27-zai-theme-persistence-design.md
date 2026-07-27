# zai Theme 持久化设计

**日期**: 2026-07-27
**状态**: 待实施
**作用域**: `packages/zai`(web + server)+ `packages/zai/src/shared`

## 背景

`useAppStore.settingsTheme` 当前**仅前端暂存**,刷新或重开 Drawer 后还原为 `'auto'`(`packages/zai/src/web/src/store/useAppStore.ts:68-72, 126-127`):

```typescript
// Theme 仅前端暂存(SPEC 阶段 1:不持久化),刷新/重开 Drawer 后还原为 'auto'.
// 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统 prefers-color-scheme.
// 持久化与高对比度真实主题实现见后续 phase.
```

用户每次切主题都得再点一次,体验差。`outputStyle` 和 `maxVisibleMessages` 已走完整持久化路径:`ZaiSettings` schema + `PUT /api/agent/settings/{field}` + `Layout` mount GET hydrate。本次把 theme 提到同等水位。

## 目标

1. 用户切主题后,**重启 web 不丢**该选择
2. 持久化 4 档:`'auto' | 'dark' | 'light' | 'high-contrast'`
3. 与现有 `outputStyle` / `maxVisibleMessages` 走同一套服务端路径,行为对齐
4. 不破坏现有 `useEffectiveTheme` 对 `auto` / `high-contrast` 的系统色跟随后逻辑
5. 不引入新依赖,不改前端 CSS

## 非目标

- ❌ high-contrast 主题的真实 CSS 变量实现(SettingsDrawer 仍把 high-contrast 映射回 'auto' 显示,store 存真值)
- ❌ localStorage 双写(settings.json 单源)
- ❌ 改 `useEffectiveTheme` 的解析规则
- ❌ 改 App.tsx 的 `data-theme` 同步 effect
- ❌ `BUILTIN_DEFAULT_SETTINGS.theme`(沿用 `outputStyle` 不写的做法 — settings 缺失由 `resolveTheme` 兜底为 'auto')

## 数据流

```
用户切主题(SettingsDrawer.handleChange)
  ├─ useAppStore.setSettingsTheme(next)              ← 立即生效(刷新 AntD theme + data-theme)
  └─ fetch PUT /api/agent/settings/theme {theme}     ← fire-and-forget,失败 swallow
       ↓
server: routes/agentSettings.ts
  ├─ isValidTheme(body.theme) → 400 if invalid
  └─ readZaiSettings() + writeZaiSettings({..., theme})   ← 其它字段保留
       ↓
~/.zai/settings.json → { theme: 'dark', ... }
       ↓ 启动
Layout mount useEffect
  └─ api.get<{theme?: Theme, ...}>('/agent/settings')
       └─ isValidTheme(data.theme) → useAppStore.setSettingsTheme(value)
                                              ↑ 失败 / 缺失 / 无效 保留 store 默认 'auto'
       ↓
useEffectiveTheme(settingsTheme)
  └─ 解析 dark/light → 同步 document.data-theme → AntD ConfigProvider token
```

## 文件改动

### 1. `packages/zai/src/shared/settings.ts`

加 `Theme` 类型 + `ZaiSettings.theme?` 字段:

```typescript
/** 用户主题偏好. 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为系统色. */
export type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'

/** Shape of ~/.zai/settings.json. */
export interface ZaiSettings {
  // ... 现有字段不变
  /** Web UI 主题 — see Theme. */
  theme?: Theme
  /** 主对话区最大渲染消息条数... */
  maxVisibleMessages?: number
}
// BUILTIN_DEFAULT_SETTINGS 不动 — settings 缺失由 resolveTheme() 兜底 'auto'.
```

### 2. `packages/zai/src/server/services/zaiSettingsStore.ts`

镜像 `resolveOutputStyle` / `isValidOutputStyle` / `VALID_OUTPUT_STYLES` 写法:

```typescript
const VALID_THEMES: ReadonlySet<Theme> = new Set<Theme>([
  'auto',
  'dark',
  'light',
  'high-contrast',
])

/** Resolve persisted theme with validation. Unknown/missing → 'auto'. */
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

### 3. `packages/zai/src/server/routes/agentSettings.ts`

a) GET `/agent/settings` 响应加 `theme`:

```typescript
router.get('/agent/settings', async (_req, res) => {
  // ...
  const theme = resolveTheme(settings)   // 新增
  res.json({
    // ...
    outputStyle,
    theme,                              // 新增
    maxVisibleMessages,
  })
})
```

b) 加 PUT handler(在 `output-style` 之后、`max-visible-messages` 之前或之后皆可):

```typescript
/**
 * PUT /api/agent/settings/theme — persist the web UI's theme preference.
 * Body is `{ theme: 'auto' | 'dark' | 'light' | 'high-contrast' }`.
 * Server validates the value and round-trips the existing settings.json
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

### 4. `packages/zai/src/web/src/store/useAppStore.ts`

只清理注释,不改字段/类型/初始值:

```typescript
// Theme 持久化到 ~/.zai/settings.json(settings.theme).
// 'auto' / 'high-contrast' 由 useEffectiveTheme() 解析为跟随系统 prefers-color-scheme.
// 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast',
```

### 5. `packages/zai/src/web/src/components/SettingsDrawer.tsx`

`handleChange` 里 `key === 'theme'` 改成走完整持久化路径(镜像 `outputStyle`):

```typescript
if (key === 'theme' && typeof value === 'string') {
  const next = value as Theme
  setTheme(next)
  // 同步 PUT settings.json,失败不打断 UI(下次启动仍可重写).
  void fetch('/api/agent/settings/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: next }),
  }).catch(() => {
    // swallow — 下次 GET 会重新对齐磁盘状态
  })
}
```

`buildStaticSchema` 里 theme 行的 `value` 已经是 `theme === 'high-contrast' ? 'auto' : theme`(Drawer 渲染层),不动。

### 6. `packages/zai/src/web/src/components/Layout.tsx`

mount effect 拿到 `data.theme` 后 hydrate:

```typescript
api
  .get<{ outputStyle?: OutputStyle; theme?: Theme; maxVisibleMessages?: number }>(
    '/agent/settings',
  )
  .then((data) => {
    if (cancelled) return
    // ... outputStyle / maxVisibleMessages 现有逻辑
    if (data.theme === 'auto' || data.theme === 'dark' ||
        data.theme === 'light' || data.theme === 'high-contrast') {
      setSettingsTheme(data.theme)
    }
    // 失败 / 缺失 / 无值 → store 保持 'auto' 默认
  })
  .catch(() => { /* swallow — keep default */ })
```

`setSettingsTheme` 必须在 destructure 里加上。

## 测试

新文件 `packages/zai/test/server/agentSettings-theme.test.ts`(镜像 `agentSettings-max-visible-messages.test.ts`):

| 用例 | 断言 |
|------|------|
| 1. PUT 有效 theme('dark')→ 200,响应回显,磁盘 settings.json.theme === 'dark' | server 落盘正确 |
| 2. PUT 有效 theme('high-contrast')→ 200 | 4 档全支持 |
| 3. PUT 无效 theme('rainbow')→ 400 | server 拒绝乱写 |
| 4. PUT 缺失字段 → 400 | 拒空 body |
| 5. PUT 保留其他字段(env/outputStyle/maxVisibleMessages) | round-trip 不丢字段 |
| 6. GET 不存在的 settings.json → theme === 'auto' | resolveTheme 兜底 |

测试要 `__resetCacheForTests`(`zaiSettingsCache`)打头,跟 max-visible-messages test 同款。

`useAppStore.test.ts` 已经覆盖 `setSettingsTheme` 行为(46 caller,新增 `Layout.tsx` 那行 `setSettingsTheme` 是 destructure,无新增测试需要)。

## 风险与回滚

- **风险 1**:手改 `settings.json.theme` 为垃圾值 → `resolveTheme` 兜底 'auto',UI 不卡。✅
- **风险 2**:PUT 失败(storePath 不可写)→ 客户端 swallow,store 仍有正确值,下次启动可能不一致(同 outputStyle 现状)。✅
- **风险 3**:`Layout.tsx` 改动影响 `useAppStore` destructure,其它消费者侧 46 caller 已有回归测试覆盖。✅
- **回滚**:每个文件改动独立,revert commit 即还原。`ZaiSettings` 加字段是向后兼容(可选)。

## 实施清单(下一步 plan 拆)

1. shared/settings.ts:加 Theme type + theme? 字段
2. zaiSettingsStore.ts:加 VALID_THEMES + resolveTheme + isValidTheme
3. agentSettings.ts:加 PUT /agent/settings/theme + GET 响应加 theme
4. useAppStore.ts:清理注释
5. SettingsDrawer.tsx:handleChange 里 theme 走 PUT
6. Layout.tsx:mount effect hydrate theme
7. 新建 agentSettings-theme.test.ts
8. 跑 vitest / eslint / typecheck