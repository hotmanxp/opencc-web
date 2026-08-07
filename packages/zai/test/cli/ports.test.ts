import { describe, expect, it } from 'vitest';
import {
  assertPortAvailable,
  findAvailablePort,
  listen,
  parsePort,
  resolveServerPort,
} from '../../src/cli/ports.js';

describe('parsePort', () => {
  it('returns integer for valid port string', () => {
    expect(parsePort('8080', 'port')).toBe(8080);
  });
  it('throws for non-integer', () => {
    expect(() => parsePort('abc', 'port')).toThrow('port must be an integer');
  });
  it('throws for out-of-range port', () => {
    expect(() => parsePort('99999', 'port')).toThrow(
      'port must be an integer',
    );
    expect(() => parsePort('0', 'port')).toThrow('port must be an integer');
  });
});

describe('listen', () => {
  it('resolves with a server on an available port', async () => {
    const server = await listen(0);
    expect(server).toBeDefined();
    server.close();
  });

  it('rejects when port is already in use', async () => {
    const server = await listen(0);
    const port = (server.address() as { port: number }).port;
    await expect(listen(port)).rejects.toThrow();
    server.close();
  });

  it('binds to specified host (0.0.0.0 for --lan)', async () => {
    const server = await listen(0, '0.0.0.0');
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe('0.0.0.0');
    expect(addr.port).toBeGreaterThan(0);
    server.close();
  });
});

describe('findAvailablePort', () => {
  it('returns the start port when it is available', async () => {
    const { port, server } = await findAvailablePort(49200);
    expect(port).toBe(49200);
    server.close();
  });

  it('skips occupied ports and returns the next available', async () => {
    const blocker = await listen(49300);
    const { port, server } = await findAvailablePort(49300);
    expect(port).toBe(49301);
    blocker.close();
    server.close();
  });

  it('throws when all candidates are exhausted', async () => {
    const servers = [];
    const base = 49400;
    for (let i = 0; i < 3; i++) {
      servers.push(await listen(base + i));
    }
    await expect(findAvailablePort(base, 3)).rejects.toThrow(
      'No available port found',
    );
    for (const s of servers) s.close();
  });
});

describe('assertPortAvailable', () => {
  it('resolves when the port is free', async () => {
    const base = 49500;
    // Best-effort cleanup if a previous run left a listener.
    const probe = await listen(0);
    const used = (probe.address() as { port: number }).port;
    probe.close();
    const candidate = used === base ? base + 1 : base;
    await expect(assertPortAvailable(candidate)).resolves.toBeUndefined();
  });

  it('rejects with a port-bearing error when the port is already bound', async () => {
    const blocker = await listen(0);
    try {
      const occupied = (blocker.address() as { port: number }).port;
      await expect(assertPortAvailable(occupied)).rejects.toThrow();
    } finally {
      blocker.close();
    }
  });

  it('does not leak the probe server (port is reusable after resolve)', async () => {
    const probe = await listen(0);
    const port = (probe.address() as { port: number }).port;
    probe.close();
    await assertPortAvailable(port);
    // A second assertPortAvailable on the same port should still succeed,
    // proving the previous probe closed cleanly.
    await expect(assertPortAvailable(port)).resolves.toBeUndefined();
  });
});

describe('resolveServerPort', () => {
  it('returns the explicit port when it is free', async () => {
    const probe = await listen(0);
    const port = (probe.address() as { port: number }).port;
    probe.close();
    await expect(resolveServerPort({ explicit: port, base: port })).resolves.toBe(port);
  });

  it('rejects with EADDRINUSE when the explicit port is occupied (no silent bump)', async () => {
    const blocker = await listen(0);
    try {
      const occupied = (blocker.address() as { port: number }).port;
      await expect(
        resolveServerPort({ explicit: occupied, base: occupied }),
      ).rejects.toThrow();
    } finally {
      blocker.close();
    }
  });

  it('scans from base when no explicit port is given', async () => {
    const probe = await listen(0);
    const free = (probe.address() as { port: number }).port;
    probe.close();
    // base = free → auto path returns the same free port
    const port = await resolveServerPort({ base: free });
    expect(port).toBe(free);
  });

  it('skips an occupied base and returns base+1 when auto-allocating', async () => {
    const blocker = await listen(0);
    const base = (blocker.address() as { port: number }).port;
    try {
      const port = await resolveServerPort({ base });
      expect(port).toBe(base + 1);
    } finally {
      blocker.close();
    }
  });

  it('closes the probe server after auto-allocation (port is reusable)', async () => {
    const probe = await listen(0);
    const base = (probe.address() as { port: number }).port;
    probe.close();
    const port = await resolveServerPort({ base });
    // 第二次调用(显式传刚拿到的端口)应成功,证明探测 server 已关
    await expect(resolveServerPort({ explicit: port, base: port })).resolves.toBe(port);
  });
});
