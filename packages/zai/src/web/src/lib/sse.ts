import { useEffect, useRef, useCallback } from 'react';
import type { SseEvent } from '@shared/types';

const API_BASE = '/api';

export function useSse(
  path: string,
  onEvent: (ev: SseEvent) => void,
  onEnd?: () => void,
): () => void {
  const sourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  const onEndRef = useRef(onEnd);

  onEventRef.current = onEvent;
  onEndRef.current = onEnd;

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Match api.ts: callers pass a path like '/login?type=pa', and we add /api.
    // If a caller already supplies '/api/...', leave it alone so the function
    // is forgiving for the existing Login.tsx call site.
    const base = path.startsWith('/api/') ? path : `${API_BASE}${path}`;

    const source = new EventSource(base);
    sourceRef.current = source;

    source.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as SseEvent;
        onEventRef.current(ev);
        if (ev.type === 'exit' || ev.type === 'error') {
          source.close();
          onEndRef.current?.();
        }
      } catch (e) {
        console.error('Failed to parse SSE event:', e);
      }
    };

    source.onerror = () => {
      source.close();
      onEndRef.current?.();
    };

    return cleanup;
  }, [path, cleanup]);

  return cleanup;
}
