import type { Server } from 'node:net';
import { createServer } from 'node:net';

export function parsePort(value: string, field: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return n;
}

export function listen(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
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

/**
 * Verify a specific port is bindable on `host` (default loopback) without
 * keeping the listener around. Used by the instance supervisor when the
 * user pins a fixed port on an instance definition: bind a probe server,
 * close it immediately, and let the real child process race for the port
 * afterwards. If `listen` rejects (e.g. `EADDRINUSE`) the caller surfaces
 * a clear error and marks the instance `down`.
 *
 * Kept separate from `findAvailablePort` so the auto-allocation path
 * remains a pure scan; this entrypoint makes the "user asked for X,
 * X is not free" contract explicit.
 */
export async function assertPortAvailable(
  port: number,
  host = '127.0.0.1',
): Promise<void> {
  const server = await listen(port, host);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * 解析服务端口:
 * - 显式指定了端口(explicit):必须空闲,被占用直接抛 EADDRINUSE 错误
 *   (调用方应报错退出,禁止静默递增 —— 多实例静默换端口是请求风暴根因之一)。
 * - 未指定端口:自动扫描 base 起的空闲端口(保留原宽松行为)。
 * 探测用的 server 在返回前已关闭,不占用端口。
 */
export async function resolveServerPort(opts: {
  explicit?: number;
  base: number;
  host?: string;
}): Promise<number> {
  if (opts.explicit !== undefined) {
    await assertPortAvailable(opts.explicit, opts.host);
    return opts.explicit;
  }
  const { port, server } = await findAvailablePort(opts.base);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}