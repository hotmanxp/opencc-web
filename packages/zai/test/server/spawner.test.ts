import { describe, it, expect } from 'vitest';
import { spawn } from '../../src/server/services/spawner.js';
import type { SseEvent } from '../../src/shared/types.js';

describe('spawn', () => {
  it('emits start and exit events for a simple command', async () => {
    const events: SseEvent[] = [];
    const onLine = (e: SseEvent) => events.push(e);

    const result = await spawn('echo', ['hello'], onLine);

    expect(events[0]?.type).toBe('start');
    expect(events[0]?.command).toBe('echo hello');
    expect(events.some((e) => e.type === 'stdout' && e.line?.includes('hello'))).toBe(true);
    expect(events[events.length - 1]?.type).toBe('exit');
    expect(result.code).toBe(0);
  });

  it('captures stderr for failing commands', async () => {
    const events: SseEvent[] = [];
    await spawn('node', ['-e', 'console.error("oops"); process.exit(2)'], (e) => events.push(e));

    expect(events.some((e) => e.type === 'stderr' && e.line?.includes('oops'))).toBe(true);
    expect(events[events.length - 1]?.type).toBe('exit');
    expect(events[events.length - 1]?.code).toBe(2);
  });

  it('supports custom timeout', async () => {
    const events: SseEvent[] = [];
    // sleep 2s with 500ms timeout should error
    await spawn('sleep', ['2'], (e) => events.push(e), { timeout: 500 });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('rejects when the command does not exist (ENOENT)', async () => {
    const events: SseEvent[] = [];
    const onLine = (e: SseEvent) => events.push(e);

    await expect(spawn('definitely-not-a-real-cmd-xyz', [], onLine)).rejects.toThrow();

    // Should still emit an error SSE event so the client sees what happened.
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // Must NOT emit a spurious 'exit' event with code 0 on spawn failure.
    expect(events.find((e) => e.type === 'exit' && e.code === 0)).toBeUndefined();
  });

  it('closes child stdin so commands waiting on EOF do not hang', async () => {
    const events: SseEvent[] = [];
    // node script: read stdin to EOF, then print "got-stdin" and exit.
    // If parent never ends stdin, this hangs forever.
    const onLine = (e: SseEvent) => events.push(e);

    const result = await spawn(
      'node',
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { console.log("got-stdin"); process.exit(0); })'],
      onLine,
      { timeout: 3000 },
    );

    expect(result.code).toBe(0);
    expect(events.some((e) => e.type === 'stdout' && e.line?.includes('got-stdin'))).toBe(true);
  });
});
