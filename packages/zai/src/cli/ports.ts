import type { Server } from 'node:net';
import { createConnection, createServer } from 'node:net';

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

/**
 * Liveness probe: try to TCP-connect to the port on loopback. If anything
 * on any local address is listening (`*:port`, `127.0.0.1:port`, `::1:port`),
 * the kernel routes the SYN to it and `connect` resolves — bound or not,
 * port is busy. ECONNREFUSED → port is free.
 *
 * This catches the SO_REUSEADDR split-bind case the bare-bind probe misses:
 * on macOS/BSD a wildcard bind (`*:9201` from `--lan`) does NOT block a
 * later specific bind (`127.0.0.1:9201`), so `listen(9201, '127.0.0.1')`
 * succeeds even though 9201 is already serving traffic. The kernel still
 * happily delivers connections to EITHER listener, so two zai instances end
 * up sharing the port — kernel splits browser requests between them
 * non-deterministically (split-brain), with one instance running turns and
 * the other holding the SSE stream the UI is reading. Result: silent
 * "model replied, UI saw nothing" — the bug 2026-08-27 print-runtime
 * verification surfaced.
 *
 * Cheap, no socket held, race-free as long as it's done BEFORE any bind
 * on the same port (otherwise we self-connect to our own probe).
 */
async function isPortBusy(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host });
      let settled = false;
      const finish = (busy: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(busy);
      };
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      // Hard ceiling on the probe. socket.setTimeout() only configures
      // SO_RCVTIMEO/SO_SNDTIMEO — it does NOT time out a stalled connect;
      // on `::1` with IPv6 routing blackholed, ECONNREFUSED can take
      // seconds (full TCP SYN retransmit window). A JS-side guard keeps
      // the probe bounded so `findAvailablePort` never hangs.
      const t = setTimeout(() => finish(false), 200);
      t.unref?.();
    });
  // Either loopback family resolves if SOMETHING (specific or wildcard)
  // is bound. Probing both covers `:::port` IPv6 wildcard on systems
  // where IPV6_V6ONLY=1 is set, which would otherwise let `127.0.0.1:port`
  // connect fail to reveal the conflict.
  const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('::1')]);
  return v4 || v6;
}

export async function findAvailablePort(
  start: number,
  maxAttempts = 100,
): Promise<{ port: number; server: Server }> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset;
    // Liveness before bind — catches cross-bind conflicts bind alone misses.
    if (await isPortBusy(candidate)) continue;
    try {
      const server = await listen(candidate);
      return { port: candidate, server };
    } catch {
      // Raced: somebody bound between our connect probe and our bind.
      // Skip and keep scanning.
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
  // Liveness check first — the same SO_REUSEADDR split-bind that fools
  // `findAvailablePort` would fool explicit-port callers too. Without
  // this, `zai --port 9201` happily binds 127.0.0.1:9201 next to an
  // existing `zai --lan` on *:9201 and produces the same split-brain.
  if (await isPortBusy(port)) {
    const err: NodeJS.ErrnoException = new Error(
      `Port ${port} is already in use`,
    );
    err.code = 'EADDRINUSE';
    throw err;
  }
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