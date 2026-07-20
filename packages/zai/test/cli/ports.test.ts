import { describe, expect, it } from 'vitest';
import {
  findAvailablePort,
  listen,
  parsePort,
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
