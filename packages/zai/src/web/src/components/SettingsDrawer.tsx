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
import { Button, Drawer, Modal, Select, message } from 'antd'
import { WeixinBotPanel } from './WeixinBotPanel.js'
import { useAppStore } from '../store/useAppStore'
import { useAgentStore } from '../store/useAgentStore'
import { useInstanceStore } from '../store/useInstanceStore.js'
import { requestRestart, requestStop } from '../lib/systemApi.js'
import type { OutputStyle, WorkMode } from '../../../shared/settings.js'

export type SettingsValue = string | number | boolean

export interface EnumOption {
  value: string
  label: string
  /** 可选补充描述 — 选项浮层里以第二行小字渲染(Agent 行用)。 */
  description?: string
}

export type SettingsRow =
  | { key: string; label: string; kind: 'boolean'; value: boolean }
  | {
      key: string
      label: string
      kind: 'enum'
      value: string
      options: EnumOption[]
      /** 禁用选择(行级,如 code 工作模式下 Agent 强制 default)。 */
      disabled?: boolean
    }
  | {
      key: string
      label: string
      kind: 'number'
      value: number
      min?: number
      max?: number
      step?: number
    }

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

  // number row 编辑模式 — `numberEdit` 是正在编辑的 row.key,null 表示未编辑。
  // `numberEditBuffer` 是输入框临时字符串(用户输入未提交)。
  const [numberEdit, setNumberEdit] = useState<string | null>(null)
  const [numberEditBuffer, setNumberEditBuffer] = useState('')

  // 在选中的 number row 上开启编辑模式 — 用 row 当前 value 初始化 buffer。
  const openNumberEdit = useCallback(
    (row: Extract<SettingsRow, { kind: 'number' }>) => {
      setNumberEdit(row.key)
      setNumberEditBuffer(String(row.value))
    },
    [],
  )

  // 提交当前 buffer:解析成 number,clamp 到 [min, max],触发 onChange,退出编辑。
  const commitNumberEdit = useCallback(() => {
    if (!numberEdit) return
    const row = flatRows.find((r) => r.key === numberEdit)
    if (!row || row.kind !== 'number') {
      setNumberEdit(null)
      return
    }
    const parsed = parseInt(numberEditBuffer, 10)
    if (Number.isFinite(parsed)) {
      let next = parsed
      if (typeof row.min === 'number') next = Math.max(next, row.min)
      if (typeof row.max === 'number') next = Math.min(next, row.max)
      onChange?.(row.key, next)
    }
    setNumberEdit(null)
    setNumberEditBuffer('')
  }, [numberEdit, numberEditBuffer, flatRows, onChange])

  // ± 按钮:对当前 row.value 加/减 step,clamp 到 [min, max]。始终触发 onChange
  // (即便值不变 — 与 opencc /config 一致)。
  const bumpNumber = useCallback(
    (row: Extract<SettingsRow, { kind: 'number' }>, dir: 1 | -1) => {
      const step = row.step ?? 1
      let next = row.value + step * dir
      if (typeof row.min === 'number') next = Math.max(next, row.min)
      if (typeof row.max === 'number') next = Math.min(next, row.max)
      onChange?.(row.key, next)
    },
    [onChange],
  )

  // === 键盘事件 ===
  // 用 window listener 而不是 onKeyDown prop,因为 SettingsList 不一定接收 focus
  // (测试也用 window.dispatchEvent 触发,保证一致性)。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key
      // 0) number row 编辑模式激活 — Escape / Enter 由我们拦截;
      // Backspace / 数字键透传给 input 自身。其它键不冒泡。
      if (numberEdit) {
        if (key === 'Escape') {
          e.preventDefault()
          setNumberEdit(null)
          setNumberEditBuffer('')
          return
        }
        if (key === 'Enter') {
          e.preventDefault()
          commitNumberEdit()
          return
        }
        if (key === 'Backspace' || /^[0-9]$/.test(key)) return
        return
      }
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
        if (selectedRow?.kind === 'enum' && selectedRow.key !== 'workMode' && selectedRow.key !== 'mainAgent') openEnumOverlay(selectedRow)
        else if (selectedRow?.kind === 'number') openNumberEdit(selectedRow)
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
    numberEdit,
    enumOverlay,
    searchMode,
    filteredFlatRows.length,
    selectedRow,
    toggleBoolean,
    openEnumOverlay,
    openNumberEdit,
    commitNumberEdit,
    onClose,
  ])

  return (
    <div
      style={{
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.5,
        padding: '8px 4px',
      }}
      data-testid="settings-list"
    >
      {searchMode && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--text-dim-45)' }}>搜索:</span>
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
              borderBottom: '1px solid var(--border-strong)',
              outline: 'none',
              font: 'inherit',
            }}
          />
        </div>
      )}

      {filteredFlatRows.length === 0 ? (
        <div style={{ color: 'var(--text-dim-45)', padding: '12px 8px' }}>
          无匹配设置项
        </div>
      ) : (
        filteredSchema.map((section, sIdx) => (
          <div key={section.section + sIdx} style={{ marginBottom: 16 }}>
            <div
              data-section-header="true"
              style={{
                color: 'var(--text-dim-55)',
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
              // 行点击:boolean → toggle,enum → 打开选项浮层,number → 进入编辑
              // (inputMode="numeric" 会在移动端弹出数字键盘). 键盘操作保留不变,
              // 这样桌面 / 移动两套交互并行不冲突. +/- 按钮已在内部 stopPropagation,
              // 不会被外层 onClick 重复触发.
              const handleRowClick = () => {
                setSelectedIdx(globalIdx)
                if (row.kind === 'boolean') toggleBoolean(row)
                else if (row.kind === 'enum' && row.key !== 'workMode' && row.key !== 'mainAgent') openEnumOverlay(row)
                else if (row.kind === 'number') openNumberEdit(row)
              }
              return (
                <div
                  key={row.key}
                  data-row-key={row.key}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={handleRowClick}
                  style={{
                    display: 'flex',
                    padding: '3px 12px',
                    background: isSelected
                      ? 'var(--bg-faint-08)'
                      : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      color: isSelected
                        ? 'var(--accent-start)'
                        : 'transparent',
                      fontWeight: 'bold',
                    }}
                  >
                    {isSelected ? '›' : ''}
                  </span>
                  <span style={{ flex: 1 }}>{row.label}</span>
                  {row.kind === 'number' ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Button
                        size="small"
                        data-testid={`number-row-minus-${row.key}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          bumpNumber(row, -1)
                        }}
                        aria-label="decrement"
                      >
                        −
                      </Button>
                      {numberEdit === row.key ? (
                        <input
                          autoFocus
                          data-testid={`number-row-input-${row.key}`}
                          type="text"
                          inputMode="numeric"
                          value={numberEditBuffer}
                          onChange={(e) => setNumberEditBuffer(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 56,
                            textAlign: 'center',
                            background: 'transparent',
                            border: '1px solid var(--border-strong)',
                            outline: 'none',
                            font: 'inherit',
                            padding: '0 4px',
                          }}
                        />
                      ) : (
                        <span
                          data-testid={`number-row-value-${row.key}`}
                          style={{
                            minWidth: 28,
                            textAlign: 'center',
                          }}
                        >
                          {displayValue}
                        </span>
                      )}
                      <Button
                        size="small"
                        data-testid={`number-row-plus-${row.key}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          bumpNumber(row, 1)
                        }}
                        aria-label="increment"
                      >
                        +
                      </Button>
                    </span>
                  ) : row.key === 'workMode' && row.kind === 'enum' ? (
                    <Select
                      size="small"
                      value={row.value}
                      options={row.options}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(value) => onChange?.(row.key, value)}
                      style={{ minWidth: 82, maxWidth: 110 }}
                      aria-label="选择工作模式"
                    />
                  ) : row.key === 'mainAgent' && row.kind === 'enum' ? (
                    // Agent 用 antd 下拉:dropdown 里每项两行(名称 + 描述),
                    // 名称用主文字色、描述用小号弱化色;trigger 只显示名称。
                    // code 工作模式下强制使用 default,下拉禁用(联动见组件内
                    // workMode ↔ mainAgent effect)。
                    <Select
                      size="small"
                      value={row.value}
                      options={row.options}
                      disabled={row.disabled === true}
                      popupMatchSelectWidth={false}
                      dropdownStyle={{ minWidth: 280 }}
                      optionRender={(option) => {
                        const d = option.data
                        return (
                          <div style={{ lineHeight: 1.4 }}>
                            <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>
                              {d.label}
                            </div>
                            {d.description && (
                              <div
                                style={{
                                  color: 'var(--text-dim-40)',
                                  fontSize: 11,
                                  marginTop: 2,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {d.description}
                              </div>
                            )}
                          </div>
                        )
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(value) => onChange?.(row.key, value)}
                      style={{ minWidth: 100, maxWidth: 140 }}
                      aria-label="选择 Agent"
                    />
                  ) : (
                    <span
                      style={{
                        color: 'var(--text-dim-65)',
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
            background: 'var(--bg-theme-6)',
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
              background: 'var(--bg-popup)',
              border: '1px solid var(--border-light)',
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
                      ? 'rgba(249, 115, 22, 0.15)'
                      : 'transparent',
                    color: isHighlight
                      ? 'var(--accent-start)'
                      : 'var(--ui-text-color)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    onChange?.(enumOverlay.rowKey, opt.value)
                    setEnumOverlay(null)
                  }}
                >
                  <div style={{ lineHeight: 1.4 }}>{opt.label}</div>
                  {opt.description && (
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.4,
                        marginTop: 2,
                        color: isHighlight
                          ? 'var(--accent-start)'
                          : 'var(--text-dim-40)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {opt.description}
                    </div>
                  )}
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
  if (row.kind === 'number') return String(row.value)
  // enum: 显示当前 option.label
  const opt = row.options.find((o) => o.value === row.value)
  return opt?.label ?? row.value
}

// === SettingsDrawer (AntD Drawer 壳) ===

type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'

// 核心运行时(zai patch 2026-08-28 命名统一):settings.coreRuntime 四态。
// 实际生效优先级:--coreRuntime flag / env ZAI_CORE_RUNTIME > 本设置;且
// 运行时只在服务启动 initAgentRuntime 时解析一次,改后需重启实例生效。
type CoreRuntimeOption = 'default' | 'inproc' | 'spawn' | 'repl'

// 阶段 1 schema:对齐 spec 表里的 Model / Permission / Theme / Env Vars 字段,
// 但用 opencc /config 风格文本行代替 Tabs + Form。
//
// 注:这里把 schema 拆成两部分:
//   1) 静态 schema(本组件内置)— boolean / enum 行
//   2) GET /api/agent/settings 拉来的 dynamic rows(可选模型列表)— 拼到 Permission section 之前
// 阶段 1 只渲染静态部分;动态模型行在阶段 2 接真实数据后补上。
function buildStaticSchema(
  theme: Theme,
  outputStyle: OutputStyle,
  workMode: WorkMode,
  maxVisibleMessages: number,
  defaultSplitScreen: boolean,
  enableDynamicWorkflow: boolean,
  autoUpdate: boolean,
  mainAgent: string,
  agentOptions: EnumOption[],
  coreRuntime: CoreRuntimeOption,
): SettingsSchema {
  return [
    {
      section: '工作模式',
      rows: [
        {
          key: 'workMode',
          label: '工作模式',
          kind: 'enum',
          value: workMode,
          options: [
            { value: 'code', label: '代码' },
            { value: 'office', label: '办公' },
            { value: 'general', label: '通用' },
          ],
        },
        {
          // 主 Agent 插槽配置选择(内置 + ~/.zai/main-agents/*.js 外置)。
          // 选项列表由 GET /api/agent/settings 的 mainAgents 动态填充;
          // 生效时机:systemPrompt 槽对新会话生效、tools 槽即时、mcp 槽需重启。
          // 与工作模式关联:code 模式只能使用默认 agent(下拉禁用)。
          key: 'mainAgent',
          label: 'Agent',
          kind: 'enum',
          value: mainAgent,
          options: agentOptions,
          disabled: workMode === 'code',
        },
      ],
    },
    {
      section: '权限',
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
      section: '显示',
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
        // 桌面端打开 Agent 页面时是否默认启动右侧分屏 (File / Git / Bash 面板).
        // 移动端 / 窄屏 (< 1024px) 仍会自动收起,所以这条只对 PC 视口生效.
        // 仅在 localStorage 无显式覆盖时作为种子值 — 用户手动 toggle 后
        // 的选择永远胜出,不会因为修改此设置而被重置.
        {
          key: 'defaultSplitScreen',
          label: '默认启动分屏',
          kind: 'boolean',
          value: defaultSplitScreen,
        },
      ],
    },
    {
      section: '主题',
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
          // 输出样式走 store + settings.json 持久化;'compact' 时
          // MessageListView 默认折叠,工具栏折叠按钮变成"临时展开"覆盖.
          value: outputStyle,
          options: [
            { value: 'default', label: 'default' },
            { value: 'compact', label: 'compact' },
            { value: 'verbose', label: 'verbose' },
          ],
        },
      ],
    },
    {
      section: '语言',
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
    {
      // 动态工作流 toggle — 默认 OFF (workflow 一次会起几十个 sub-agent,
      // 烧大量 token,必须由用户主动打开)。
      // 关闭时 server 端不设 OPENCC_ENABLE_WORKFLOWS → vendor 的
      // isWorkflowsDisabled() 返回 true → WorkflowTool 从工具池里
      // 被过滤掉,LLM 完全看不到这个工具(不是"调用被拒",而是 schema
      // 都不发)。开启时 server 端同步写 process.env,下次 query() 自然生效。
      section: '工作流',
      rows: [
        {
          key: 'enableDynamicWorkflow',
          label: '启用动态工作流',
          kind: 'boolean',
          value: enableDynamicWorkflow,
        },
      ],
    },
    {
      // zai 自身版本自动升级。默认 ON — dev 模式 (ZAI_FROM_GLOBAL_INSTALL
      // 未设) server 端直接 skip,不影响开发体验。关闭后启动时不再跑
      // `npm view @zn-ai/zai version` 也不会 spawn npm install -g。
      // 升级完成后 SSE 推 `app.update.complete` 事件,UpdateNotifier 弹窗
      // 提示「请重启 zai 以生效」— 仅通知,不自动重启(用户决策)。
      section: '更新',
      rows: [
        {
          key: 'autoUpdate',
          label: '自动检测并升级 zai',
          kind: 'boolean',
          value: autoUpdate,
        },
      ],
    },
    {
      // Agent 核心运行时 — 写入 settings.coreRuntime。
      // default:默认进程内 query 链路;inproc:in-process print 多 session
      // 运行时;spawn:子进程 SessionRegistry。改后需重启实例生效
      // (运行时在 initAgentRuntime 一次性解析);env ZAI_CORE_RUNTIME 或
      // --coreRuntime flag 存在时会覆盖本设置。
      section: '运行时',
      rows: [
        {
          key: 'coreRuntime',
          label: 'Agent 运行时',
          kind: 'enum',
          value: coreRuntime,
          options: [
            { value: 'default', label: 'default(默认)', description: '进程内 query 链路 · 重启后生效' },
            { value: 'inproc', label: 'inproc', description: 'in-process print 多 session 运行时 · 重启后生效' },
            { value: 'spawn', label: 'spawn', description: '子进程 SessionRegistry · 重启后生效' },
            { value: 'repl', label: 'repl', description: 'ReplRuntime (P3.1 委托 shared OpenccRuntime) · 重启后生效' },
          ],
        },
      ],
    },
  ]
}

export default function SettingsDrawer() {
  const open = useAppStore((s) => s.settingsDrawerOpen)
  const close = useAppStore((s) => s.closeSettingsDrawer)
  const [weixinOpen, setWeixinOpen] = useState(false)
  const theme = useAppStore((s) => s.settingsTheme)
  const setTheme = useAppStore((s) => s.setSettingsTheme)
  const outputStyle = useAppStore((s) => s.outputStyle)
  const setOutputStyle = useAppStore((s) => s.setOutputStyle)
  const workMode = useAppStore((s) => s.workMode)
  const setWorkMode = useAppStore((s) => s.setWorkMode)
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const setMaxVisibleMessages = useAppStore((s) => s.setMaxVisibleMessages)
  const defaultSplitScreen = useAppStore((s) => s.defaultSplitScreen)
  const setDefaultSplitScreen = useAppStore((s) => s.setDefaultSplitScreen)
  const enableDynamicWorkflow = useAppStore((s) => s.enableDynamicWorkflow)
  const setEnableDynamicWorkflow = useAppStore((s) => s.setEnableDynamicWorkflow)
  const autoUpdate = useAppStore((s) => s.autoUpdate)
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate)
  // 切换 outputStyle 时同步把 transcriptCollapsed 重置为新默认 — 'compact' 切换到
  // 'default' 时立即展开,'default' 切到 'compact' 时立即折叠;避免用户得再点
  // 一次工具栏按钮才生效.
  const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed)
  // 重启按钮"对接到实例管理的重启":用 instanceContext.port 匹配当前正在
  // 访问的 instance(而非 supervisor 的 __current__ 占位),调
  // /api/instances/{id}/restart 走 supervisor 的 stop+start 路径。失败
  // 时回退到 service restart(/api/system/restart → managed-child IPC →
  // supervisor respawn),所以即便当前访问的是 __current__ 也能 fall
  // through 到原始的 system.restarting 链路。详见 useInstanceStore。
  //
  // 拉取 instance 列表刻意延迟到 onOk 时触发(modal 确认后),而不是
  // drawer 打开就拉——这样不会污染"cancel 后 fetch 没被调用"这类测试,
  // 也避免 drawer 在用户浏览其他设置时就触发一次额外请求。
  const instances = useInstanceStore((s) => s.instances)
  const loadInstances = useInstanceStore((s) => s.loadInstances)
  const currentPort = useAppStore((s) => s.instanceContext?.port ?? null)
  // 当前正在访问的 instance:用当前 zai 进程的 port 去 instance 列表里
  // 匹配,匹配上的那一条就是用户浏览器实际访问的 instance(可能是 supervisor
  // 启动的某个 child,也可能就是 supervisor 自己的 __current__ 条目)。
  // 匹配不到说明 instanceSupervisor 还没初始化(比如 zai dev),退回到
  // __current__ 标志位那条。
  const currentInstance = (() => {
    if (currentPort == null) return null
    const byPort = instances.find((s) => s.port === currentPort)
    if (byPort) return byPort
    return instances.find((s) => s.isCurrent) ?? null
  })()

  // 主 Agent 选择:options 与当前值来自 GET /api/agent/settings(mount 时
  // 拉一次);持久化走 PUT /api/agent/settings/main-agent。
  // label = agent name,description 单独带出 —— 选项浮层里两行展示(名称 + 描述)。
  const [mainAgent, setMainAgent] = useState('default')
  const [agentOptions, setAgentOptions] = useState<EnumOption[]>(() => [
    { value: 'default', label: 'default' },
  ])
  // 核心运行时:当前持久化值来自 GET /api/agent/settings.coreRuntime,
  // 修改走 PUT /api/agent/settings/core-runtime(同 mainAgent 模式,
  // 本地 state + 重启后生效)。
  const [coreRuntime, setCoreRuntime] =
    useState<CoreRuntimeOption>('default')
  // 把当前 store 主题映射进 schema(theme 行)
  const [schema, setSchema] = useState<SettingsSchema>(() =>
    buildStaticSchema(theme, outputStyle, workMode, maxVisibleMessages, defaultSplitScreen, enableDynamicWorkflow, autoUpdate, mainAgent, agentOptions, coreRuntime),
  )
  // mount 时拉一次 GET /api/agent/settings → 填充 agentOptions + 当前 mainAgent。
  // destroyOnClose 每次打开都会重新挂载,列表保持新鲜(新增外置 agent 文件后
  // 重开 drawer 即可看到)。
  useEffect(() => {
    let cancelled = false
    fetch('/api/agent/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (cancelled || !data) return
        const list = Array.isArray(data.mainAgents)
          ? (data.mainAgents as Array<{ name: string; description?: string }>)
          : []
        if (list.length > 0) {
          setAgentOptions(
            list.map((a) => ({
              value: a.name,
              label: a.name,
              description: a.description,
            })),
          )
        }
        if (typeof data.mainAgent === 'string') setMainAgent(data.mainAgent)
        if (
          data.coreRuntime === 'default' ||
          data.coreRuntime === 'inproc' ||
          data.coreRuntime === 'spawn' ||
          data.coreRuntime === 'repl'
        ) {
          setCoreRuntime(data.coreRuntime)
        }
      })
      .catch(() => {
        // swallow — 保持默认 'default' 选项
      })
    return () => {
      cancelled = true
    }
  }, [])
  // 同步 store workMode → schema.workMode 行;同时联动 mainAgent 行禁用态
  // (code 模式只能使用默认 agent,职场与 Agent 关联配置见组件内 effect)。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'workMode' && r.kind === 'enum') {
            return { ...r, value: workMode }
          }
          if (r.key === 'mainAgent' && r.kind === 'enum') {
            return { ...r, disabled: workMode === 'code' }
          }
          return r
        }),
      })),
    )
  }, [workMode])
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
  // 同步 store outputStyle → schema.outputStyle 行;store 是 settings.json
  // 持久化的真源,这里仅单向把"已持久化的值"投影到 schema 渲染态.
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'outputStyle' && r.kind === 'enum') {
            return { ...r, value: outputStyle }
          }
          return r
        }),
      })),
    )
  }, [outputStyle])
  // 同步 store maxVisibleMessages → schema.maxVisibleMessages 行。
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
  // 同步 store defaultSplitScreen → schema.defaultSplitScreen 行;store 是
  // settings.json 持久化的真源,这里仅单向把已持久化的值投影到 schema 渲染态,
  // 跟 outputStyle / maxVisibleMessages 行的同步策略一致。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'defaultSplitScreen' && r.kind === 'boolean') {
            return { ...r, value: defaultSplitScreen }
          }
          return r
        }),
      })),
    )
  }, [defaultSplitScreen])
  // 同步 store enableDynamicWorkflow → schema 行。store 是持久化真源,
  // 这里单向投影,跟 defaultSplitScreen 策略一致。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'enableDynamicWorkflow' && r.kind === 'boolean') {
            return { ...r, value: enableDynamicWorkflow }
          }
          return r
        }),
      })),
    )
  }, [enableDynamicWorkflow])
  // 同步 store autoUpdate → schema 行。跟 enableDynamicWorkflow 完全对称:
  // store 是 settings.json 持久化的真源,单向投影,不改用户输入。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'autoUpdate' && r.kind === 'boolean') {
            return { ...r, value: autoUpdate }
          }
          return r
        }),
      })),
    )
  }, [autoUpdate])
  // 同步 mainAgent → schema 行(本地 state,选择后 PUT 持久化)。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'mainAgent' && r.kind === 'enum') {
            return { ...r, value: mainAgent }
          }
          return r
        }),
      })),
    )
  }, [mainAgent])
  // 同步 coreRuntime → schema 行(本地 state,选择后 PUT 持久化)。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'coreRuntime' && r.kind === 'enum') {
            return { ...r, value: coreRuntime }
          }
          return r
        }),
      })),
    )
  }, [coreRuntime])
  // 同步 agentOptions → schema 行(拉取 mainAgents 列表后更新 options)。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'mainAgent' && r.kind === 'enum') {
            return { ...r, options: agentOptions }
          }
          return r
        }),
      })),
    )
  }, [agentOptions])

  // 工作模式 ↔ Agent 关联配置:
  //   - code:只能使用默认 agent —— 强制切换为 default 并持久化(Agent 下拉同时禁用)
  //   - office:默认 Office —— 仅当 Agent 仍是 default(未显式选过)时自动切到 office,
  //     尊重用户显式选择(agent-creator / skill-writer 等保持不动)
  //   - general:不约束,自由选择
  // deps 同时监听 mainAgent:用户手动改 Agent 后重算一次约束,但 code 分支在改成
  // default 后自然终止(幂等),不会造成循环 PUT。
  useEffect(() => {
    if (workMode === 'code' && mainAgent !== 'default') {
      setMainAgent('default')
      void fetch('/api/agent/settings/main-agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainAgent: 'default' }),
      }).catch(() => {
        // swallow — 下次 GET 会重新对齐磁盘状态
      })
    } else if (workMode === 'office' && mainAgent === 'default') {
      setMainAgent('office')
      void fetch('/api/agent/settings/main-agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainAgent: 'office' }),
      }).catch(() => {
        // swallow — 下次 GET 会重新对齐磁盘状态
      })
    }
  }, [workMode, mainAgent])

  const handleChange = useCallback(
    (key: string, value: SettingsValue) => {
      if (key === 'workMode' && typeof value === 'string') {
        const next = value as WorkMode
        setWorkMode(next)
        void fetch('/api/agent/settings/work-mode', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workMode: next }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // 主 Agent 选择走完整持久化路径。生效时机见设计 spec:systemPrompt
      // 槽对新会话生效、tools 槽即时、mcp 槽需重启。
      if (key === 'mainAgent' && typeof value === 'string') {
        setMainAgent(value)
        void fetch('/api/agent/settings/main-agent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mainAgent: value }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
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
      // 输出样式走完整持久化路径:写 store 让 MessageListView 立即生效,
      // 同时 PUT settings.json 跨刷新保存.失败不打断 UI(下次启动仍可重写).
      // 同步把 transcriptCollapsed 重置为新默认:
      //   - 'compact' → true (折叠)
      //   - 'default' / 'verbose' → false (展开)
      if (key === 'outputStyle' && typeof value === 'string') {
        const next = value as OutputStyle
        setOutputStyle(next)
        setTranscriptCollapsed(next === 'compact')
        void fetch('/api/agent/settings/output-style', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outputStyle: next }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // 消息最大显示条数走 store + PUT settings.json 持久化路径(同 outputStyle):
      // clamp 到 [1, 1000] 再写 store,server 端会再做一次 floor + clamp 兜底.
      if (key === 'maxVisibleMessages' && typeof value === 'number') {
        const clamped = Math.max(1, Math.min(1000, Math.floor(value)))
        setMaxVisibleMessages(clamped)
        void fetch('/api/agent/settings/max-visible-messages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: clamped }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // "默认启动分屏" 走 store + PUT settings.json 持久化路径 — 同上.
      // 注意:这只是一个"首次启动种子值",不会立即重新打开已经关闭的分屏;
      // 已 toggle 过 splitPane 的用户偏好永远胜出(见 SplitPane first-run seed).
      if (key === 'defaultSplitScreen' && typeof value === 'boolean') {
        setDefaultSplitScreen(value)
        void fetch('/api/agent/settings/default-split-screen', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // "启用动态工作流" 走 store + PUT settings.json 持久化路径。
      // server PUT handler 同步写 process.env.OPENCC_ENABLE_WORKFLOWS,
      // 下次 query() 触发的 getAllBaseTools() 会把 WorkflowTool 加进
      // 工具池(或从中过滤掉)。关闭时 WorkflowTool 直接消失 — LLM
      // 看不到这个工具的 schema,不只是"调用被拒"。
      if (key === 'enableDynamicWorkflow' && typeof value === 'boolean') {
        setEnableDynamicWorkflow(value)
        void fetch('/api/agent/settings/enable-dynamic-workflow', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // zai 自升级 toggle — 写 store 让 settings UI 立即翻牌,PUT
      // settings.json 让下次启动生效。运行中的 install 不会被中途
      // 取消,这是 PUT route 注释里说明的 by-design。
      if (key === 'autoUpdate' && typeof value === 'boolean') {
        setAutoUpdate(value)
        void fetch('/api/agent/settings/auto-update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
      // 核心运行时 — PUT settings.coreRuntime。运行时在
      // initAgentRuntime 一次性解析,改后需重启实例生效,提示用户。
      if (key === 'coreRuntime' && typeof value === 'string') {
        const next = value as CoreRuntimeOption
        setCoreRuntime(next)
        void fetch('/api/agent/settings/core-runtime', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coreRuntime: next }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((data: { coreRuntime?: unknown }) => {
            if (typeof data?.coreRuntime === 'string') {
              setCoreRuntime(data.coreRuntime as CoreRuntimeOption)
            }
            message.info('运行时已保存,重启 zai 后生效')
          })
          .catch(() => {
            message.warning('运行时保存失败,下次 GET 会重新对齐磁盘状态')
          })
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
            if (r.kind === 'number' && typeof value === 'number') {
              return { ...r, value }
            }
            return r
          }),
        })),
      )
    },
    [setTheme, setOutputStyle, setWorkMode, setTranscriptCollapsed, setMaxVisibleMessages, setDefaultSplitScreen, setEnableDynamicWorkflow, setAutoUpdate],
  )

  // 整个"服务"section 仅在「instance 子实例」(instance manager 派生的子进程,
  // 带 ZAI_INSTANCE_ID)时显示:
  //   - instance 子实例的「重启」走 /api/system/restart → IPC 'restart' 发给
  //     instanceSupervisor 所在进程,instanceSupervisor 收到后 stop+start
  //     重新拉起该实例(见 instanceSupervisor.ts child.on('message') 的 restart
  //     分支);「关闭」走 /api/system/stop → cleanupAndExit,进程退出后由
  //     exit handler 收尾。两条按钮只影响当前这一个子实例。
  //   - 顶层受管服务(supervisor 直接派生的 child,无 ZAI_INSTANCE_ID)是
  //     supervisor 的管理入口:重启它相当于重启整个实例群(supervisor 拒绝
  //     重启自己,fallback 走 system restart 会连带其他实例),关闭它等于关闭
  //     所有实例,单实例的"重启/关闭"控制不该暴露在管理入口上。
  //   - 独立 zai-server(ZAI_SUPERVISOR_PID 未设)没有 supervisor 可以委托,
  //     调 /api/system/stop / restart 会直接 409 'not_managed',按钮没用。
  //
  // isManagedChild 由 Layout 在 GET /api/system hydrate 时灌进 instanceContext,
  // 详见 useAppStore + Layout.tsx。initState 时(instanceContext 还没 hydrate)
  // 这里取 undefined → 不显示,这是预期:用户冷启动首屏不应有按钮。
  const isManagedChild = useAppStore((s) => s.instanceContext?.isManagedChild === true)
  const instanceId = useAppStore((s) => s.instanceContext?.instanceId ?? null)
  const showServiceSection = isManagedChild && instanceId != null

  if (!open) return null

  return (
    <>
    <Drawer
      title="设置"
      width={400}
      placement="left"
      open={open}
      onClose={close}
      destroyOnClose
      data-testid="settings-drawer"
      extra={
        // TODO: 微信机器人暂时不开放,需要恢复时取消下面的 false 包裹
        false ? (
          <Button
            size="small"
            onClick={() => setWeixinOpen(true)}
            data-testid="open-weixin-bot"
          >
            微信机器人
          </Button>
        ) : null
      }
      styles={{ body: { padding: '12px 16px' } }}
      footer={
        <div style={{ fontSize: 11, color: 'var(--text-dim-45)' }}>
          Space 修改 · Enter 弹出选项 · / 搜索 · Esc 取消
        </div>
      }
    >
      {open && showServiceSection && (
        <div
          data-testid="settings-service-section"
          style={{
            marginBottom: 16,
            padding: 12,
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>服务</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              danger
              onClick={() => {
                Modal.confirm({
                  title: '重启服务?',
                  content: '将会中断当前对话与后台任务,确定?',
                  okText: '重启',
                  cancelText: '取消',
                  onOk: async () => {
                    // 优先走实例管理重启:从 useInstanceStore 拿当前正在
                    // 访问的 instance,调 /api/instances/{id}/restart(走
                    // supervisor 的 stop+start 路径,与实例管理页面"重启"
                    // 按钮完全一致的逻辑)。这条路径在 zai start --managed
                    // 下可用,且对 supervisor 启动的其他 instance 也成立。
                    //
                    // Fallback 触发条件:
                    //   - 当前 instance 是 supervisor 自己的 __current__,
                    //     supervisor 拒绝重启自己(避免自杀循环)
                    //   - store 里没找到匹配 port 的 instance
                    //   - 实例 API 返回 4xx/5xx
                    // 全部走 /api/system/restart(managed-child IPC →
                    // supervisor respawn),与原先"重启服务"按钮语义一致。
                    //
                    // store 空时按需触发一次拉取——日常 layout hydrate 已
                    // 拉过,这里只兜底冷启动/缓存失败的边角场景。
                    let target = currentInstance
                    if (!target) {
                      await loadInstances().catch(() => {})
                      const fresh = useInstanceStore.getState().instances
                      const port = useAppStore.getState().instanceContext?.port ?? null
                      target = port != null ? fresh.find((s) => s.port === port) ?? null : null
                      if (!target) target = fresh.find((s) => s.isCurrent) ?? null
                    }
                    if (target && target.id !== '__current__') {
                      try {
                        const res = await fetch(
                          `/api/instances/${encodeURIComponent(target.id)}/restart`,
                          { method: 'POST' },
                        )
                        if (res.ok) return
                        // 4xx/5xx → fallback 到 service restart
                        const errBody = (await res.json().catch(() => ({}))) as {
                          error?: string
                        }
                        message.warning(
                          errBody.error
                            ? `实例重启失败,回退到服务重启: ${errBody.error}`
                            : '实例重启失败,回退到服务重启',
                        )
                      } catch (err) {
                        message.warning(
                          `实例重启请求失败,回退到服务重启: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        )
                      }
                    }
                    await requestRestart('user_action')
                  },
                })
              }}
            >
              重启服务
            </Button>
            <Button
              danger
              data-testid="settings-shutdown-service"
              onClick={() => {
                Modal.confirm({
                  title: '关闭服务?',
                  content: '将停止整个 zai 进程,需要手动重启才能恢复访问。',
                  okText: '关闭',
                  cancelText: '取消',
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    // 与"重启服务"不同:关闭服务没有实例级别 fallback,
                    // 没有 fallback 路径——浏览器本身就在这个被关闭的 instance 上,
                    // 无法在它自己请求到达后还路由回 supervisor。直接走
                    // /api/system/stop,服务端 drain in-flight → exit →
                    // supervisor 看到无 pendingRestart → 正常退出。
                    await requestStop()
                  },
                })
              }}
            >
              关闭服务
            </Button>
          </div>
        </div>
      )}
      <SettingsList schema={schema} onClose={close} onChange={handleChange} />
    </Drawer>
    <WeixinBotPanel open={weixinOpen} onClose={() => setWeixinOpen(false)} />
    </>
  )
}