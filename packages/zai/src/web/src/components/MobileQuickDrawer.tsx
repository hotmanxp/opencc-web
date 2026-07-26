import { useState } from 'react'
import { Drawer, Segmented, Button, Input, App as AntApp, Tag, Modal, Empty } from 'antd'
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import { useQuickPrompts, MAX_TEXT } from '../hooks/useQuickPrompts.js'
import { useSubmitPrompt } from '../hooks/useSubmitPrompt.js'
import { useBashRepl } from '../hooks/useBashRepl.js'
import { useGitStatus } from './splitPane/useGitStatus.js'
import { gitApi } from '../lib/gitApi.js'
import { STATUS_COLORS, STATUS_LABELS } from './splitPane/shared.js'
import { message } from 'antd'

type TabKey = 'bash' | 'prompt' | 'diff'

export interface MobileQuickDrawerProps {
  open: boolean
  onClose: () => void
}

export default function MobileQuickDrawer({ open, onClose }: MobileQuickDrawerProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const status = useAgentStore((s) => s.status)
  const cwdBySession = useAgentStore((s) => s.cwdBySession)
  const cwd = sessionId ? cwdBySession[sessionId] ?? null : null
  const { topCommands, refreshTopCommands, exec } = useBashRepl(
    sessionId ?? activeSessionId ?? null,
    cwd,
  )
  const { prompts, add, remove, clear } = useQuickPrompts()
  const { submitPrompt } = useSubmitPrompt()
  const [tab, setTab] = useState<TabKey>('bash')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const effectiveSid = sessionId ?? activeSessionId

  async function handleBashClick(command: string) {
    if (!effectiveSid) return
    try {
      const result = await exec(command)
      if (result.ok) {
        message.success(`已执行: ${command}`)
      } else if ('busy' in result && result.busy) {
        message.warning('已有命令在执行')
      }
    } catch (err) {
      message.error(`执行失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      onClose()
    }
  }

  async function handlePromptClick(text: string) {
    if (status === 'streaming') {
      message.warning('请等待当前回复结束')
      return
    }
    try {
      await submitPrompt(text)
    } catch (err) {
      message.error(`提交失败: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    onClose()
  }

  function handleSaveDraft() {
    const trimmed = draft.trim()
    if (!trimmed) {
      message.warning('内容不能为空')
      return
    }
    const added = add(trimmed)
    if (!added) {
      if (trimmed.length > MAX_TEXT) message.warning(`最多 ${MAX_TEXT} 字`)
      else message.warning('已存在相同内容')
      return
    }
    setDraft('')
    setAdding(false)
    message.success('已保存为常用指令')
  }

  return (
    <Drawer
      title="常用指令"
      placement="right"
      width="85%"
      open={open}
      onClose={onClose}
      maskClosable
      styles={{ body: { padding: 12 } }}
      data-testid="mobile-quick-drawer"
      extra={
        <Button
          type="text"
          size="small"
          onClick={onClose}
          aria-label="关闭"
        >
          ✕
        </Button>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Segmented<'bash' | 'prompt' | 'diff'>
          block
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { label: '快捷 Bash', value: 'bash' },
            { label: '常用指令', value: 'prompt' },
            { label: 'Diff', value: 'diff' },
          ]}
        />
      </div>

      {tab === 'bash' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void refreshTopCommands()}
              data-testid="mobile-quick-drawer-bash-refresh"
            >
              刷新
            </Button>
          </div>
          {!effectiveSid && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              请先开启会话
            </div>
          )}
          {effectiveSid && topCommands.length === 0 && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              暂无历史命令
            </div>
          )}
          {effectiveSid && topCommands.map((entry) => (
            <div
              key={entry.command}
              role="button"
              tabIndex={0}
              onClick={() => void handleBashClick(entry.command)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void handleBashClick(entry.command)
                }
              }}
              data-testid={`mobile-quick-drawer-bash-row-${entry.command}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 13,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.command}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, flexShrink: 0 }}>
                ×{entry.count}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'prompt' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setAdding((v) => !v)}
              data-testid="mobile-quick-drawer-prompt-add"
            >
              新增
            </Button>
          </div>
          {adding && (
            <div style={{ marginBottom: 12 }}>
              <AntApp>
                <Input.TextArea
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`输入常用指令 (${MAX_TEXT} 字以内)`}
                  maxLength={MAX_TEXT}
                  data-testid="mobile-quick-drawer-prompt-input"
                />
              </AntApp>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  type="primary"
                  size="small"
                  onClick={handleSaveDraft}
                  data-testid="mobile-quick-drawer-prompt-save"
                >
                  保存
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setAdding(false)
                    setDraft('')
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
          {!effectiveSid && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              无会话
            </div>
          )}
          {effectiveSid && prompts.length === 0 && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              暂无常用指令,点「+ 新增」添加
            </div>
          )}
          {effectiveSid && prompts.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => void handlePromptClick(p.text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void handlePromptClick(p.text)
                }
              }}
              data-testid={`mobile-quick-drawer-prompt-row-${p.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.text}
              </span>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation()
                  remove(p.id)
                }}
                aria-label="删除"
              />
            </div>
          ))}
          {effectiveSid && prompts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Button
                danger
                type="text"
                size="small"
                icon={<ClearOutlined />}
                onClick={clear}
                data-testid="mobile-quick-drawer-prompt-clear"
              >
                清空全部
              </Button>
            </div>
          )}
        </div>
      )}

      {tab === 'diff' && (
        <div data-testid="mobile-quick-drawer-diff">
          Diff
        </div>
      )}
    </Drawer>
  )
}
