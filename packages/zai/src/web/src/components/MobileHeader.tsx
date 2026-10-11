import { Button } from 'antd'
import IconButton from "./IconButton.js";
import { BotIcon, MenuIcon, PlusIcon } from 'lucide-react';
import { useAgentStore } from '../store/useAgentStore'
import { useProjection } from '../store/useProjection'
import { useIsLanAgentHost } from '../hooks/useIsLanAgentHost'
import ModelStatusButton from './ModelStatusButton'

export interface MobileHeaderProps {
  /** 点左上角 [≡] 按钮触发(父组件打开会话列表 Drawer) */
  onOpenSessionDrawer: () => void
}

/**
 * 移动端 44px 顶栏:
 *   左: [≡] 抽屉触发按钮 + 当前会话标题(取 sessions.find(s => s.sessionId === sessionId).title)
 *   右: [+] 新建会话按钮
 * 不渲染设置/分享按钮 — 这两个由 AgentInputBox 内部工具栏提供。
 *
 * lan-agent App 内(Android WebView 宿主)顶栏多两个按钮:
 *   - [Bot] 回到原生 APP 对话 —— 切回 lan-agent 底栏「任务」栏。页面内无从
 *     切原生 tab,走 lib/lanAgentBridge 转给原生。只有原生真的注入了桥
 *     (window.AndroidWebview)时才渲染,否则不给一个点了没反应的按钮。
 *   - [模型名] 模型切换 —— 该宿主下 MobileAgent 不渲染底部 ConfigStatusBar,
 *     模型切换入口不能跟着一起消失, 否则用户在 App 里没有任何换模型的地方。
 *     复用 ConfigStatusBar 里同一个 ModelStatusButton(弹层 / 面板 /
 *     patchSessionModel 全一致), 只是换了宿主位置;Popover placement 由
 *     组件内部读 isMobile 自动取 'bottom'。
 */
export default function MobileHeader({ onOpenSessionDrawer }: MobileHeaderProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const sessions = useAgentStore((s) => s.sessions)
  const createNewSession = useAgentStore((s) => s.createNewSession)
  // 对话进行中(streaming)禁用新建 — 与抽屉/桌面端侧栏一致, 防止切走当前流。
  const status = useAgentStore((s) => s.status)
  const isBusy = status === "streaming"
  const current = sessions.find((s) => s.sessionId === sessionId)
  const isLanAgentHost = useIsLanAgentHost()
  // 「回到原生对话」只在 lan-agent 真的把桥注进来时才有意义。非 App 环境
  // (手机浏览器直接开 /m)或 App 版本早于该桥时 window.AndroidWebview 为
  // undefined,lanAgentGoToAgent() 返回 false —— 此时不渲染,而不是给一个
  // 点了没反应的按钮。
  const canGoToNativeAgent =
    isLanAgentHost &&
    typeof window !== 'undefined' &&
    typeof window.lanAgentGoToAgent === 'function' &&
    typeof window.AndroidWebview?.goToAgent === 'function'
  // dsh 投影试点 (2026-08-15): 标题优先走 host 推送的 session/projection 帧
  // (重连后 host 重算整体重发), fallback 到 sessions 列表的 title。
  const projectedTitle = useProjection<string>(sessionId, 'title')
  const title = projectedTitle ?? current?.title ?? '新会话'

  return (
    <div
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-card)',
        flexShrink: 0,
      }}
    >
      <IconButton
        icon={<MenuIcon />}
        onClick={onOpenSessionDrawer}
        data-testid="mobile-header-drawer-toggle"
        aria-label="打开会话列表"
        style={{ width: 36, height: 36, padding: 0 }}
      />
      <div
        style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          padding: '0 8px',
        }}
        data-testid="mobile-header-title"
      >
        {title}
      </div>
      {/* 「回到原生 APP 对话」: lan-agent 的原生 Agent 对话在底栏「任务」栏,
          页内无从切 tab,只能通过 lib/lanAgentBridge 转给原生。图标用 Bot
          —— 与 lan-agent 底栏「任务」栏同款(Lucide.Bot),点了去哪一眼可辨。 */}
      {canGoToNativeAgent && (
        <IconButton
          icon={<BotIcon />}
          onClick={() => void window.lanAgentGoToAgent?.()}
          title="回到 APP 内的 Agent 对话"
          aria-label="回到原生 APP 对话"
          data-testid="mobile-header-go-native"
          style={{ width: 36, height: 36, padding: 0 }}
        />
      )}
      {/* lan-agent 宿主专属: 模型切换入口从被隐藏的底部状态栏搬到这里。
          max-w 防止长模型名(如 MiniMax-M3.1-Flash-Preview)把居中标题挤没;
          truncate 走 ModelStatusButton 的 className 入口, 命中断言按钮内层
          span 而不是靠外层 overflow 硬裁。顶栏左侧已有「回到原生」按钮时
          再收窄一档,给标题让出空间。 */}
      {isLanAgentHost && (
        <span
          className={`min-w-0 flex items-center text-[var(--accent-start)] ${canGoToNativeAgent ? 'max-w-[28vw]' : 'max-w-[38vw]'}`}
          data-testid="mobile-header-model"
        >
          <ModelStatusButton compact className="max-w-full [&>span]:truncate" />
        </span>
      )}
      <IconButton
        icon={<PlusIcon />}
        onClick={() => void createNewSession()}
        disabled={isBusy}
        title={isBusy ? "对话进行中,请等待当前回复结束" : undefined}
        data-testid="mobile-header-new-session"
        aria-label="新建会话"
        style={{ width: 36, height: 36, padding: 0 }}
      />
    </div>
  )
}