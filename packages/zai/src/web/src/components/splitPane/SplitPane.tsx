import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs } from 'antd';
import { LockOutlined, UnlockOutlined } from '@ant-design/icons';
import { GitTab } from './GitTab.js';
import { FsTab } from './FsTab.js';
import { BashTab } from './BashTab.js';
import { useAgentStore } from '../../store/useAgentStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  STORAGE_KEYS,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH_VW,
  RESPONSIVE_BREAKPOINT,
  clampWidth,
  useLocalStorageState,
  useIsGitRepo,
} from './shared.js';

/**
 * 首次打开分屏时的默认宽度: 60vw (DEFAULT_WIDTH_VW). storage 已有值
 * (用户拖拽过) 沿用 storage — 仅"首次"用 60vw.
 *
 * SSR 安全: typeof window 守卫避免在非浏览器环境 (测试 / SSR) 抛错.
 */
function resolveInitialWidth(): number {
  return DEFAULT_WIDTH_VW;
}

type TabKey = 'git' | 'fs' | 'bash';

export interface SplitPaneProps {
  cwd: string | null;
}

/**
 * Three-column container:
 *   [slot]            [messages (passed via children, not used here)]      [panel]
 *
 * We don't take children — Agent.tsx wraps its own messages column and
 * passes `cwd` here. The panel column is fully owned by SplitPane.
 */
export function SplitPane({ cwd }: SplitPaneProps) {
  // 默认值取自 useAppStore.defaultSplitScreen(由 Layout 在 mount 时从
  // settings.json hydrate).localStorage 已有显式值时,显式值胜出 — 用户
  // 手动 toggle 过的偏好不会被此设置覆盖.
  const defaultSplitScreen = useAppStore((s) => s.defaultSplitScreen);
  const [openStored, setOpenStored] = useLocalStorageState<boolean>(STORAGE_KEYS.open, defaultSplitScreen);
  const [tab, setTab] = useLocalStorageState<TabKey>(STORAGE_KEYS.tab, 'git');
  const [widthStored, setWidthStored] = useLocalStorageState<number>(
    STORAGE_KEYS.width,
    resolveInitialWidth(),
  );
  const width = clampWidth(widthStored);
  // 分屏宽度拖动锁 — 默认锁定 (true), 防止误触拖动分屏. 点悬浮按钮切到
  // false 才允许拖动调整宽度. 持久化到 localStorage (跟 width/tab 平级).
  const [lockedStored, setLockedStored] = useLocalStorageState<boolean>(
    STORAGE_KEYS.locked,
    true,
  );
  const activeSessionId = useAgentStore((s) => s.sessionId ?? null)
  // 非 git 项目 (instanceContext.branch === null) 过滤 Git tab (见 shared.ts
  // useIsGitRepo). 用户此前若把 tab 停在 git,fallback 到 fs 避免空面板.
  const isGit = useIsGitRepo();
  const tabItems = [
    { key: 'fs', label: 'Files', children: <FsTab cwd={cwd} /> },
    ...(isGit
      ? [{ key: 'git', label: 'Git', children: <GitTab cwd={cwd} /> }]
      : []),
    { key: 'bash', label: 'Bash', children: <BashTab sessionId={activeSessionId} cwd={cwd} /> },
  ];
  const activeTab: TabKey = tab === 'git' && !isGit ? 'fs' : tab;

  // 实时同步 defaultSplitScreen → localStorage:用户在 /agent 页面打开设置,
  // 切换"默认启动分屏"时,立即把新值写入 localStorage 让面板按新设置显示,
  // 无需刷新页面.一旦 localStorage 中已有值且该值和意图不一致时
  // (用户在 Settings 里改了设置但页面没刷新,R1 false 被种子写入后
  // API hydrate 把 store 改成 true),仍需同步.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEYS.open);
    if (stored === null) {
      setOpenStored(defaultSplitScreen);
      return;
    }
    const storedBool = stored === 'true';
    if (storedBool !== defaultSplitScreen) {
      setOpenStored(defaultSplitScreen);
    }
    // setOpenStored 内部已经写 localStorage + 派发 zai-localstorage-sync,
    // Agent.tsx 的同名 hook 会通过 storage/sync 事件同步刷新.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSplitScreen]);

  // Responsive: collapse when window is narrow regardless of stored state.
  const [responsiveClosed, setResponsiveClosed] = useState(
    typeof window !== 'undefined' && window.innerWidth < RESPONSIVE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => {
      setResponsiveClosed(window.innerWidth < RESPONSIVE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const open = openStored && !responsiveClosed;

  // Splitter drag state. width 存的是 vw (整数百分比), 但 mouse 移动给出 px,
  // 所以拖拽过程中实时把 px delta 折算成 vw delta:
  //   delta_vw = delta_px / window.innerWidth * 100
  // 然后加到 startW (vw) 上, clamp 进 [MIN_WIDTH, MAX_WIDTH].
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 防御性 bail: 锁定时不应触发拖动 (UI 上 drag surface 的 pointer-events
      // 已被设为 none, 但 hook 自身也短路避免任何 race 触发越权写入).
      if (lockedStored) return;
      dragRef.current = { startX: e.clientX, startW: width };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Drag left → reduce panel width; right → grow.
        const viewport = window.innerWidth || 1;
        const deltaPx = (ev.clientX - dragRef.current.startX) * -1;
        const deltaVw = (deltaPx / viewport) * 100;
        const next = dragRef.current.startW + deltaVw;
        setWidthStored(clampWidth(next));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, setWidthStored, lockedStored],
  );

  // panelWidth 是 vw 字符串 ('60vw' / '0'), 跟随窗口宽度变化.
  const panelWidth = open ? `${width}vw` : 0;

  return (
    <div
      data-testid="split-pane"
      style={{
        flex: '0 0 auto',
        width: panelWidth,
        minWidth: panelWidth,
        height: '100%',
        display: 'flex',
        position: 'relative',
        flexDirection: 'column',
        borderLeft: open ? '1px solid var(--border-light)' : 'none',
        // overflow 改为 visible — 让悬浮按钮和 drag handle 跨在 panel 左
        // 边缘 (borderLeft 视觉分割线) 上. 各 Tab 内部仍有自己的
        // overflow:auto / overflow:hidden, 不会让内容溢出到 Agent 区.
        overflow: 'visible',
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      {open && (
        <>
          <Tabs
            activeKey={activeTab}
            onChange={(k) => setTab(k as TabKey)}
            size="small"
            tabBarStyle={{
              margin: 0,
              padding: '0 8px',
              background: 'var(--bg-tab)',
              borderBottom: '1px solid var(--border-light)',
            }}
            items={tabItems}
          />
          {/* Splitter drag surface — 锚定在 panel 左边缘 (borderLeft 视觉分割线
              位置, Agent ↔ 分屏区 的分界). 锁定时整条 12px 宽 surface
              pointer-events: none, 误触不会拖动. 解锁后变 ew-resize cursor +
              半透明高亮, 鼠标按下开始拖动. */}
          <div
            data-testid="split-pane-handle"
            onMouseDown={onHandleMouseDown}
            style={{
              position: 'absolute',
              top: 0,
              left: -6,
              width: 12,
              height: '100%',
              cursor: lockedStored ? 'default' : 'ew-resize',
              background: lockedStored
                ? 'transparent'
                : 'rgba(255,102,0,0.06)',
              pointerEvents: lockedStored ? 'none' : 'auto',
              zIndex: 5,
            }}
            onMouseEnter={(e) => {
              if (lockedStored) return;
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,102,0,0.18)';
            }}
            onMouseLeave={(e) => {
              if (lockedStored) return;
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,102,0,0.06)';
            }}
            title={
              lockedStored
                ? `分屏宽度已锁定 — 点击悬浮按钮解锁后拖动调整 (${MIN_WIDTH}-${MAX_WIDTH}vw)`
                : `拖动以调整宽度 (${MIN_WIDTH}-${MAX_WIDTH}vw) — 点击悬浮按钮可锁定`
            }
          />
          {/* Splitter lock toggle — floating button 居中悬浮在分割线上.
              永远可点击 (zIndex > handle); 锁定时显示锁图标, 解锁时显示开锁
              图标 + ew-resize cursor (按钮自身也是拖动目标的一环).
              位置 left: -14 让按钮左右对称跨在 borderLeft 这条线上.

              颜色全部走 CSS 变量 (不写死 hex / rgba): 锁定态用 --bg-card
              + --text-secondary (两主题都有定义), 解锁态用品牌橙
              --accent-start (两主题同色). 旧实现用 var(--bg-elevated, #2a2a2a)
              在 light 主题下 fallback 出深色块, 跟浅色背景不协调, 这里改用
              真正存在的 --bg-card. */}
          <button
            type="button"
            data-testid="split-pane-lock-toggle"
            aria-label={lockedStored ? '解锁分屏宽度拖动' : '锁定分屏宽度拖动'}
            onClick={() => setLockedStored(!lockedStored)}
            style={{
              position: 'absolute',
              top: '50%',
              left: -14,
              transform: 'translateY(-50%)',
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 14,
              border: '1px solid var(--border-light)',
              background: lockedStored ? 'var(--bg-card)' : 'var(--accent-start)',
              color: lockedStored ? 'var(--text-secondary)' : '#fff',
              cursor: lockedStored ? 'pointer' : 'ew-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 6,
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
              fontSize: 14,
            }}
            title={
              lockedStored
                ? '分屏宽度已锁定, 点击解锁后可拖动调整'
                : '分屏宽度可拖动调整, 点击锁定'
            }
          >
            {lockedStored ? <LockOutlined /> : <UnlockOutlined />}
          </button>
        </>
      )}
    </div>
  );
}
