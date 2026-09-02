import { useEffect, useRef, useState } from 'react'
import { Button, ConfigProvider, Tooltip, Typography, theme as antdTheme } from 'antd'
import { CommentOutlined, DoubleLeftOutlined } from '@ant-design/icons'
import AgentConversation from './AgentConversation'
import SuperTaskPanel from '../components/superTasks/SuperTaskPanel'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'
import { setSupervisorSession } from '../lib/superTaskApi'
import { createAgentSession, pickLastSelectedModel } from '../lib/agentSessionApi'
import { LIGHT_PAGE_VARS } from '../components/superTasks/lightThemeVars'

/**
 * 任务工厂页亮色化(2026-09-01 用户反馈;09-02 抽到 superTasks/lightThemeVars):
 * 整页在页面根 div 上覆写 CSS 变量为亮色值,让主管对话区/看板/卡片全部按浅色
 * 渲染;再嵌套 antd ConfigProvider defaultAlgorithm,让本页内的 Drawer/Modal/
 * Popconfirm 等 portal 组件用亮色 token。不影响全局主题(其它页面照旧)。
 * 注意:portal 组件(弹窗)不继承页面 div 上的 CSS 变量,弹窗内容容器需各自
 * 再注入 LIGHT_PAGE_VARS 一份(见 NewSuperTaskModal)。
 */

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
 * 主管会话引导(2026-09-02 改为「服务端为准」):
 *  - mount 时 loadSessions + superTaskStore.load(拿 server 端
 *    state.json 的 supervisorSessionId)
 *  - server sid 存在于 sessions 列表 → setCurrentSession(serverSid),
 *    主管 transcript 作为决策日志跨刷新/跨 tab 稳定延续
 *  - 否则(首次进入 / 会话被删)→ POST /api/agent/sessions
 *    {mainAgent:'task-factory'} 新建并冻结主管身份 →
 *    POST /api/super-tasks/supervisor 上报 → setCurrentSession(新sid)。
 *    托管循环/注入端点与用户可见会话由此始终指向同一个 session。
 *  - 不再使用 localStorage `zai-supervisor-session`(旧键残留无害,不再读写)。
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

  // 主管会话引导 — 仅在 mount 跑一次。真相源 = 后端 state.json 的
  // supervisorSessionId(经 superTaskStore.load 带回)。
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
        return
      }
      // server sid 缺失或会话已被删:新建一条并冻结 task-factory,上报后端 —
      // 不论 sessions 列表是否非空都强制创建,避免主管身份被 store 兜底漂移
      // 到 sessions[0](且新会话必须带 mainAgent=task-factory)。
      try {
        const sid = await createAgentSession({
          mainAgent: 'task-factory',
          ...pickLastSelectedModel(latest),
        })
        await setSupervisorSession(sid)
        await loadSessions()
        useAgentStore.getState().setCurrentSession(sid)
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