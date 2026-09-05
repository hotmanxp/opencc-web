import { useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Empty, Segmented, Spin, Typography, theme as antdTheme } from 'antd'
import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import MobileSupervisorDrawer from '../components/superTasks/MobileSupervisorDrawer'
import MobileSuperTaskCard from '../components/superTasks/MobileSuperTaskCard'
import NewSuperTaskModal from '../components/superTasks/NewSuperTaskModal'
import QuickCreateModal from '../components/superTasks/QuickCreateModal'
import SuperTaskDetailDrawer from '../components/superTasks/SuperTaskDetailDrawer'
import { LANE_TITLE, type BucketKey } from '../components/superTasks/SuperTaskPanel'
import { useAgentStore } from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'
import { createAgentSession, pickLastSelectedModel } from '../lib/agentSessionApi'
import { setSupervisorSession } from '../lib/superTaskApi'
import { LIGHT_PAGE_VARS } from '../components/superTasks/lightThemeVars'

const BUCKET_ORDER: BucketKey[] = ['queue', 'processing', 'verifying', 'finished']

/**
 * 移动端任务工厂页(2026-09-04 新增,/m-super-tasks 路由)。
 *
 * 核心闭环:看任务状态 → 创建任务 → 与任务调度官对话 → 查任务详情。
 *
 * 路由:`/m-super-tasks` 走 MobileLayout,与 `/m` 是两条独立顶层
 * 路径 —— **不修改** `/m` 的任务工厂分流(任务工厂实例下 `/m` 仍
 * 渲染 MobileAgent),移动端靠 lan-agent 卡片 / 直接 URL 进入。
 *
 * 与桌面 `/super-tasks` 的差异:
 *  - 无左侧调度官对话边栏 / 280px → 右下 FAB + 底部 Drawer(90%)
 *  - 无 TaskOverviewBar 5 张统计卡 / 筛选 → 顶栏 Segmented 4 项 + 计数
 *  - 无批量多选 / 暂停继续删除按钮 / AI 托管 Switch / 工厂设置
 *  - 详情抽屉走底部 Drawer ≥ 90% 全屏呈现(SuperTaskDetailDrawer 现有
 *    props 已可达成,无需给它加新 prop)。
 *
 * 调度官会话引导 + 3s 轮询:从桌面 SuperTasks.tsx L54-97 逐行平移
 * (`booted` ref / `loadSessions` + `superTaskStore.load` 并行 /
 * server sid 命中或新建 mainAgent='task-factory')。
 *
 * 数据源 `useSuperTaskStore.buckets`,本页驱动 3s 轮询(`load()`),
 * unmount 时清理定时器(避免与桌面页双轮询)。
 *
 * 默认 tab = processing;若首次数据到达时 `processing` 空且 `queue`
 * 非空 → 自动切到 `queue`(用 `defaultTabPicked` ref 保证只切一次,
 * 之后完全尊重用户选择)。
 */
export default function MobileSuperTasks(): JSX.Element {
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const loadTranscript = useAgentStore((s) => s.loadTranscript)
  const load = useSuperTaskStore((s) => s.load)
  const buckets = useSuperTaskStore((s) => s.buckets)
  const loading = useSuperTaskStore((s) => s.loading)
  const loadedOnce = useSuperTaskStore((s) => s.loadedOnce)
  const cwdName = useAppStore((s) => s.instanceContext?.cwdName ?? null)

  const booted = useRef(false)
  const defaultTabPicked = useRef(false)
  const [tab, setTab] = useState<BucketKey>('processing')
  const [newOpen, setNewOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [supOpen, setSupOpen] = useState(false)

  // 3s 轮询 — 仅本页 mount 期间生效
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(id)
  }, [load])

  // 调度官会话引导 — mount 跑一次。真相源 = 后端 state.json 的
  // supervisorSessionId(随 superTaskStore.load 带回)。
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      await Promise.all([loadSessions(), useSuperTaskStore.getState().load()])
      const s = useAgentStore.getState()
      const latest = s.sessions
      const serverSid = useSuperTaskStore.getState().supervisorSessionId
      if (serverSid && latest.some((x) => x.sessionId === serverSid)) {
        s.setCurrentSession(serverSid)
        await loadTranscript(serverSid)
        return
      }
      try {
        const sid = await createAgentSession({
          mainAgent: 'task-factory',
          ...pickLastSelectedModel(latest),
        })
        await setSupervisorSession(sid)
        await loadSessions()
        useAgentStore.getState().setCurrentSession(sid)
        await loadTranscript(sid)
      } catch {
        // 创建失败静默,store 内部有兜底
      }
    })()
  }, [loadSessions, loadTranscript])

  // 首载占位:loading + 全空 + !loadedOnce → 列表区显示 Spin。
  // 顶栏 / Segmented / Modal / Drawer **不**受该条件控制(避免轮询
  // 触发的卸载重挂把 intake 对话重置 —— 与 SuperTaskPanel L194-200
  // 同款踩坑)。
  const isEmpty =
    buckets.queue.length === 0
    && buckets.processing.length === 0
    && buckets.verifying.length === 0
    && buckets.finished.length === 0
  const showLanes = !(loading && isEmpty && !loadedOnce)

  // 首次数据到达:processing 空 + queue 非空 → 自动切到 queue。仅切一次。
  useEffect(() => {
    if (defaultTabPicked.current) return
    if (!loadedOnce) return
    if (buckets.processing.length === 0 && buckets.queue.length > 0) {
      setTab('queue')
    }
    defaultTabPicked.current = true
  }, [loadedOnce, buckets.processing.length, buckets.queue.length])

  const rows = buckets[tab]

  return (
    <div
      style={{
        ...LIGHT_PAGE_VARS,
        background: '#eef2f7',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ConfigProvider
        theme={{
          algorithm: antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: '#f97316',
            colorBgContainer: '#ffffff',
            colorBgElevated: '#ffffff',
            colorBgLayout: '#eef2f7',
            colorText: '#1f2937',
            colorTextSecondary: '#6b7280',
            colorBorder: '#e5e9f0',
            borderRadius: 8,
          },
        }}
      >
        {/* 顶栏 */}
        <div
          style={{
            flexShrink: 0,
            padding: '8px 12px',
            background: '#ffffff',
            borderBottom: '1px solid #e5e9f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 16, color: '#0f172a' }}>任务工厂</div>
            {cwdName && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {cwdName}
              </Typography.Text>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setNewOpen(true)}
              data-testid="mobile-new-task-button"
            >
              新建
            </Button>
            {/* 快速创建(2026-09-04 quick-intake):与「+ 新建」并列,复用桌面
                QuickCreateModal 并显式传 fullscreen + mobileAsDrawer(tf-cy9x9kjh,
                抽屉式)。复用的同款 modal 在桌面 SuperTaskPanel 不传任何 prop →
                仍 640px 居中 Modal,零回归。 */}
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => setQuickOpen(true)}
              data-testid="mobile-quick-create-button"
            >
              快速创建
            </Button>
          </div>
        </div>

        {/* Segmented */}
        <div
          style={{
            flexShrink: 0,
            padding: '8px 12px 0',
          }}
        >
          <Segmented
            block
            value={tab}
            onChange={(v) => setTab(v as BucketKey)}
            data-testid="mobile-bucket-segmented"
            options={BUCKET_ORDER.map((k) => ({
              label: `${LANE_TITLE[k]} ${buckets[k].length}`,
              value: k,
            }))}
          />
        </div>

        {/* 列表区 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '10px 12px',
            paddingBottom: 88,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {showLanes ? (
            rows.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '40px 0',
                }}
              >
                <Empty description="暂无任务" />
              </div>
            ) : (
              rows.map((t) => (
                <MobileSuperTaskCard
                  key={t.id}
                  task={t}
                  onOpen={setDetailId}
                />
              ))
            )
          ) : (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Spin />
            </div>
          )}
        </div>

        <MobileSupervisorDrawer
          open={supOpen}
          onOpen={() => setSupOpen(true)}
          onClose={() => setSupOpen(false)}
        />
        <NewSuperTaskModal
          open={newOpen}
          onClose={() => setNewOpen(false)}
          fullscreen
          mobileAsDrawer
        />
        <QuickCreateModal
          open={quickOpen}
          onClose={() => setQuickOpen(false)}
          fullscreen
          mobileAsDrawer
        />
        <SuperTaskDetailDrawer
          taskId={detailId}
          onClose={() => setDetailId(null)}
        />
      </ConfigProvider>
    </div>
  )
}