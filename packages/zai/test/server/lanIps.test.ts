import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

// vi.hoisted is needed so the binding survives vitest's mock-factory
// hoisting — vi.mock is moved to the top of the file before any imports run,
// so a plain `let` declaration would be inaccessible from inside the factory.
// We stash the real networkInterfaces here so beforeEach can reset the mock
// back to real OS behavior for the first two tests, while the third test
// still overrides via mockReturnValueOnce. This replaces the brief's broken
// `vi.spyOn` pattern (unsupported on non-configurable ESM namespace exports
// like node:os).
const { actualOsNetworkInterfacesRef } = vi.hoisted(() => ({
  actualOsNetworkInterfacesRef: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  actualOsNetworkInterfacesRef.mockImplementation(actual.networkInterfaces);
  return {
    ...actual,
    networkInterfaces: vi.fn(actual.networkInterfaces),
  };
});

import { detectLanIps } from '../../src/server/utils/lanIps.js';

describe('detectLanIps', () => {
  beforeEach(() => {
    vi.mocked(os.networkInterfaces).mockReset();
    vi.mocked(os.networkInterfaces).mockImplementation(
      actualOsNetworkInterfacesRef as typeof os.networkInterfaces,
    );
  });

  it('excludes loopback (127.0.0.1) and internal IPv6', () => {
    const ips = detectLanIps();
    expect(ips).not.toContain('127.0.0.1');
    // 不应含 IPv6 格式(无冒号)
    for (const ip of ips) {
      expect(ip).not.toContain(':');
    }
  });

  it('returns an array of IPv4 strings only', () => {
    const ips = detectLanIps();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it('dedupes duplicate addresses from multiple interfaces', () => {
    vi.mocked(os.networkInterfaces).mockReturnValueOnce({
      eth0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as any,
      ],
      wlan0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as any,
      ],
    });
    const ips = detectLanIps();
    const dup = ips.filter((x) => x === '192.168.1.5');
    expect(dup.length).toBe(1);
  });
});