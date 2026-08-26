import { useRef } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import type { StickyNote } from './desktopStore.js';

const W = 160;
const H = 120;
const HEADER = 26;

export interface StickyNotesProps {
  notes: StickyNote[];
  onChange: (id: string, patch: Partial<StickyNote>) => void;
  onDelete: (id: string) => void;
  viewport: { w: number; h: number };
}

export default function StickyNotes({ notes, onChange, onDelete, viewport }: StickyNotesProps) {
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  if (notes.length === 0) return null;
  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    dragRef.current = { id, dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const x = Math.min(Math.max(0, e.clientX - g.dx), viewport.w - W);
    const y = Math.min(Math.max(0, e.clientY - g.dy), viewport.h - H - HEADER);
    onChange(g.id, { x, y });
  };
  const endDrag = () => {
    dragRef.current = null;
  };
  return (
    // 便签层 z=1:同图标区层级、靠 DOM 序压在其上;窗口 z 值恒 ≥1 且聚焦递增 → 便签始终位于窗口层之下(plan:壁纸层之上、窗口层之下)
    <div aria-label="便签层" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
      {notes.map((n) => (
        <div
          key={n.id}
          role="note"
          aria-label={`便签 ${n.id}`}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          style={{
            position: 'absolute',
            left: n.x,
            top: n.y,
            width: W,
            height: H,
            background: n.color,
            borderRadius: 10,
            boxShadow: '0 6px 20px rgba(0,0,0,.28)',
            display: 'flex',
            flexDirection: 'column',
            pointerEvents: 'auto',
            overflow: 'hidden',
          }}
        >
          <div
            onPointerDown={startDrag(n.id)}
            style={{
              height: HEADER,
              flexShrink: 0,
              cursor: 'grab',
              background: 'rgba(0,0,0,.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: '0 4px',
            }}
          >
            <button
              aria-label="删除便签"
              onClick={() => onDelete(n.id)}
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                color: 'rgba(0,0,0,.55)',
              }}
            >
              <CloseOutlined style={{ fontSize: 11 }} />
            </button>
          </div>
          <textarea
            value={n.text}
            aria-label={`便签内容 ${n.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange(n.id, { text: e.target.value })}
            style={{
              flex: 1,
              border: 0,
              outline: 'none',
              background: 'transparent',
              resize: 'none',
              padding: '4px 8px',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'rgba(0,0,0,.85)',
              fontFamily: 'inherit',
            }}
          />
        </div>
      ))}
    </div>
  );
}