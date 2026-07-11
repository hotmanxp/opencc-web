import { useEffect, useRef } from 'react';
import type { SseEvent } from '@shared/types';

interface LogPanelProps {
  events: SseEvent[];
  title?: string;
}

export default function LogPanel({ events, title }: LogPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div
      style={{
        background: '#0a0a0f',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {title && (
        <div
          style={{
            padding: '8px 16px',
            background: 'rgba(255, 102, 0, 0.1)',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            fontFamily: 'monospace',
          }}
        >
          {title}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          padding: 16,
          height: 384,
          overflowY: 'auto',
          fontFamily: 'JetBrains Mono, Fira Code, monospace',
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--text-primary)',
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)' }}>等待日志...</div>
        ) : (
          events.map((ev, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {ev.type === 'start' && (
                <span style={{ color: '#ff8533' }}>▶ {ev.command}</span>
              )}
              {ev.type === 'stdout' && <span>{ev.line}</span>}
              {ev.type === 'stderr' && <span style={{ color: '#ef4444' }}>{ev.line}</span>}
              {ev.type === 'exit' && (
                <span style={{ color: '#f59e0b' }}>✓ 退出码: {ev.code}</span>
              )}
              {ev.type === 'error' && (
                <span style={{ color: '#ef4444', fontWeight: 600 }}>✗ {ev.message}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
