import { useEffect, useMemo, useState } from 'react'
import { Collapse } from 'antd'
import { useAgentStore } from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import AgentConversation from './AgentConversation'
import MobileHeader from '../components/MobileHeader'
import MobileSessionDrawer from '../components/MobileSessionDrawer'
import { SessionCwdBridge } from '../components/SessionCwdBridge'
import { TaskDrawer } from '../components/TaskDrawer'
import ApproveDrawer from '../components/ApproveDrawer.jsx'
import SettingsDrawer from '../components/SettingsDrawer'
import { FilePreviewDrawer } from '../components/conversation/FilePreviewDrawer'
import ConfigStatusBar from '../components/ConfigStatusBar'
import MobileQuickDrawer from '../components/MobileQuickDrawer.jsx'
import { UpdateNotifier } from '../components/UpdateNotifier'
import { SubagentDetailBody } from '../components/splitPane/SubagentDetailBody'

function SubagentList({ sessionId }: { sessionId: string }) {
  const tasks = useAgentStore((s) => s.subagentTasksBySession[sessionId] ?? [])
  const currentKernel = useAgentStore((s) => s.currentKernel)
  if (tasks.length === 0) {
    if (currentKernel !== 'dsh') {
      return (
        <div className="px-4 py-3 text-xs text-gray-500" aria-label="DSH 模式专享提示">
          当前 kernel = <code>{currentKernel}</code> 不支持 subagent。
          请切换到 <strong>dsh</strong> 模式(
          <a href="/config" className="underline">配置页</a>)。
        </div>
      )
    }
    return null
  }
  return (
    <Collapse>
      <Collapse.Panel
        header={`Subagents (${tasks.length})`}
        key="subagents"
      >
        {tasks.map((task) => (
          <div key={task.taskId} className="py-2 border-b">
            <div className="font-medium">{task.taskId.slice(0, 16)}...</div>
            <div className="text-xs text-gray-500">
              {task.state === 'running' && '运行中'}
              {task.state === 'waiting' && '等待'}
              {task.state === 'settled' && '已结束'}
              {' · '}
              {task.status}
            </div>
            <SubagentDetailBody taskId={task.taskId} />
          </div>
        ))}
      </Collapse.Panel>
    </Collapse>
  )
}

/**
 * 移动端 /agent 页面:
 *   - MobileHeader 顶栏(≡ / 标题 / +)
 *   - AgentConversation 对话核心(内部从 useAppStore.isMobile 判断移动端)
 *   - ConfigStatusBar 底部状态栏(含模型切换按钮)
 *   - MobileSessionDrawer 左侧抽屉式会话切换
 *   - 不挂 SplitPane / 不挂 Sider 导航栏
 *   - 保留:SessionCwdBridge(更新 cwdName)/ TaskDrawer / ApproveDrawer / SettingsDrawer
 *
 * isMobile 由 MobileLayout 顶部 useIsMobile() 通过 matchMedia 同步到
 * useAppStore, 任何子组件按需自取, 不再 props 透传.
 */
export default function MobileAgent() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const quickDrawerOpen = useAppStore((s) => s.quickDrawerOpen)
  const sessionId = useAgentStore((s) => s.sessionId)
  const setQuickDrawerOpen = useAppStore((s) => s.setQuickDrawerOpen)
  const { instanceContext } = useAppStore()
  const cwdBySessionForSid = useAgentStore((s) =>
    s.sessionId ? s.cwdBySession[s.sessionId] : undefined,
  )
  const cwdName = instanceContext?.cwdName || '~'
  // branch=null 表示当前 PWD 不是 Git 目录 (server /system 端点在
  // git rev-parse --is-inside-work-tree 失败时返回 null). ConfigStatusBar
  // 据此隐藏整个分支段 + 前后分隔符, 不显示误导性的 'master' 兜底, 也
  // 不会触发 listBranches 失败弹错. 与 Agent.tsx 同步.
  const branch = instanceContext?.branch ?? null

  // 与 Agent.tsx:47-50 对齐: instanceContext.cwd 是 server 注入的绝对路径,
  // 冷启动立即可用; cwdBySessionForSid 仅在用户跑过 bash 后才填充.
  // 不传 cwd 给 ConfigStatusBar 会导致 BranchSelector 退化为只读 span
  // (原 MobileAgent 漏传 bug — 分支名在移动端点击无反应).
  const cwd = useMemo(() => {
    if (instanceContext?.cwd) return instanceContext.cwd
    return cwdBySessionForSid ?? null
  }, [instanceContext?.cwd, cwdBySessionForSid])

  // 首次挂载:拉 sessions;为空则自动建一条空会话(与 Agent.tsx 行为对齐)
  useEffect(() => {
    ;(async () => {
      await loadSessions()
      if (useAgentStore.getState().sessions.length === 0) {
        await useAgentStore.getState().createNewSession()
      }
    })()
  }, [])

  return (
    <>
      {/* zai 自升级弹窗。useAppStore 是单例,Layout 已挂一份;
          这里再挂一份确保移动端路由(不共享 Layout)也能响应。
          UpdateNotifier 内部用 module 级 Set 抑制双挂载重复弹窗。 */}
      <UpdateNotifier />
      <MobileHeader onOpenSessionDrawer={() => setDrawerOpen(true)} />
      <AgentConversation />
      {sessionId && <SubagentList sessionId={sessionId} />}
      <ConfigStatusBar
        cwdName={cwdName}
        sessionCwd={cwdBySessionForSid}
        branch={branch}
        cwd={cwd}
        onTaskSelect={setSelectedTaskId}
      />
      <MobileSessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <ApproveDrawer />
      <SettingsDrawer />
      <FilePreviewDrawer />
      <SessionCwdBridge />
      <MobileQuickDrawer
        open={quickDrawerOpen}
        onClose={() => setQuickDrawerOpen(false)}
      />
    </>
  )
}
