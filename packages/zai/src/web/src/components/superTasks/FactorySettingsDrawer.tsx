import { useEffect, useState } from 'react'
import {
  Alert, Button, Drawer, Input, InputNumber, Select, Space, Spin, Tag, Typography, message,
} from 'antd'
import { CheckCircleFilled, CloseCircleFilled, ReloadOutlined } from '@ant-design/icons'
import {
  fetchFactorySettings,
  fetchSpawnAgents,
  putFactorySettings,
  registerSpawnAgent,
  type FactorySettingsDto,
  type SpawnAgentStatus,
} from '../../lib/superTaskApi'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

/**
 * FactorySettingsDrawer — 任务工厂独立设置抽屉(tf-pnsl5m5e)。
 *
 * 右侧滑出,编辑 `~/.zai/factory-settings.json`(GET/PUT /api/super-tasks/
 * settings)+ 管理 spawnAgent provider(GET /api/super-tasks/spawn-agents、
 * POST .../:name/register)。沿用任务工厂页亮色主题:页面级 ConfigProvider
 * 经 React context 作用于 portal(见 SuperTasks.tsx 注释),但 portal 拿不到
 * 页面 div 上的 CSS 变量,内容容器再注入一份 LIGHT_PAGE_VARS(与
 * NewSuperTaskModal 同款处理)。
 *
 * 混合模式的前端面:目录/偏好是软引导,保存即生效(新会话/新提示词构建
 * 起效);maxParallelTasks 由托管循环服务端强约束。注册 dsh / opencode
 * provider 在 zai 重启后才 active —— 端点响应 restartRequired,UI 如实提示。
 */

interface Draft {
  docsDir: string
  repoRoot: string
  maxParallelTasks: number | null
  preferSpawnAgent: 'opencc' | 'dsh' | 'opencode' | null
  historyArchiveHours: number | null
}

const EMPTY_DRAFT: Draft = {
  docsDir: '',
  repoRoot: '',
  maxParallelTasks: 4,
  preferSpawnAgent: null,
  historyArchiveHours: 48,
}

function draftFromSettings(s: FactorySettingsDto): Draft {
  return {
    docsDir: s.docsDir,
    repoRoot: s.repoRoot,
    maxParallelTasks: s.maxParallelTasks,
    preferSpawnAgent: s.preferSpawnAgent,
    historyArchiveHours: s.historyArchiveHours,
  }
}

/**
 * 目录存在性徽标 —— 存在性来自服务端对「已保存路径」的 stat(PUT/GET 响应)。
 * 输入框草稿与已保存值不一致时显示「待保存」,避免旧徽标误导新路径的存在性。
 */
function DirBadge({
  path,
  exists,
  dirty,
}: {
  path: string
  exists: boolean
  dirty: boolean
}): JSX.Element {
  if (!path) return <Tag>未设置</Tag>
  if (dirty) return <Tag color="warning">待保存校验</Tag>
  return exists
    ? <Tag color="success" icon={<CheckCircleFilled />}>存在</Tag>
    : <Tag color="error" icon={<CloseCircleFilled />}>目录不存在</Tag>
}

export default function FactorySettingsDrawer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<FactorySettingsDto | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [agents, setAgents] = useState<SpawnAgentStatus[]>([])
  const [registering, setRegistering] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const [s, a] = await Promise.all([fetchFactorySettings(), fetchSpawnAgents()])
      setSettings(s)
      setDraft(draftFromSettings(s))
      setAgents(a)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载工厂设置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const dto = await putFactorySettings({
        docsDir: draft.docsDir,
        repoRoot: draft.repoRoot,
        // InputNumber 清空 → 不提交该字段(保留服务端原值)
        ...(draft.maxParallelTasks !== null
          ? { maxParallelTasks: draft.maxParallelTasks }
          : {}),
        ...(draft.historyArchiveHours !== null
          ? { historyArchiveHours: draft.historyArchiveHours }
          : {}),
        preferSpawnAgent: draft.preferSpawnAgent,
      })
      setSettings(dto)
      message.success('工厂设置已保存')
    } catch (err) {
      // 服务端 zod 400:api 层已把 detail/issues 拼进 message
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleRegister(name: string): Promise<void> {
    setRegistering(name)
    try {
      await registerSpawnAgent(name)
      message.success(`${name} 注册成功,重启 zai 服务后生效`)
      setAgents(await fetchSpawnAgents())
    } catch (err) {
      message.error(err instanceof Error ? `注册 ${name} 失败: ${err.message}` : '注册失败')
    } finally {
      setRegistering(null)
    }
  }

  const anyActive = agents.some((a) => a.active)
  const hasSaved = settings !== null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={480}
      title="工厂设置"
      destroyOnHidden
      styles={{ body: { padding: 0 } }}
    >
      <div
        data-testid="factory-settings-drawer"
        style={{
          ...LIGHT_PAGE_VARS,
          background: '#ffffff',
          color: 'var(--text-primary, #1f2937)',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {loadError && (
            <Alert
              type="error"
              showIcon
              message={loadError}
              style={{ marginBottom: 12 }}
              action={<Button size="small" onClick={() => void load()}>重试</Button>}
            />
          )}
          <Spin spinning={loading}>
            <Space direction="vertical" size={20} style={{ width: '100%' }}>
              {/* ── 目录配置(软引导) ─────────────────────────────── */}
              <div>
                <Typography.Text strong>需求文档目录(docsDir)</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 6px' }}>
                  需求讨论(task-intake)会话以此为工作目录;留空 = 维持现状。
                </div>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    data-testid="factory-settings-docs-dir"
                    value={draft.docsDir}
                    onChange={(e) => setDraft((p) => ({ ...p, docsDir: e.target.value }))}
                    placeholder="如 /Users/you/team/docs(绝对路径)"
                  />
                  {hasSaved && (
                    <DirBadge
                      path={draft.docsDir}
                      exists={settings!.docsDirExists}
                      dirty={draft.docsDir !== settings!.docsDir}
                    />
                  )}
                </Space.Compact>
              </div>

              <div>
                <Typography.Text strong>代码库目录(repoRoot)</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 6px' }}>
                  软引导任务 cwd 落在此目录下(不校验不拦截)。
                </div>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    data-testid="factory-settings-repo-root"
                    value={draft.repoRoot}
                    onChange={(e) => setDraft((p) => ({ ...p, repoRoot: e.target.value }))}
                    placeholder="如 /Users/you/repos(绝对路径)"
                  />
                  {hasSaved && (
                    <DirBadge
                      path={draft.repoRoot}
                      exists={settings!.repoRootExists}
                      dirty={draft.repoRoot !== settings!.repoRoot}
                    />
                  )}
                </Space.Compact>
              </div>

              {/* ── 并行上限(服务端强约束) ────────────────────────── */}
              <div>
                <Typography.Text strong>最大并行任务</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 6px' }}>
                  托管循环在 processing 达到该数时暂停派发(整数 2–8,accept 不受限)。
                </div>
                <InputNumber
                  data-testid="factory-settings-max-parallel"
                  min={2}
                  max={8}
                  precision={0}
                  value={draft.maxParallelTasks}
                  onChange={(v) => setDraft((p) => ({ ...p, maxParallelTasks: v }))}
                  style={{ width: 120 }}
                />
              </div>

              {/* ── 历史归档阈值 ─────────────────────────────────── */}
              <div>
                <Typography.Text strong>历史归档阈值(小时)</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 6px' }}>
                  已完成/失败任务超过该时长后,任务列表轮询时自动移入 history-tasks 收纳(整数 1–8760,默认 48)。
                </div>
                <InputNumber
                  data-testid="factory-settings-history-archive-hours"
                  min={1}
                  max={8760}
                  precision={0}
                  value={draft.historyArchiveHours}
                  onChange={(v) => setDraft((p) => ({ ...p, historyArchiveHours: v }))}
                  style={{ width: 120 }}
                />
              </div>

              {/* ── 优先 spawnAgent ───────────────────────────────── */}
              <div>
                <Typography.Text strong>优先 spawnAgent</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 6px' }}>
                  任务调度官委派执行(SpawnAgent / SuperTasksCreate 的 agent 字段)时优先使用。仅「活跃」的 provider 可选。
                </div>
                {agents.length > 0 && !anyActive && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message="当前没有可用的 spawnAgent provider"
                    description="请在下方「spawnAgent 管理」注册 opencc / dsh / opencode,重启 zai 服务后即出现在此列表。"
                  />
                )}
                <Select
                  data-testid="factory-settings-prefer-agent"
                  allowClear
                  placeholder="未指定"
                  style={{ width: 240 }}
                  value={draft.preferSpawnAgent ?? undefined}
                  onChange={(v) => setDraft((p) => ({ ...p, preferSpawnAgent: (v ?? null) as Draft['preferSpawnAgent'] }))}
                  options={agents.map((a) => ({
                    value: a.name,
                    disabled: !a.active,
                    label: `${a.name}${a.active ? '' : '(未激活)'}`,
                  }))}
                />
              </div>

              {/* ── spawnAgent 管理 ───────────────────────────────── */}
              <div>
                <Typography.Text strong>spawnAgent 管理</Typography.Text>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)', margin: '2px 0 10px' }}>
                  写入 ~/.zai/settings.json 的 subagents.&lt;name&gt;(enabled: true,其余键不动);注册后需重启 zai 生效。
                </div>
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  {agents.map((a) => (
                    <div
                      key={a.name}
                      data-testid={`factory-settings-agent-${a.name}`}
                      style={{
                        border: '1px solid var(--border-subtle, #e5e9f0)',
                        borderRadius: 8,
                        padding: 12,
                        background: 'var(--bg-card, #ffffff)',
                      }}
                    >
                      <Space size={8} wrap>
                        <Typography.Text strong>{a.name}</Typography.Text>
                        <Tag color={a.active ? 'success' : 'default'}>{a.active ? '活跃' : '未激活'}</Tag>
                      </Space>
                      <div style={{ marginTop: 6, fontSize: 13 }}>
                        全局命令:{' '}
                        {a.commandFound
                          ? <Tag color="success" icon={<CheckCircleFilled />}>已安装</Tag>
                          : <Tag color="error" icon={<CloseCircleFilled />}>未找到</Tag>}
                        {a.commandPath && (
                          <Typography.Text code style={{ fontSize: 12 }}>{a.commandPath}</Typography.Text>
                        )}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 13 }}>
                        settings.json 注册:{' '}
                        {a.registered
                          ? <Tag color="success" icon={<CheckCircleFilled />}>已注册</Tag>
                          : <Tag color="default">未注册</Tag>}
                        {!a.registered && (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            loading={registering === a.name}
                            onClick={() => void handleRegister(a.name)}
                            data-testid={`factory-settings-register-${a.name}`}
                          >
                            一键注册
                          </Button>
                        )}
                        {a.registered && !a.active && (
                          <span style={{ color: 'var(--text-secondary, #6b7280)', fontSize: 12 }}>
                            {' '}已注册,重启 zai 服务后生效
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </Space>
              </div>
            </Space>
          </Spin>
        </div>

        {/* 底部操作条:保存(PUT)+ 重新加载(回读服务端) */}
        <div
          style={{
            borderTop: '1px solid var(--border-subtle, #e5e9f0)',
            padding: '10px 16px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            background: '#ffffff',
          }}
        >
          <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={loading}>
            重新加载
          </Button>
          <Button
            type="primary"
            data-testid="factory-settings-save"
            loading={saving}
            disabled={!hasSaved}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
