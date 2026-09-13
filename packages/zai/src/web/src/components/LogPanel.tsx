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
    <div className="bg-[var(--bg-body)] rounded-lg overflow-hidden border border-[var(--border-subtle)]">
      {title && (
        <div className="px-4 py-2 bg-[rgba(255,102,0,0.1)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] font-mono">
          {title}
        </div>
      )}
      <div
        ref={containerRef}
        className="p-4 h-96 overflow-y-auto font-[JetBrains_Mono,Fira_Code,monospace] text-[13px] leading-relaxed text-[var(--text-primary)]"
      >
        {events.length === 0 ? (
          <div className="text-[var(--text-tertiary)]">等待日志...</div>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {ev.type === 'start' && (
                <span className="text-[#ff8533]">▶ {ev.command}</span>
              )}
              {ev.type === 'stdout' && <span>{ev.line}</span>}
              {ev.type === 'stderr' && <span className="text-[#ef4444]">{ev.line}</span>}
              {ev.type === 'exit' && (
                <span className="text-[#f59e0b]">✓ 退出码: {ev.code}</span>
              )}
              {ev.type === 'error' && (
                <span className="text-[#ef4444] font-semibold">✗ {ev.message}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}