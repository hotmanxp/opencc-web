/**
 * SettingsDrawer — opencc /config 风格的设置面板。
 *
 * 设计目标:对齐 opencc 上游 Config TUI(opencc/src/components/Settings/Config.tsx),
 * 而不是 AntD Form/Drawer 表单样式。Drawer 仅作为右侧容器,内部渲染为紧凑文本行:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Permission                                    │
 *   │   > 自动压缩                            true │
 *   │     工具历史压缩                        true │
 *   │     思考模式                            true │
 *   │ Theme                                        │
 *   │     主题                            Dark mode │
 *   │     默认权限模式              Bypass Permissions │
 *   │  ↓ 1 more below                              │
 *   └──────────────────────────────────────────────┘
 *   Space 修改 · Enter 弹出选项 · / 搜索 · Esc 取消
 *
 * 键盘交互(对齐 opencc):
 *   ↑↓          移动光标(跳过 section header)
 *   Space       toggle boolean row
 *   Enter       在 enum row 上弹下拉; ↑↓ 选, Enter 确认, Esc 取消
 *   /           进入搜索;输入过滤;Esc 退出搜索(保留完整列表)
 *   Esc         关闭 drawer(无搜索、无浮层时)
 *
 * 阶段 1:本组件不实际持久化,只通过 onChange 回调把 (key, newValue) 传出去;
 * onChange 由父组件 SettingsDrawer 接到 store / 写盘动作(后续阶段)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from 'antd'
import { useAppStore } from '../store/useAppStore'

export type SettingsValue = string | number | boolean

export interface EnumOption {
  value: string
  label: string
}

export type SettingsRow =
  | { key: string; label: string; kind: 'boolean'; value: boolean }
  | { key: string; label: string; kind: 'enum'; value: string; options: EnumOption[] }

export interface SettingsSection {
  section: string
  rows: SettingsRow[]
}

export type SettingsSchema = SettingsSection[]

export interface SettingsListProps {
  schema: SettingsSchema
  onClose: () => void
  onChange?: (key: string, value: SettingsValue) => void
}

// === SettingsList (可独立测试的内部组件) ===

export function SettingsList({ schema, onClose, onChange }: SettingsListProps) {
  // 把 schema 拍扁成 row 列表(跳过 section header)— 便于光标索引。
  const flatRows = useMemo(() => schema.flatMap((s) => s.rows), [schema])

  const [selectedIdx, setSelectedIdx] = useState(0)
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // 枚举下拉浮层:`{ rowKey, options, selectedIdx }` — null 表示未打开。
  const [enumOverlay, setEnumOverlay] = useState<{
    rowKey: string
    options: EnumOption[]
    selectedIdx: number
  } | null>(null)

  // 搜索过滤后的 row + section 列表。空匹配 → 显示空提示,不显示 row(也不修改 selectedIdx)。
  const filteredSchema = useMemo(() => {
    if (!searchMode || !searchQuery) return schema
    const q = searchQuery.toLowerCase()
    return schema
      .map((s) => ({
        section: s.section,
        rows: s.rows.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.key.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.rows.length > 0)
  }, [schema, searchMode, searchQuery])

  const filteredFlatRows = useMemo(
    () => filteredSchema.flatMap((s) => s.rows),
    [filteredSchema],
  )

  // 进入搜索 / 清空搜索时,clamp selectedIdx 到当前可见 row 范围。
  useEffect(() => {
    if (selectedIdx >= filteredFlatRows.length) {
      setSelectedIdx(Math.max(0, filteredFlatRows.length - 1))
    }
  }, [filteredFlatRows.length, selectedIdx])

  // 同步:枚举浮层当前选中项跟着 row 当前 value 走 — 只在 row 外部值变化时同步,
  // 不能因为用户自己在浮层里按 ↑↓ 改了 selectedIdx 又被 effect 拉回去。
  // 用 ref 记录上次同步时的 row.value,只有当外部 row.value 真的变了才 reset。
  const lastSyncedValueRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enumOverlay) {
      lastSyncedValueRef.current = null
      return
    }
    const row = flatRows.find((r) => r.key === enumOverlay.rowKey)
    if (!row || row.kind !== 'enum') return
    // 只在浮层刚打开 / row.value 外部变化时同步一次;用户主动导航不要被覆盖
    if (lastSyncedValueRef.current === row.value) return
    lastSyncedValueRef.current = row.value
    const idx = row.options.findIndex((o) => o.value === row.value)
    if (idx >= 0 && idx !== enumOverlay.selectedIdx) {
      setEnumOverlay({ ...enumOverlay, selectedIdx: idx })
    }
  }, [enumOverlay, flatRows])

  const selectedRow = filteredFlatRows[selectedIdx]

  // 切换 boolean row 的内部逻辑(同时通知外部)。
  const toggleBoolean = useCallback(
    (row: Extract<SettingsRow, { kind: 'boolean' }>) => {
      const next = !row.value
      onChange?.(row.key, next)
    },
    [onChange],
  )

  // 在 enum row 上打开浮层。
  const openEnumOverlay = useCallback(
    (row: Extract<SettingsRow, { kind: 'enum' }>) => {
      const idx = row.options.findIndex((o) => o.value === row.value)
      setEnumOverlay({
        rowKey: row.key,
        options: row.options,
        selectedIdx: idx >= 0 ? idx : 0,
      })
    },
    [],
  )

  // === 键盘事件 ===
  // 用 window listener 而不是 onKeyDown prop,因为 SettingsList 不一定接收 focus
  // (测试也用 window.dispatchEvent 触发,保证一致性)。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key
      // 1) 枚举浮层激活时优先处理浮层交互
      if (enumOverlay) {
        if (key === 'Escape') {
          e.preventDefault()
          setEnumOverlay(null)
          return
        }
        if (key === 'ArrowDown') {
          e.preventDefault()
          setEnumOverlay({
            ...enumOverlay,
            selectedIdx: (enumOverlay.selectedIdx + 1) % enumOverlay.options.length,
          })
          return
        }
        if (key === 'ArrowUp') {
          e.preventDefault()
          setEnumOverlay({
            ...enumOverlay,
            selectedIdx:
              (enumOverlay.selectedIdx - 1 + enumOverlay.options.length) %
              enumOverlay.options.length,
          })
          return
        }
        if (key === 'Enter') {
          e.preventDefault()
          const opt = enumOverlay.options[enumOverlay.selectedIdx]
          if (opt) {
            onChange?.(enumOverlay.rowKey, opt.value)
          }
          setEnumOverlay(null)
          return
        }
        return // 浮层打开时其它键不冒泡
      }

      // 2) 搜索模式激活 — 输入框自身捕获字符,我们只处理 Esc 退出
      if (searchMode) {
        if (key === 'Escape') {
          e.preventDefault()
          setSearchMode(false)
          // 不清空 query,但退出后回到完整 schema;query 状态保留以便快速再进入
          return
        }
        return
      }

      // 3) 主列表导航
      if (key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, filteredFlatRows.length - 1))
        return
      }
      if (key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (key === ' ') {
        e.preventDefault()
        if (selectedRow?.kind === 'boolean') toggleBoolean(selectedRow)
        return
      }
      if (key === 'Enter') {
        e.preventDefault()
        if (selectedRow?.kind === 'enum') openEnumOverlay(selectedRow)
        return
      }
      if (key === '/') {
        e.preventDefault()
        setSearchMode(true)
        return
      }
      if (key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    enumOverlay,
    searchMode,
    filteredFlatRows.length,
    selectedRow,
    toggleBoolean,
    openEnumOverlay,
    onClose,
  ])

  return (
    <div
      style={{
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.5,
        color: 'rgba(255,255,255,0.85)',
        padding: '8px 4px',
      }}
      data-testid="settings-list"
    >
      {searchMode && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'rgba(255,255,255,0.45)' }}>搜索:</span>
          <input
            data-testid="settings-search-input"
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入关键词过滤…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid rgba(255,255,255,0.3)',
              color: 'rgba(255,255,255,0.85)',
              outline: 'none',
              font: 'inherit',
            }}
          />
        </div>
      )}

      {filteredFlatRows.length === 0 ? (
        <div style={{ color: 'rgba(255,255,255,0.45)', padding: '12px 8px' }}>
          无匹配设置项
        </div>
      ) : (
        filteredSchema.map((section, sIdx) => (
          <div key={section.section + sIdx} style={{ marginBottom: 16 }}>
            <div
              data-section-header="true"
              style={{
                color: 'rgba(255,255,255,0.55)',
                fontWeight: 600,
                textTransform: 'uppercase',
                fontSize: 11,
                letterSpacing: 0.5,
                marginBottom: 4,
                paddingLeft: 12,
              }}
            >
              {section.section}
            </div>
            {section.rows.map((row) => {
              // 把 row 映射回 flatRows 里的全局索引,用于 selected 判定。
              const globalIdx = filteredFlatRows.findIndex((r) => r.key === row.key)
              const isSelected = globalIdx === selectedIdx
              const displayValue = formatValue(row)
              return (
                <div
                  key={row.key}
                  data-row-key={row.key}
                  data-selected={isSelected ? 'true' : 'false'}
                  style={{
                    display: 'flex',
                    padding: '3px 12px',
                    background: isSelected
                      ? 'rgba(255,255,255,0.08)'
                      : 'transparent',
                    cursor: 'default',
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      color: isSelected
                        ? 'rgb(99, 226, 183)'
                        : 'transparent',
                      fontWeight: 'bold',
                    }}
                  >
                    {isSelected ? '›' : ''}
                  </span>
                  <span style={{ flex: 1 }}>{row.label}</span>
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
                </div>
              )
            })}
          </div>
        ))
      )}

      {enumOverlay && (
        <div
          data-testid="settings-enum-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setEnumOverlay(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1f1f1f',
              border: '1px solid rgba(255,255,255,0.15)',
              padding: '12px 0',
              minWidth: 280,
              maxWidth: 480,
              borderRadius: 4,
            }}
          >
            {enumOverlay.options.map((opt, idx) => {
              const isHighlight = idx === enumOverlay.selectedIdx
              return (
                <div
                  key={opt.value}
                  data-overlay-option-value={opt.value}
                  data-overlay-highlight={isHighlight ? 'true' : 'false'}
                  style={{
                    padding: '6px 16px',
                    background: isHighlight
                      ? 'rgba(99, 226, 183, 0.15)'
                      : 'transparent',
                    color: isHighlight
                      ? 'rgb(99, 226, 183)'
                      : 'rgba(255,255,255,0.85)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    onChange?.(enumOverlay.rowKey, opt.value)
                    setEnumOverlay(null)
                  }}
                >
                  {opt.label}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function formatValue(row: SettingsRow): string {
  if (row.kind === 'boolean') return row.value ? 'true' : 'false'
  // enum: 显示当前 option.label
  const opt = row.options.find((o) => o.value === row.value)
  return opt?.label ?? row.value
}

// === SettingsDrawer (AntD Drawer 壳) ===

type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'

// 阶段 1 schema:对齐 spec 表里的 Model / Permission / Theme / Env Vars 字段,
// 但用 opencc /config 风格文本行代替 Tabs + Form。
//
// 注:这里把 schema 拆成两部分:
//   1) 静态 schema(本组件内置)— boolean / enum 行
//   2) GET /api/agent/settings 拉来的 dynamic rows(可选模型列表)— 拼到 Permission section 之前
// 阶段 1 只渲染静态部分;动态模型行在阶段 2 接真实数据后补上。
function buildStaticSchema(theme: Theme): SettingsSchema {
  return [
    {
      section: 'Permission',
      rows: [
        { key: 'autoCompact', label: '自动压缩', kind: 'boolean', value: true },
        { key: 'toolCompact', label: '工具历史压缩', kind: 'boolean', value: true },
        {
          key: 'cacheStatsDisplay',
          label: '缓存统计显示',
          kind: 'enum',
          value: 'compact',
          options: [
            { value: 'full', label: 'Full' },
            { value: 'compact', label: 'Compact' },
            { value: 'off', label: 'Off' },
          ],
        },
        { key: 'showHints', label: '显示提示', kind: 'boolean', value: true },
        { key: 'reduceMotion', label: '减少动画', kind: 'boolean', value: false },
        { key: 'thinkingMode', label: '思考模式', kind: 'boolean', value: true },
        { key: 'checkpointing', label: '代码回溯(检查点)', kind: 'boolean', value: true },
        { key: 'verbose', label: '详细输出', kind: 'boolean', value: false },
        { key: 'progressBar', label: '终端进度条', kind: 'boolean', value: true },
        {
          key: 'permissionMode',
          label: '默认权限模式',
          kind: 'enum',
          value: 'bypassPermissions',
          options: [
            { value: 'default', label: 'Default' },
            { value: 'acceptEdits', label: 'Accept Edits' },
            { value: 'plan', label: 'Plan' },
            { value: 'bypassPermissions', label: 'Bypass Permissions' },
            { value: 'dontAsk', label: "Don't Ask" },
          ],
        },
        { key: 'gitignore', label: '在文件选择器中尊重 .gitignore', kind: 'boolean', value: true },
        { key: 'copyFull', label: '始终复制完整回复(跳过 /copy 选择器)', kind: 'boolean', value: false },
        { key: 'noFlicker', label: '无闪烁模式', kind: 'boolean', value: false },
      ],
    },
    {
      section: 'Theme',
      rows: [
        {
          key: 'theme',
          label: '主题',
          kind: 'enum',
          value: theme === 'high-contrast' ? 'auto' : theme,
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'dark', label: 'Dark mode' },
            { value: 'light', label: 'Light' },
            { value: 'high-contrast', label: 'High contrast' },
          ],
        },
        {
          key: 'notification',
          label: '通知',
          kind: 'enum',
          value: 'auto',
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ],
        },
        {
          key: 'outputStyle',
          label: '输出样式',
          kind: 'enum',
          value: 'default',
          options: [
            { value: 'default', label: 'default' },
            { value: 'compact', label: 'compact' },
            { value: 'verbose', label: 'verbose' },
          ],
        },
      ],
    },
    {
      section: 'Language',
      rows: [
        {
          key: 'language',
          label: '语言',
          kind: 'enum',
          value: 'chinese',
          options: [
            { value: 'auto', label: 'auto' },
            { value: 'chinese', label: 'chinese' },
            { value: 'english', label: 'english' },
          ],
        },
        {
          key: 'askCountdown',
          label: '问题自动续答倒计时',
          kind: 'enum',
          value: 'off',
          options: [
            { value: 'off', label: '已禁用' },
            { value: '5s', label: '5 秒' },
            { value: '30s', label: '30 秒' },
            { value: '5m', label: '5 分钟' },
          ],
        },
      ],
    },
  ]
}

export default function SettingsDrawer() {
  const open = useAppStore((s) => s.settingsDrawerOpen)
  const close = useAppStore((s) => s.closeSettingsDrawer)
  const theme = useAppStore((s) => s.settingsTheme)
  const setTheme = useAppStore((s) => s.setSettingsTheme)

  // 把当前 store 主题映射进 schema(theme 行)
  const [schema, setSchema] = useState<SettingsSchema>(() => buildStaticSchema(theme))
  // 同步 store theme → schema.theme 行(其它行的 value 内部维护)。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'theme' && r.kind === 'enum') {
            const mapped =
              theme === 'high-contrast' ? 'auto' : theme
            return { ...r, value: mapped }
          }
          return r
        }),
      })),
    )
  }, [theme])

  const handleChange = useCallback(
    (key: string, value: SettingsValue) => {
      // 主题行直接写回 store(阶段 1 不持久化,只 frontend state)
      if (key === 'theme' && typeof value === 'string') {
        setTheme(value as Theme)
      }
      // 其它行目前只更新内部 schema state(阶段 2 接真实写盘)
      setSchema((prev) =>
        prev.map((s) => ({
          ...s,
          rows: s.rows.map((r) => {
            if (r.key !== key) return r
            if (r.kind === 'boolean' && typeof value === 'boolean') {
              return { ...r, value }
            }
            if (r.kind === 'enum' && typeof value === 'string') {
              return { ...r, value }
            }
            return r
          }),
        })),
      )
    },
    [setTheme],
  )

  if (!open) return null

  return (
    <Drawer
      title="设置"
      width={480}
      placement="right"
      open={open}
      onClose={close}
      destroyOnClose
      data-testid="settings-drawer"
      styles={{ body: { padding: '12px 16px' } }}
      footer={
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
          Space 修改 · Enter 弹出选项 · / 搜索 · Esc 取消
        </div>
      }
    >
      <SettingsList schema={schema} onClose={close} onChange={handleChange} />
    </Drawer>
  )
}