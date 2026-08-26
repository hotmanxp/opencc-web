import { useCallback, useRef } from 'react';
import { FullscreenOutlined, FullscreenExitOutlined } from '@ant-design/icons';
import { clampBounds, maximizedBounds, type DesktopWindowState } from './windowMath.js';

interface DesktopWindowProps {
  win: DesktopWindowState;
  active: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  onChange: (patch: Partial<DesktopWindowState>) => void;
  viewport: { w: number; h: number };
  children: React.ReactNode;
}

export default function DesktopWindow({ win, active, onFocus, onMinimize, onToggleMax, onChange, viewport, children }: DesktopWindowProps) {
  const dragRef = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; base: { x: number; y: number; w: number; h: number } } | null>(null);

  const startDrag = useCallback((kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    onFocus();
    const base = { x: win.x, y: win.y, w: win.w, h: win.h };
    dragRef.current = { kind, startX: e.clientX, startY: e.clientY, base };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [onFocus, win.x, win.y, win.w, win.h]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === 'move') onChange({ x: g.base.x + dx, y: g.base.y + dy });
    else onChange({ w: g.base.w + dx, h: g.base.h + dy }); // resize:右下角
  }, [onChange]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  if (win.minimized) return null;

  const b = win.maximized
    ? maximizedBounds(viewport) // y 从顶栏之下开始, 标题栏不被顶栏遮挡, 保留还原入口
    : clampBounds(win, viewport, win.id);

  return (
    <section
      role="region"
      aria-label={win.title}
      data-testid={`desktop-window-${win.id}`}
      onPointerDownCapture={onFocus}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      style={{
        position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h,
        zIndex: win.z, display: 'flex', flexDirection: 'column',
        pointerEvents: 'auto', // 窗口区容器为 pointer-events:none(不拦截便签/图标),
                                // section 显式 auto 恢复窗口本体可命中可聚焦
        background: 'var(--bg-elevated, #1c1c26)', border: active ? '1px solid var(--accent-start, #ff6600)' : '1px solid var(--border-subtle, rgba(128,128,128,.3))',
        borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,.35)', overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={startDrag('move')}
        onDoubleClick={onToggleMax}
        style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', cursor: 'grab', userSelect: 'none', background: 'rgba(128,128,128,.12)' }}
      >
        <span className="title-bar-dots" aria-hidden style={{ display: 'inline-flex', gap: 6 }}>
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57' }} />
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e' }} />
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840' }} />
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', flex: 1, textAlign: 'center' }}>{win.title}</span>
        <button aria-label="最小化" onClick={onMinimize} style={titleBtn}>—</button>
        <button
          aria-label={win.maximized ? '还原' : '最大化'}
          onClick={onToggleMax}
          style={titleBtn}
        >
          {win.maximized ? <FullscreenExitOutlined style={{ fontSize: 11 }} /> : <FullscreenOutlined style={{ fontSize: 11 }} />}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      {/* 右下角 resize handle:28x28 比 18x18 更易命中;hover 出现 nwse 风格的指示符
          提示用户可拖动。所有桌面窗口(含 Agent、Explorer、Preview)统一用它。
          aria-label 让 screen reader 也能识别;hover 区域做成圆形 grab 视觉。 */}
      <div
        aria-label="调整窗口大小"
        onPointerDown={startDrag('resize')}
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, cursor: 'nwse-resize',
          zIndex: 1,
          backgroundImage:
            'linear-gradient(135deg, transparent 0%, transparent 40%, var(--text-secondary, #aaa) 40%, var(--text-secondary, #aaa) 45%, transparent 45%, transparent 60%, var(--text-secondary, #aaa) 60%, var(--text-secondary, #aaa) 65%, transparent 65%, transparent 80%, var(--text-secondary, #aaa) 80%, var(--text-secondary, #aaa) 85%, transparent 85%)',
          opacity: 0.55,
        }}
      />
    </section>
  );
}

const titleBtn: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--text-secondary, #aaa)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 4px',
};
