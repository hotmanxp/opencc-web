import type { Server } from 'node:net';
import { createServer } from 'node:net';

export function parsePort(value: string, field: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return n;
}

export function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function findAvailablePort(
  start: number,
  maxAttempts = 100,
): Promise<{ port: number; server: Server }> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset;
    try {
      const server = await listen(candidate);
      return { port: candidate, server };
    } catch {
      continue;
    }
  }
  throw new Error(
    `No available port found in range [${start}, ${start + maxAttempts - 1}]`,
  );
}