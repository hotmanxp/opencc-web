import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore'
import AgentConversation from './AgentConversation'
import MobileHeader from '../components/MobileHeader'
import MobileSessionDrawer from '../components/MobileSessionDrawer'
import { SessionCwdBridge } from '../components/SessionCwdBridge'
import { TaskDrawer } from '../components/TaskDrawer'
import { ApproveDrawer } from '../components/ApproveDrawer'
import { SettingsDrawer } from '../components/SettingsDrawer'

/**
 * 移动端 /agent 页面:
 *   - MobileHeader 顶栏(≡ / 标题 / +)
 *   - AgentConversation 对话核心(isMobile=true,屏蔽分屏相关 UI)
 *   - MobileSessionDrawer 左侧抽屉式会话切换
 *   - 不挂 SplitPane / 不挂 Sider 导航栏 / 不挂 TaskDock / 不挂 BottomStatusBar
 *   - 保留:SessionCwdBridge(更新 cwdName)/ TaskDrawer / ApproveDrawer / SettingsDrawer
 */
export default function MobileAgent() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

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
      <AgentConversation isMobile />
      <MobileSessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <ApproveDrawer />
      <SettingsDrawer />
      <SessionCwdBridge />
    </>
  )
}