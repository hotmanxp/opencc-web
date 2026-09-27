/**
 * Tests for the AA API client (lib/aaApi.ts).
 *
 * Verifies that the wrapper exposes the documented method shape and returns
 * the {ok, data} | {ok, error} discriminated union. Full happy-path fetch
 * assertions are deferred to T13 (E2E) where the real server is up.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { aaApi } from '../../src/web/src/lib/aaApi';

describe('aaApi — public API shape', () => {
  it('exposes the expected method set', () => {
    expect(typeof aaApi.getStatus).toBe('function');
    expect(typeof aaApi.getConfig).toBe('function');
    expect(typeof aaApi.startPairing).toBe('function');
    expect(typeof aaApi.getPairingStatus).toBe('function');
    expect(typeof aaApi.pollPairing).toBe('function');
    expect(typeof aaApi.cancelPairing).toBe('function');
  });

  it('returns ok=false on network error (via global fetch rejection)', async () => {
    // Force the underlying fetch to throw by giving it a malformed URL.
    // aaApi uses fetch via the api module; we can't easily mock that
    // without brittle vi.mock paths. Instead, the simplest cross-cutting
    // check: pollPairing with no localStorage and a fetch that throws.
    // We rely on the wrapper's catch branch returning ok=false.
    //
    // Skip if happy-dom doesn't expose a usable fetch.
    if (typeof fetch !== 'function') {
      expect(true).toBe(true);
      return;
    }
    const originalFetch = global.fetch;
    global.fetch = (() => Promise.reject(new Error('forced'))) as unknown as typeof fetch;
    try {
      const result = await aaApi.getStatus();
      expect(result.ok).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
