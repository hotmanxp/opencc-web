import { useCallback, useRef, useState } from 'react';
import { clampBounds, maximizedBounds, type DesktopWindowState } from './windowMath.js';

interface DesktopWindowProps {
  win: DesktopWindowState;
  active: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  /** 关闭:红点触发;不传时红点禁用,避免核心窗口被误关。 */
  onClose?: () => void;
  onChange: (patch: Partial<DesktopWindowState>) => void;
  viewport: { w: number; h: number };
  /** 标题栏右端插槽(如 Agent 窗口的快捷新建按钮);不传时右端留白。 */
  titleExtra?: React.ReactNode;
  children: React.ReactNode;
}

export default function DesktopWindow({ win, active, onFocus, onMinimize, onToggleMax, onClose, onChange, viewport, titleExtra, children }: DesktopWindowProps) {
  const dragRef = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; base: { x: number; y: number; w: number; h: number } } | null>(null);
  // macOS 风格:三圆点 hover 时才显示内部符号(× / − / +)。容器级 hover 状态。
  const [dotsHover, setDotsHover] = useState(false);

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
        {/* macOS 风格三圆点:红=关闭 / 黄=最小化 / 绿=最大化或还原。
            三个圆点一律可点 — 即便核心窗口被红点关闭,Desktop.tsx 的 restoreWindow
            + Dock 点击提供恢复入口,不需要 disabled 防御逻辑。 */}
        <span
          className="title-bar-dots"
          onMouseEnter={() => setDotsHover(true)}
          onMouseLeave={() => setDotsHover(false)}
          style={{ display: 'inline-flex', gap: 6 }}
        >
          <button
            type="button"
            aria-label="关闭"
            onClick={(e) => { e.stopPropagation(); onClose?.(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ ...dotBtn, background: '#ff5f57' }}
          >
            <span aria-hidden style={{ ...dotSymbol, opacity: dotsHover ? 1 : 0 }}>×</span>
          </button>
          <button
            type="button"
            aria-label="最小化"
            onClick={(e) => { e.stopPropagation(); onMinimize(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ ...dotBtn, background: '#febc2e' }}
          >
            <span aria-hidden style={{ ...dotSymbol, opacity: dotsHover ? 1 : 0 }}>−</span>
          </button>
          <button
            type="button"
            aria-label={win.maximized ? '还原' : '最大化'}
            onClick={(e) => { e.stopPropagation(); onToggleMax(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ ...dotBtn, background: '#28c840' }}
          >
            <span aria-hidden style={{ ...dotSymbol, opacity: dotsHover ? 1 : 0 }}>+</span>
          </button>
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', flex: 1, textAlign: 'center', pointerEvents: 'none' }}>{win.title}</span>
        {titleExtra && (
          // stopPropagation 防触发标题栏拖拽/双击最大化;与三圆点按钮同等处理。
          <span
            style={{ display: 'inline-flex', alignItems: 'center' }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {titleExtra}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      {/* 右下角 resize handle:14x14 极小尺寸,单条 1px 斜线指示,hover 时才完全显示
          (默认 0.35 不透明度避免视觉抢戏)。所有桌面窗口(Agent/Explorer/Preview)统一用它。
          实际可命中区域扩展到 20x20(右下角 padding 6px)便于点击。 */}
      <div
        aria-label="调整窗口大小"
        onPointerDown={startDrag('resize')}
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 20, height: 20, cursor: 'nwse-resize',
          zIndex: 1,
          padding: 3,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'block', width: '100%', height: '100%',
            background:
              'linear-gradient(135deg, transparent 49%, var(--text-secondary, #aaa) 49%, var(--text-secondary, #aaa) 51%, transparent 51%)',
            opacity: 0.35,
          }}
        />
      </div>
    </section>
  );
}

/** macOS 风格圆点按钮:12x12 圆形,默认隐藏 ×/−/+ 符号,hover 才显示(系统规范)。
 *  width 略大于 macOS 11px 是为了桌面落点更易命中(配合桌面非高 DPI 触摸场景)。 */
const dotBtn: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: '50%',
  border: 0,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(0,0,0,.55)',
  fontSize: 9,
  lineHeight: 1,
  cursor: 'pointer',
};
/** 符号层样式:opacity 由调用方通过容器 hover state 注入(React inline style 不支持 :hover)。 */
const dotSymbol: React.CSSProperties = {
  opacity: 0,
  transition: 'opacity 80ms',
  pointerEvents: 'none',
};
