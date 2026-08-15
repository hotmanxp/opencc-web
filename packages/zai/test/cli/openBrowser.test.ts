import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports, so the mock factory must not reference
// any top-level let/const. Use vi.hoisted to share a mock handle.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock('open', () => ({
  default: openMock,
}));

import { openBrowser } from '../../src/cli/openBrowser.js';

describe('openBrowser', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('calls open() with the given URL', async () => {
    openMock.mockResolvedValue({} as never);
    openBrowser('http://localhost:9201');
    // openBrowser is fire-and-forget; wait one tick for the promise to resolve.
    await new Promise((r) => setImmediate(r));
    expect(openMock).toHaveBeenCalledWith('http://localhost:9201');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('downgrades spawn failures to a warning instead of throwing', async () => {
    // Simulate what `open` throws when the underlying `open`/`start`/
    // `xdg-open` binary is missing or there is no GUI (e.g. headless
    // container, missing browser on WSL). This is the exact failure
    // mode that previously surfaced as an uncaught `spawn open ENOENT`
    // on Windows.
    const enoent = Object.assign(new Error('spawn open ENOENT'), {
      code: 'ENOENT',
    });
    openMock.mockRejectedValue(enoent);

    openBrowser('http://localhost:9201');
    await new Promise((r) => setImmediate(r));

    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some((m) => m.includes('failed to open browser')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('http://localhost:9201'))).toBe(
      true,
    );
  });
});

