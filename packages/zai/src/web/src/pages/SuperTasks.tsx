import { useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Tooltip, Typography, theme as antdTheme } from 'antd'
import { CommentOutlined, DoubleLeftOutlined } from '@ant-design/icons'
import AgentConversation from './AgentConversation'
import SuperTaskPanel from '../components/superTasks/SuperTaskPanel'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'

const SUPERVISOR_SESSION_KEY = 'zai-supervisor-session'

/**
 * 任务工厂页亮色化(2026-09-01 用户反馈):整页只在本页面范围内覆写 CSS 变量为
 * 亮色值,让主管对话区/看板/卡片全部按浅色渲染;再嵌套 antd ConfigProvider
 * defaultAlgorithm,让本页内的 Drawer/Modal/Popconfirm 等 portal 组件用亮色
 * token。不影响全局主题(其它页面照旧)。
 */
const LIGHT_PAGE_VARS = {
  '--bg-body': '#eef2f7',
  '--bg-page': '#eef2f7',
  '--bg-card': '#ffffff',
  '--bg-card-hover': '#f7f9fc',
  '--text-primary': '#1f2937',
  '--text-secondary': '#6b7280',
  '--border-subtle': '#e5e9f0',
} as React.CSSProperties

/**
 * SuperTasks 页面（任务工厂 · 主管）。
 *
 * 路由 `/super-tasks` 由 `router.tsx` 顶层挂出,
 * `TaskFactoryAgentEntry` 与 `TaskFactoryRedirect` 会按
 * `instanceContext.app === 'task-factory'` 把标准入口
 * (`/` `/agent` `*`) 重定向到本页。
 *
 * 布局(看板重设计):
 *  - 左:主管对话边栏 280px,可折叠为 40px 图标条(点图标恢复)。
 *  - 右:flex:1 SuperTaskPanel(顶部总览统计卡组 + 三栏看板)。
 *
 * 主管会话引导(Task 8 修复):
 *  - mount 时调 loadSessions, 等 sessions 刷新到 store 后
 *  - 若 localStorage `zai-supervisor-session` 命中 sessions 中存在的 id
 *    → setCurrentSession(saved),保持主管身份稳定不漂移
 *  - 否则 (无论 sessions 是否为空) 都调 createNewSession() 拿到新 sid,
 *    写入 localStorage + setCurrentSession(sid)。
 *    关键:不能因为 sessions 非空就把主管会话"漂移"到 sessions[0] —
 *    那会让每次刷新都随机落到不同会话。store 内部 loadSessions 自动
 *    set({sessionId: sessions[0]}) 的兜底在引导流程跑完后会被覆盖。
 *
 * 数据加载 + 3s 轮询由本页统一驱动(避免双轮询)。
 */
export default function SuperTasks(): JSX.Element {
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const load = useSuperTaskStore((s) => s.load)
  const booted = useRef(false)
  const [collapsed, setCollapsed] = useState(false)

  // 右栏 SuperTaskPanel 数据加载 + 3s 轮询
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(id)
  }, [load])

  // 主管会话引导 — 仅在 mount 跑一次。
  // 用闭包里的 sessions 会有 stale 风险, 所以在 loadSessions() 返回后
  // 从 store 里重新读最新的 sessions。
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      await loadSessions()
      const s = useAgentStore.getState()
      const latest = s.sessions
      const saved = (() => {
        try { return localStorage.getItem(SUPERVISOR_SESSION_KEY) } catch { return null }
      })()
      const exists = saved ? latest.some((x) => x.sessionId === saved) : false
      if (exists && saved) {
        // 本地有持久化的主管会话,且仍在 sessions 列表里 → 锁定到它
        s.setCurrentSession(saved)
        return
      }
      // 命中失败(没有 saved / saved 已失效):统一创建新会话并接管主管身份。
      // 注意:不论 sessions 列表是否非空,这里都强制创建 — 避免主管身份被
      // store 兜底自动漂移到 sessions[0] 上,导致每次刷新主管会话都换。
      try {
        await s.createNewSession()
        const after = useAgentStore.getState().sessionId
        if (after) {
          try { localStorage.setItem(SUPERVISOR_SESSION_KEY, after) } catch { /* quota / disabled */ }
          s.setCurrentSession(after)
        }
      } catch {
        // 创建失败静默, store 内部有兜底
      }
    })()
  }, [loadSessions])

  return (
    <div
      style={{
        ...LIGHT_PAGE_VARS,
        background: '#eef2f7',
        display: 'flex',
        height: '100vh',
        width: '100%',
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
      {collapsed ? (
        <div
          style={{
            width: 40,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 10,
            borderRight: '1px solid #e5e9f0',
            background: '#ffffff',
          }}
        >
          <Tooltip title="展开主管对话" placement="right">
            <Button type="text" icon={<CommentOutlined />} onClick={() => setCollapsed(false)} />
          </Tooltip>
          <span
            style={{
              writingMode: 'vertical-lr',
              fontSize: 12,
              color: 'var(--text-secondary, #666)',
              marginTop: 14,
              letterSpacing: 4,
            }}
          >
            主管
          </span>
        </div>
      ) : (
        <div
          style={{
            width: 280,
            minWidth: 280,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #e5e9f0',
            background: '#ffffff',
          }}
        >
          <div
            style={{
              padding: '10px 12px 10px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              任务工厂 · 主管
            </Typography.Title>
            <Tooltip title="折叠主管对话">
              <Button type="text" size="small" icon={<DoubleLeftOutlined />} onClick={() => setCollapsed(true)} />
            </Tooltip>
          </div>
          {/* flex:1 + display:flex + flexDirection:'column' 三件套,AgentConversation
              内 flex:1 子元素才能正确撑开高度 (与 pages/Agent.tsx:488-497 同款布局)。 */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <AgentConversation />
          </div>
        </div>
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'auto',
          padding: 16,
          background: 'var(--bg-page, #f5f5f5)',
        }}
      >
        <SuperTaskPanel />
      </div>
      </ConfigProvider>
    </div>
  )
}