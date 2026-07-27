import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs } from 'antd';
import { GitTab } from './GitTab.js';
import { FsTab } from './FsTab.js';
import { BashTab } from './BashTab.js';
import { useAgentStore } from '../../store/useAgentStore.js';
import {
  STORAGE_KEYS,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH_VW,
  RESPONSIVE_BREAKPOINT,
  clampWidth,
  useLocalStorageState,
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
  const [openStored, setOpenStored] = useLocalStorageState<boolean>(STORAGE_KEYS.open, false);
  const [tab, setTab] = useLocalStorageState<TabKey>(STORAGE_KEYS.tab, 'git');
  const [widthStored, setWidthStored] = useLocalStorageState<number>(
    STORAGE_KEYS.width,
    resolveInitialWidth(),
  );
  const width = clampWidth(widthStored);
  const activeSessionId = useAgentStore((s) => s.sessionId ?? null)

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
    [width, setWidthStored],
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
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      {open && (
        <>
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            size="small"
            tabBarStyle={{
              margin: 0,
              padding: '0 8px',
              background: 'var(--bg-tab)',
              borderBottom: '1px solid var(--border-light)',
            }}
            items={[
              { key: 'fs', label: 'Files', children: <FsTab cwd={cwd} /> },
              { key: 'git', label: 'Git', children: <GitTab cwd={cwd} /> },
              { key: 'bash', label: 'Bash', children: <BashTab sessionId={activeSessionId} cwd={cwd} /> },
            ]}
          />
          {/* Splitter handle — drag to resize. */}
          <div
            data-testid="split-pane-handle"
            onMouseDown={onHandleMouseDown}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 6,
              height: '100%',
              cursor: 'ew-resize',
              background: 'transparent',
              zIndex: 5,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,102,0,0.18)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
            title={`拖动以调整宽度 (${MIN_WIDTH}-${MAX_WIDTH}vw)`}
          />
        </>
      )}
    </div>
  );
}
