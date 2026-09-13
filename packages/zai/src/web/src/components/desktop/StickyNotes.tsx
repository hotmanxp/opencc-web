import { useRef } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import type { StickyNote } from './desktopStore.js';

const W = 160;
const H = 120;
const HEADER = 26;
const MIN_W = 100;
const MIN_H = 60;
// resize handle 命中区(outer):比内胆 12x12 略大,易点击;视觉仍克制(单条细斜线)。
const RESIZE_HANDLE = 14;

const LAYER_CLS = 'absolute inset-0 pointer-events-none';
const NOTE_BASE_CLS = 'absolute flex flex-col pointer-events-auto overflow-hidden rounded-[10px] shadow-[0_6px_20px_rgba(0,0,0,0.28)]';
const NOTE_HEADER_CLS = 'h-[26px] flex-shrink-0 cursor-grab bg-[rgba(0,0,0,0.08)] flex items-center justify-end px-1';
const NOTE_DELETE_BTN_CLS = 'border-0 bg-transparent cursor-pointer text-[rgba(0,0,0,0.55)]';
const NOTE_TEXTAREA_CLS = 'flex-1 border-0 outline-none bg-transparent resize-none px-2 py-1 text-xs leading-[1.5] text-[rgba(0,0,0,0.85)] font-inherit';
const NOTE_RESIZE_CLS = 'absolute right-0 bottom-0 w-[14px] h-[14px] cursor-nwse-resize p-[2px] pointer-events-auto';
const NOTE_RESIZE_GLYPH_CLS = 'block w-full h-full opacity-35';

const RESIZE_GLYPH_STYLE: React.CSSProperties = {
  background:
    'linear-gradient(135deg, transparent 49%, var(--text-secondary, #aaa) 49%, var(--text-secondary, #aaa) 51%, transparent 51%)',
};

export interface StickyNotesProps {
  notes: StickyNote[];
  onChange: (id: string, patch: Partial<StickyNote>) => void;
  onDelete: (id: string) => void;
  /** 便签被聚焦(点击/编辑)时回调,父组件把 z 拉到最大让便签置顶 */
  onFocus?: (id: string) => void;
  viewport: { w: number; h: number };
}

export default function StickyNotes({ notes, onChange, onDelete, onFocus, viewport }: StickyNotesProps) {
  // 拖动便签:基于便签左上角的偏移(dx/dy),后续 pointermove 持续更新 x/y。
  const dragRef = useRef<{ id: string; kind: 'move' | 'resize'; dx: number; dy: number; base: { x: number; y: number; w: number; h: number } } | null>(null);
  if (notes.length === 0) return null;
  const startMove = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onFocus?.(id);
    const r = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    dragRef.current = { id, kind: 'move', dx: e.clientX - r.left, dy: e.clientY - r.top, base: { x: 0, y: 0, w: 0, h: 0 } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  // resize handle:从右下角拖动 → 同时调整 w/h 和 x/y(保持右下角在鼠标位置)。
  const startResize = (id: string, base: { x: number; y: number; w: number; h: number }) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onFocus?.(id);
    dragRef.current = { id, kind: 'resize', dx: e.clientX, dy: e.clientY, base };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  // textarea 也要触发聚焦,否则光标进入 textarea 时便签仍在底层(被其他便签遮)。
  const focusTextarea = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onFocus?.(id);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    if (g.kind === 'move') {
      const w = notes.find((n) => n.id === g.id)?.w ?? W;
      const h = notes.find((n) => n.id === g.id)?.h ?? H;
      const x = Math.min(Math.max(0, e.clientX - g.dx), viewport.w - w);
      const y = Math.min(Math.max(0, e.clientY - g.dy), viewport.h - h - HEADER);
      onChange(g.id, { x, y });
      return;
    }
    // resize:右下角固定在鼠标位置,左上角跟随 base 不动 → dx/dy 同时加给 w/h。
    const dx = e.clientX - g.dx;
    const dy = e.clientY - g.dy;
    const w = Math.max(MIN_W, Math.min(viewport.w - g.base.x, g.base.w + dx));
    const h = Math.max(MIN_H, Math.min(viewport.h - g.base.y - HEADER, g.base.h + dy));
    onChange(g.id, { w, h });
  };
  const endDrag = () => {
    dragRef.current = null;
  };
  return (
    // 便签层容器:不设 zIndex,避免创建层叠上下文卡住便签 z;便签 div 自己用
    // zIndex 参与桌面 root 的全局层叠。pointer-events:none 让容器不拦截,
    // 便签自身 pointer-events:auto 接管点击。便签默认 z=0(在所有窗口之下),
    // focus 时由 Desktop.tsx 把 z 拉到 max(windows z) + 1,确保聚焦便签置顶。
    <div aria-label="便签层" className={LAYER_CLS}>
      {notes.map((n) => {
        const w = n.w ?? W;
        const h = n.h ?? H;
        return (
          <div
            key={n.id}
            role="note"
            aria-label={`便签 ${n.id}`}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            className={NOTE_BASE_CLS}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: w,
              height: h,
              // 便签层容器 z=1,便签之间用 n.z 区分(默认 0);点击聚焦时父组件
              // 把目标 z 提到 max+1,实现"聚焦便签置顶"。
              zIndex: n.z ?? 0,
              background: n.color,
            }}
          >
            <div
              onPointerDown={startMove(n.id)}
              className={NOTE_HEADER_CLS}
            >
              <button
                aria-label="删除便签"
                onClick={() => onDelete(n.id)}
                className={NOTE_DELETE_BTN_CLS}
              >
                <CloseOutlined style={{ fontSize: 11 }} />
              </button>
            </div>
            <textarea
              value={n.text}
              aria-label={`便签内容 ${n.id}`}
              onPointerDown={focusTextarea(n.id)}
              onChange={(e) => onChange(n.id, { text: e.target.value })}
              className={NOTE_TEXTAREA_CLS}
            />
            {/* 右下角 resize handle:视觉与 DesktopWindow 对称(单条 1px 斜线,opacity 0.35)。
                命中区 RESIZE_HANDLE(14px),让便签角落易拖但又不抢戏。 */}
            <div
              aria-label="调整便签大小"
              data-testid={`sticky-resize-${n.id}`}
              onPointerDown={startResize(n.id, { x: n.x, y: n.y, w, h })}
              className={NOTE_RESIZE_CLS}
            >
              <span aria-hidden className={NOTE_RESIZE_GLYPH_CLS} style={RESIZE_GLYPH_STYLE} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
