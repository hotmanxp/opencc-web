import { describe, it, expect } from 'vitest';
import { runLogin } from '../../src/server/services/loginRunner.js';
import type { SseEvent } from '../../src/shared/types.js';

describe('runLogin', () => {
  it('emits start event with the npx command', async () => {
    const events: SseEvent[] = [];
    // Use a short timeout to avoid hanging on npx download
    const result = runLogin('pa', (ev) => events.push(ev));
    // Don't await — just check that start event is emitted
    await new Promise((r) => setTimeout(r, 500));
    expect(events[0]?.type).toBe('start');
    expect(events[0]?.command).toContain('agent-login');
    // The process may still be running, but we've verified the API shape
  }, 10000);
});
