import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tabs } from 'antd';
import {
  BorderOutlined,
  ReloadOutlined,
  PicCenterOutlined,
} from '@ant-design/icons';
import { GitTab } from './GitTab.js';
import { FsTab } from './FsTab.js';
import { PlaceholderTab } from './PlaceholderTab.js';
import {
  STORAGE_KEYS,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  RESPONSIVE_BREAKPOINT,
  clampWidth,
  useLocalStorageState,
} from './shared.js';

type TabKey = 'git' | 'fs' | 'tbd';

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
    DEFAULT_WIDTH,
  );
  const width = clampWidth(widthStored);

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

  // Splitter drag state.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startW: width };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Drag left → reduce panel width; right → grow.
        const next = dragRef.current.startW + (ev.clientX - dragRef.current.startX) * -1;
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

  const panelWidth = open ? width : 0;

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
        background: '#0d0d0d',
        borderLeft: open ? '1px solid rgba(255,255,255,0.08)' : 'none',
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      <SplitPaneToggle
        open={open}
        onToggle={() => setOpenStored(!openStored)}
      />
      {open && (
        <>
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            size="small"
            tabBarStyle={{
              margin: 0,
              padding: '0 8px',
              background: '#141414',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
            items={[
              { key: 'git', label: 'Git', children: <GitTab cwd={cwd} /> },
              { key: 'fs', label: 'Files', children: <FsTab cwd={cwd} /> },
              { key: 'tbd', label: '待定', children: <PlaceholderTab /> },
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
            title={`拖动以调整宽度 (${MIN_WIDTH}-${MAX_WIDTH}px)`}
          />
        </>
      )}
    </div>
  );
}

/**
 * Companion toggle button — rendered by Agent.tsx in the left sidebar.
 */
export function SplitPaneToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="text"
      size="small"
      icon={open ? <PicCenterOutlined /> : <BorderOutlined />}
      onClick={onToggle}
      title="切换右侧分屏"
      data-testid="split-pane-toggle"
      style={{
        // Match the existing icon-button cluster in the left sidebar.
      }}
    />
  );
}

void ReloadOutlined; // re-exported for potential future "refresh" use
