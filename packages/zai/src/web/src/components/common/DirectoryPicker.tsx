import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Spin } from 'antd'
import {
  ArrowUpOutlined, HomeOutlined, ReloadOutlined, FolderOutlined,
} from '@ant-design/icons'
import type { FsPickerEntry, FsPickerList } from '../../../shared/fsPicker.js'

export type DirectoryPickerProps = {
  open: boolean
  initialPath: string
  onCancel: () => void
  onSelect: (path: string) => void
}

// 目录选择器 Modal:跨平台路径处理交由服务端 (routes/fsPicker.ts) 完成,
// 客户端只负责"展示 path + 触发 list"。回填 onSelect 时直接用服务端
// 规范化后的 path —— Windows 上是 `C:\Users\foo` 风格,POSIX 上是
// `/Users/foo` 风格,客户端不做转换 (转换在跨 OS 上不稳定)。
//
// 起点策略:initialPath 优先 (从父表单拿到的 currentCwd),空时让服务端
// 返回 homedir()。这样用户第一次开 modal 时总是落在有意义的目录。
//
// `open=false` 时直接返回 null —— 避免 Modal 在父组件 unmount 前重复
// 挂载两次 (Instances 页内联版本会有此问题)。Instances 旧内联版 +
// QuickCreateModal 共用同一份,行为一致。
export default function DirectoryPicker({
  open, initialPath, onCancel, onSelect,
}: DirectoryPickerProps): JSX.Element | null {
  const [currentPath, setCurrentPath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [entries, setEntries] = useState<FsPickerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const target = initialPath.trim()
    void loadPath(target)
    // 仅在 open 切换时重新触发,避免 initialPath 变化触发额外的 fetch
    // (Instances 页 initialPath 来自 form.getFieldValue,可能在 render 中
    // 变化但不应该触发重复请求)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function loadPath(p: string): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/fs/picker?path=${encodeURIComponent(p)}`
      const res = await fetch(url)
      const data = (await res.json().catch(() => ({}))) as FsPickerList
      if (!res.ok || !data.ok) {
        setError(data.error ?? `请求失败 (HTTP ${res.status})`)
        // 保留 currentPath / entries 不动,只显示错误 — 用户可点上级 / 主页恢复
        return
      }
      setCurrentPath(data.path ?? '')
      setParent(data.parent ?? null)
      setHome(data.home ?? '')
      setEntries(data.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      title="选择工作目录"
      open={open}
      onCancel={onCancel}
      width={640}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel} data-testid="picker-cancel">
          取消
        </Button>,
        <Button
          key="select"
          type="primary"
          disabled={!currentPath || loading}
          onClick={() => {
            onSelect(currentPath)
            // spec §7.1:「选择当前目录」→ onSelect(currentPath) **并** onCancel。
            // Instances.tsx 与 QuickCreateModal 的 onCancel 都关闭 picker,
            // 双保险确保 picker 关闭(父级 onSelect 内通常也 setPickerOpen(false))。
            onCancel()
          }}
          data-testid="picker-select"
        >
          选择当前目录
        </Button>,
      ]}
    >
      <Space style={{ marginBottom: 8 }} wrap>
        <Button icon={<HomeOutlined />} disabled={!home} onClick={() => void loadPath(home)}>
          主页
        </Button>
        <Button icon={<ArrowUpOutlined />} disabled={!parent} onClick={() => parent && void loadPath(parent)}>
          上级
        </Button>
        <Button icon={<ReloadOutlined />} disabled={!currentPath || loading} onClick={() => void loadPath(currentPath)}>
          刷新
        </Button>
      </Space>
      <Input
        value={currentPath}
        readOnly
        // 在窄屏上 (<640px) 让 input 占满一行;Windows 长路径 (C:\Users\...) 也不溢出
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <div
        data-testid="quick-directory-picker"
        style={{
          marginTop: 8,
          minHeight: 240,
          maxHeight: 360,
          overflowY: 'auto',
          border: '1px solid var(--border-light)',
          borderRadius: 4,
          background: 'var(--bg-popup)',
          padding: '4px 0',
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : entries.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--text-dim-45)',
              fontSize: 12,
            }}
          >
            空目录
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              data-testid={`picker-entry-${entry.name}`}
              onClick={() => void loadPath(entry.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void loadPath(entry.path)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                color: 'var(--text-dim-85)',
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
              // hover 背景用 CSS 变量 --bg-faint-06,亮/暗主题各自的值在
              // index.css 的 :root / :root[data-theme='light'] 已定义
              // (暗: rgba(255,255,255,0.06);亮: rgba(0,0,0,0.06))。
              // 直接写 rgba(255,255,255,0.06) 在亮主题下基本不可见。
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <span style={{ width: 16, textAlign: 'center' }}>
                <FolderOutlined />
              </span>
              <span style={{ flex: 1 }}>{entry.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim-45)' }}>打开</span>
            </div>
          ))
        )}
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginTop: 8 }}
          data-testid="picker-error"
        />
      )}
    </Modal>
  )
}