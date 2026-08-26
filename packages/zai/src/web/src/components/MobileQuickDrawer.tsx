import { useEffect, useState } from 'react'
import { Drawer, Segmented, Button, Input, App as AntApp, Modal, Empty, Spin } from 'antd'
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useQuickPrompts, MAX_TEXT } from '../hooks/useQuickPrompts.js'
import { useSubmitPrompt } from '../hooks/useSubmitPrompt.js'
import { useBashRepl } from '../hooks/useBashRepl.js'
import { useGitStatus } from './splitPane/useGitStatus.js'
import { useGitDiff } from './splitPane/useGitDiff.js'
import { gitApi } from '../lib/gitApi.js'
import { STATUS_COLORS, useIsGitRepo } from './splitPane/shared.js'
import { DiffView } from './splitPane/DiffView.js'
import BranchSelector from './BranchSelector'
import { message } from 'antd'
import type { GitStatusChar } from '../../../shared/git.js'

type TabKey = 'bash' | 'prompt' | 'git'

export interface MobileQuickDrawerProps {
  open: boolean
  onClose: () => void
}

interface GitTabProps {
  cwd: string | null
}

function GitTab({ cwd }: GitTabProps) {
  const status = useGitStatus(cwd)
  const [selected, setSelected] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)
  const diff = useGitDiff(cwd, selected)

  // cwd 变化时丢弃选中 — 旧路径不再适用.
  useEffect(() => {
    setSelected(null)
  }, [cwd])

  // status 刷新后若 selected 已不在列表里 (撤销/提交),清掉选中让
  // Modal 也跟着关闭.
  const filePaths = status.data?.ok
    ? status.data.files.map((f) => f.path)
    : null
  useEffect(() => {
    if (!selected) return
    if (filePaths && !filePaths.includes(selected)) {
      setSelected(null)
    }
  }, [filePaths, selected])

  const files = status.data?.files ?? []
  const branch = status.data?.branch ?? null

  async function handleRevert(path: string) {
    setReverting(path)
    try {
      const result = await gitApi.revertFile(path)
      if (result.ok) {
        message.success('已撤销')
        status.refetch()
        if (selected === path) setSelected(null)
      } else {
        message.error(result.error ?? '撤销失败')
      }
    } catch (err) {
      message.error(
        `撤销失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setReverting(null)
    }
  }

  function revertWithConfirm(path: string, isNew: boolean) {
    Modal.confirm({
      title: isNew ? '确认删除' : '确认撤销',
      content: isNew
        ? `确定要删除新文件 ${path} 吗?此操作不可恢复。`
        : `确定要撤销对 ${path} 的更改吗?此操作不可恢复。`,
      okText: isNew ? '确认删除' : '确认撤销',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => handleRevert(path),
    })
  }

  return (
    <div data-testid="mobile-quick-drawer-git">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-dim-55)' }}>
          Git
          {/* BranchSelector 内部处理 store 兜底 + 移动端 Popover placement='bottom'.
              cwd 不传(未开启会话)时它退化为只读 span, 跟旧 Tag 行为一致. */}
          <BranchSelector
            cwd={cwd}
            branch={branch ?? '(无)'}
            triggerStyle={{ marginLeft: 6 }}
            testIdPrefix="mobile-branch-"
          />
          <span style={{ marginLeft: 8, color: 'var(--text-dim-35)' }}>
            {files.length} 项变更
          </span>
        </span>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={status.loading}
          onClick={() => status.refetch()}
          data-testid="mobile-quick-drawer-git-refresh"
        >
          刷新
        </Button>
      </div>

      {!cwd && (
        <div style={{ padding: 16 }}>
          <Empty description="请先开启会话" />
        </div>
      )}

      {cwd && status.error && !status.data?.ok && (
        <div style={{ padding: 16 }}>
          <Empty description={status.error} />
        </div>
      )}

      {cwd && !status.error && status.loading && files.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center' }}>
          <Spin />
        </div>
      )}

      {cwd && !status.error && files.length === 0 && !status.loading && (
        <div style={{ color: 'var(--text-dim-45)', padding: 16 }}>
          没有变更
        </div>
      )}

      {cwd &&
        files.map((file) => {
          const isSel = selected === file.path
          return (
            <div
              key={file.path}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(file.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected(file.path)
                }
              }}
              data-testid={`mobile-quick-drawer-git-row-${file.path}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid var(--border-faint)',
                cursor: 'pointer',
                background: isSel ? 'rgba(255,102,0,0.12)' : 'transparent',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 20,
                  textAlign: 'center',
                  color: STATUS_COLORS[file.status as GitStatusChar],
                  fontWeight: 700,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  flexShrink: 0,
                }}
              >
                {file.status === '??' ? '?' : file.status}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 13,
                }}
                title={file.path}
              >
                {file.path}
              </span>
              {file.staged && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'rgba(167,139,250,0.85)',
                    border: '1px solid rgba(167,139,250,0.35)',
                    borderRadius: 3,
                    padding: '0 4px',
                    flexShrink: 0,
                  }}
                >
                  staged
                </span>
              )}
              <Button
                type="text"
                size="small"
                danger
                icon={<UndoOutlined />}
                loading={reverting === file.path}
                onClick={(e) => {
                  e.stopPropagation()
                  revertWithConfirm(file.path, file.status === '??')
                }}
                aria-label={
                  file.status === '??' ? '删除此新文件' : '撤销此文件的更改'
                }
              />
            </div>
          )
        })}

      <Modal
        open={selected !== null}
        title={selected ?? ''}
        onCancel={() => setSelected(null)}
        footer={null}
        width="90%"
        destroyOnClose
        data-testid="mobile-quick-drawer-git-diff-modal"
      >
        {diff.loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : diff.error ? (
          <Empty description={diff.error} />
        ) : diff.data?.diff !== undefined ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <DiffView diff={diff.data.diff} />
          </div>
        ) : (
          <Empty description="没有差异" />
        )}
      </Modal>
    </div>
  )
}

export default function MobileQuickDrawer({ open, onClose }: MobileQuickDrawerProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const status = useAgentStore((s) => s.status)
  const cwdBySession = useAgentStore((s) => s.cwdBySession)
  const instanceContext = useAppStore((s) => s.instanceContext)
  // 对齐 Agent.tsx 的 cwd 计算: instanceContext.cwd 是 server 注入的进程
  // cwd, 冷启动立即可用; cwdBySession[sessionId] 由 SSE cwd.changed 维护,
  // 仅在用户跑过 bash 后才有. 优先取前者.
  const cwd = instanceContext?.cwd
    ? instanceContext.cwd
    : sessionId
      ? cwdBySession[sessionId] ?? null
      : null
  const { topCommands, refreshTopCommands, exec } = useBashRepl(
    sessionId ?? activeSessionId ?? null,
    cwd,
  )
  const { prompts, add, remove, clear } = useQuickPrompts()
  const { submitPrompt } = useSubmitPrompt()
  const [tab, setTab] = useState<TabKey>('bash')
  // 非 git 项目 (instanceContext.branch === null) 时过滤 Git segment (见
  // shared.ts useIsGitRepo). 旧 State 若停在 git,fallback 到 bash 默认项.
  const isGit = useIsGitRepo()
  const effectiveTab: TabKey = tab === 'git' && !isGit ? 'bash' : tab
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const effectiveSid = sessionId ?? activeSessionId

  async function handleBashClick(command: string) {
    if (!effectiveSid) return
    try {
      // wait=true:等服务端真实终态,根据 code/signal 决定 success/error toast。
      // fire-and-forget 模式 (默认) 拿到的是 {ok, execId},无法区分"执行中"和"已失败",
      // 会让用户看到虚假 "已执行" 提示 — 实际命令可能 exit code 非 0 或被信号杀。
      const result = await exec(command, { wait: true })
      if (!result.ok) {
        if ('busy' in result && result.busy) {
          message.warning('已有命令在执行')
        }
        return
      }
      // ok:true + wait=true:result 含 {code, signal, durationMs}
      // - code === 0 && !signal → 成功
      // - 其他 (非 0 退出码 / 被信号终止) → 失败,提示 code 让用户知道为什么失败
      const { code, signal } = result
      if (code === 0 && !signal) {
        message.success(`已执行: ${command}`)
      } else {
        const reason = signal ? `signal ${signal}` : `exit ${code ?? '?'}`
        message.error(`执行失败 (${reason}): ${command}`)
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
        <Segmented<'bash' | 'prompt' | 'git'>
          block
          value={effectiveTab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { label: '快捷 Bash', value: 'bash' },
            { label: '常用指令', value: 'prompt' },
            ...(isGit ? [{ label: 'Git', value: 'git' }] : []),
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
            <div style={{ color: 'var(--text-dim-45)', padding: 16 }}>
              请先开启会话
            </div>
          )}
          {effectiveSid && topCommands.length === 0 && (
            <div style={{ color: 'var(--text-dim-45)', padding: 16 }}>
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
                borderBottom: '1px solid var(--border-faint)',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 13,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.command}
              </span>
              <span style={{ color: 'var(--text-dim-45)', fontSize: 11, flexShrink: 0 }}>
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
            <div style={{ color: 'var(--text-dim-45)', padding: 16 }}>
              无会话
            </div>
          )}
          {effectiveSid && prompts.length === 0 && (
            <div style={{ color: 'var(--text-dim-45)', padding: 16 }}>
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
                borderBottom: '1px solid var(--border-faint)',
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

      {effectiveTab === 'git' && (
        <GitTab cwd={cwd} />
      )}
    </Drawer>
  )
}
