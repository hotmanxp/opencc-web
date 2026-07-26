import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import AgentConversation from './AgentConversation'
import MobileHeader from '../components/MobileHeader'
import MobileSessionDrawer from '../components/MobileSessionDrawer'
import { SessionCwdBridge } from '../components/SessionCwdBridge'
import { TaskDrawer } from '../components/TaskDrawer'
import ApproveDrawer from '../components/ApproveDrawer.jsx'
import SettingsDrawer from '../components/SettingsDrawer'
import ConfigStatusBar from '../components/ConfigStatusBar'

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
  const { instanceContext } = useAppStore()
  const cwdBySessionForSid = useAgentStore((s) =>
    s.sessionId ? s.cwdBySession[s.sessionId] : undefined,
  )
  const cwdName = instanceContext?.cwdName || '~'
  const branch = instanceContext?.branch || 'master'

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
      <MobileHeader onOpenSessionDrawer={() => setDrawerOpen(true)} />
      <AgentConversation />
      <ConfigStatusBar
        cwdName={cwdName}
        sessionCwd={cwdBySessionForSid}
        branch={branch}
        onTaskSelect={setSelectedTaskId}
      />
      <MobileSessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <ApproveDrawer />
      <SettingsDrawer />
      <SessionCwdBridge />
    </>
  )
}