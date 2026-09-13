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

const SECTION_BASE = 'flex flex-col pointer-events-auto overflow-hidden rounded-[10px] shadow-[0_10px_40px_rgba(0,0,0,0.35)] bg-[var(--bg-elevated,#1c1c26)]';
const SECTION_BORDER_ACTIVE = 'border-[1px_solid_var(--accent-start,#ff6600)]';
const SECTION_BORDER_INACTIVE = 'border-[1px_solid_var(--border-subtle,rgba(128,128,128,0.3))]';
const TITLE_BAR_CLS = 'h-[34px] flex-shrink-0 flex items-center gap-2 px-[10px] cursor-grab select-none bg-[rgba(128,128,128,0.12)]';
const DOTS_CONTAINER_CLS = 'inline-flex gap-[6px]';
const DOT_BTN_CLS = 'inline-flex items-center justify-center w-3 h-3 rounded-full border-0 p-0 text-[rgba(0,0,0,0.55)] text-[9px] leading-none cursor-pointer';
const DOT_SYMBOL_CLS = 'pointer-events-none transition-opacity duration-75';
const TITLE_TEXT_CLS = 'flex-1 text-center pointer-events-none text-xs text-[var(--text-secondary,#aaa)]';
const TITLE_EXTRA_CLS = 'inline-flex items-center';
const CONTENT_CLS = 'flex-1 min-h-0 overflow-auto';
const RESIZE_HANDLE_CLS = 'absolute right-0 bottom-0 w-5 h-5 cursor-nwse-resize z-[1] p-[3px]';
const RESIZE_GLYPH_CLS = 'block w-full h-full opacity-35';
// 命中区略大于视觉斜线,易于命中;视觉仍是单条 1px 斜线、opacity 0.35 不抢戏。
const RESIZE_GLYPH_STYLE: React.CSSProperties = {
  background:
    'linear-gradient(135deg, transparent 49%, var(--text-secondary, #aaa) 49%, var(--text-secondary, #aaa) 51%, transparent 51%)',
};

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

  const sectionCls = `${SECTION_BASE} ${active ? SECTION_BORDER_ACTIVE : SECTION_BORDER_INACTIVE}`;

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
        zIndex: win.z,
      }}
      className={sectionCls}
    >
      <div
        onPointerDown={startDrag('move')}
        onDoubleClick={onToggleMax}
        className={TITLE_BAR_CLS}
      >
        {/* macOS 风格三圆点:红=关闭 / 黄=最小化 / 绿=最大化或还原。
            三个圆点一律可点 — 即便核心窗口被红点关闭,Desktop.tsx 的 restoreWindow
            + Dock 点击提供恢复入口,不需要 disabled 防御逻辑。 */}
        <span
          className={`title-bar-dots ${DOTS_CONTAINER_CLS}`}
          onMouseEnter={() => setDotsHover(true)}
          onMouseLeave={() => setDotsHover(false)}
        >
          <button
            type="button"
            aria-label="关闭"
            onClick={(e) => { e.stopPropagation(); onClose?.(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={DOT_BTN_CLS}
            style={{ background: '#ff5f57' }}
          >
            <span aria-hidden className={`${DOT_SYMBOL_CLS} ${dotsHover ? 'opacity-100' : 'opacity-0'}`}>×</span>
          </button>
          <button
            type="button"
            aria-label="最小化"
            onClick={(e) => { e.stopPropagation(); onMinimize(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={DOT_BTN_CLS}
            style={{ background: '#febc2e' }}
          >
            <span aria-hidden className={`${DOT_SYMBOL_CLS} ${dotsHover ? 'opacity-100' : 'opacity-0'}`}>−</span>
          </button>
          <button
            type="button"
            aria-label={win.maximized ? '还原' : '最大化'}
            onClick={(e) => { e.stopPropagation(); onToggleMax(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={DOT_BTN_CLS}
            style={{ background: '#28c840' }}
          >
            <span aria-hidden className={`${DOT_SYMBOL_CLS} ${dotsHover ? 'opacity-100' : 'opacity-0'}`}>+</span>
          </button>
        </span>
        <span className={TITLE_TEXT_CLS}>{win.title}</span>
        {titleExtra && (
          // stopPropagation 防触发标题栏拖拽/双击最大化;与三圆点按钮同等处理。
          <span
            className={TITLE_EXTRA_CLS}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {titleExtra}
          </span>
        )}
      </div>
      <div className={CONTENT_CLS}>{children}</div>
      {/* 右下角 resize handle:14x14 极小尺寸,单条 1px 斜线指示,hover 时才完全显示
          (默认 0.35 不透明度避免视觉抢戏)。所有桌面窗口(Agent/Explorer/Preview)统一用它。
          实际可命中区域扩展到 20x20(右下角 padding 6px)便于点击。 */}
      <div
        aria-label="调整窗口大小"
        onPointerDown={startDrag('resize')}
        className={RESIZE_HANDLE_CLS}
      >
        <span aria-hidden className={RESIZE_GLYPH_CLS} style={RESIZE_GLYPH_STYLE} />
      </div>
    </section>
  );
}
