import type { Response } from 'express';
import type { SseEvent } from '../../shared/types.js';

export interface SseStream {
  send: (event: SseEvent) => void;
  end: () => void;
}

export function createSseStream(res: Response): SseStream {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  return {
    send(event: SseEvent) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      res.end();
    },
  };
}
