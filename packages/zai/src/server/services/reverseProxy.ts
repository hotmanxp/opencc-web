/**
 * zai CLI 反向代理 — `--lan` 时把外网请求 `/proxy/<localPort>/<path>`
 * 转发到 `127.0.0.1:<localPort>`。
 *
 * 设计动机(plan `docs/superpowers/plans/luminous-inventing-hopcroft.md`):
 * zai 已支持 `--lan` 绑定 0.0.0.0,但同 LAN 内其它端口(本地 dev server、
 * Vite HMR、SSE 长连接等)无法穿透。加这个反向代理后,一个外网端口就能
 * 暴露任意本机端口,免去 ngrok / 防火墙配置。
 *
 * 安全门槛:仅 `--lan` (host === '0.0.0.0') 时启用;默认 127.0.0.1 模式
 * 一律 403。`isEnabled` 闭包由调用方决定,本模块不感知具体来源。
 *
 * 实现细节:
 * - HTTP / SSE:基于 `node:http.request`,body 用 `req.pipe(upstreamReq)`
 *   上行,响应 `flushHeaders()` 后 `upstreamRes.pipe(res)` 下行,确保 SSE
 *   不被 buffer。
 * - WebSocket:基于 `net.connect`,手写 HTTP/1.1 upgrade 请求(必须直接
 *   写 socket,绕 http.request),然后 `socket.pipe(upstream).pipe(socket)`
 *   双向 pipe,HMR 必备。
 * - 错误处理:上游 ECONNREFUSED → 502 HTML 错误页;非 --lan → 403。
 *
 * 不开新端口:全部挂主 server,Express 中间件 + `server.on('upgrade')`。
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { RequestHandler } from 'express';

const UPSTREAM_TIMEOUT_MS = 30_000;
const PATH_PATTERN = /^\/proxy\/(\d{1,5})(\/.*)?$/;

export interface ReverseProxyOptions {
  /**
   * 返回当前是否允许代理转发。由调用方注入,本模块不感知具体来源 —
   * `createApp` 闭包读 `opts.host`,dev/start 闭包读 `options.lan`。
   */
  isEnabled: () => boolean;
}

/**
 * 502 Bad Gateway 错误页。`python -m http.server` 失败 / 未占用端口 /
 * 上游异常时统一返回。
 */
export function proxyErrorHtml(port: number): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>502 Bad Gateway</title>
<style>
body { font: 14px -apple-system, system-ui, sans-serif; padding: 40px; max-width: 560px; margin: 0 auto; color: #333; }
h1 { font-size: 22px; margin: 0 0 12px; }
code { background: #f4f4f4; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
.muted { color: #888; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<h1>502 Bad Gateway</h1>
<p>zai 反向代理无法连接到 <code>127.0.0.1:${port}</code>。</p>
<p class="muted">确认本机端口 ${port} 上有服务在运行,或检查防火墙。</p>
</body>
</html>`;
}

function isEnabledMiddleware(res: import('express').Response): boolean {
  res
    .status(403)
    .type('text/plain; charset=utf-8')
    .send(
      'Reverse proxy disabled. zai was not started with --lan. Restart with `zai --lan` to expose local services.',
    );
  return false;
}

/**
 * 解析 `/proxy/<port>/<path>` 路径。`app.use('/proxy', mw)` 是 prefix mount,
 * `req.params.port` 不可用,手解 `req.originalUrl`。
 *
 * @returns `{ port, subPath }` 或 `null` 路径非法
 */
function parseProxyPath(originalUrl: string | undefined): {
  port: number;
  subPath: string;
} | null {
  if (!originalUrl) return null;
  const m = originalUrl.match(PATH_PATTERN);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // 防 `..` 穿越:`req.originalUrl` 不会被 Express 规范化,这里 normalize 防御
  const raw = m[2] ?? '/';
  const normalized = path.posix.normalize(raw);
  // path.posix.normalize 把 `/foo/../bar` → `/bar`,但 `/../bar` 不会变
  // (它会变成 `/bar`)。安全起见,若 normalize 后变 `/`,保留 `/`,否则用原值。
  // 注意:这里允许 `..` 但禁止跨出根(`/../foo` → 已经被规范化掉)。
  return { port, subPath: normalized === '.' ? '/' : normalized };
}

/**
 * Express middleware:HTTP / SSE 反向代理。
 *
 * 用法:
 * ```ts
 * const proxyMw = createReverseProxyMiddleware({
 *   isEnabled: () => opts.host === '0.0.0.0',
 * });
 * app.use('/proxy', proxyMw);
 * ```
 */
export function createReverseProxyMiddleware(
  opts: ReverseProxyOptions,
): RequestHandler {
  return (req, res) => {
    if (!opts.isEnabled()) {
      isEnabledMiddleware(res);
      return;
    }

    const parsed = parseProxyPath(req.originalUrl);
    if (!parsed) {
      res
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('bad path, want /proxy/<port>/<path>');
      return;
    }
    const { port, subPath } = parsed;

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${port}`;
    // X-Forwarded-For 追加,逗号拼接,不覆盖已有
    const remoteAddr = req.socket?.remoteAddress ?? '';
    const existingXff = headers['x-forwarded-for'];
    const xffStr = Array.isArray(existingXff)
      ? existingXff.join(', ')
      : (existingXff ?? '');
    if (xffStr && remoteAddr) headers['x-forwarded-for'] = `${xffStr}, ${remoteAddr}`;
    else if (remoteAddr) headers['x-forwarded-for'] = remoteAddr;

    const upstreamReq = http.request({
      host: '127.0.0.1',
      port,
      path: subPath,
      method: req.method,
      headers,
    });
    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS);

    let settled = false;
    const finishWithError = () => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) {
        res
          .status(502)
          .type('text/html; charset=utf-8')
          .send(proxyErrorHtml(port));
      } else {
        res.end();
      }
    };

    upstreamReq.on('response', (upstreamRes) => {
      if (settled) return;
      res.status(upstreamRes.statusCode ?? 502);
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue;
        // 删 transfer-encoding:上游已 chunked,我们也按 chunked 下行
        if (k.toLowerCase() === 'transfer-encoding') continue;
        res.setHeader(k, v as string | string[]);
      }
      // SSE 关键:立刻 flush,触发首字节
      res.flushHeaders?.();
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (_err) => {
      finishWithError();
    });
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('upstream timeout'));
    });

    // 客户端断 → 杀上游(防 socket 泄漏)
    //
    // **重要**:不要在 `req.on('close')` 里无条件 destroy upstreamReq —
    // supertest / 普通 HTTP client 在收到完整 response 后会主动 close
    // connection,这时再 destroy upstreamReq 会触发 ECONNRESET(因为 Node
    // `ClientRequest` 内部正在收 response body,被强制 destroy 会 RST 上游
    // socket)。正确做法:监听 `res.on('close')` 并通过 `res.writableEnded`
    // 区分"response 已发完"vs"客户端中途 abort":
    //   - res.writableEnded === true → response 已发完,不要 destroy
    //   - res.writableEnded === false → 客户端中途 abort,需要 destroy upstream
    res.on('close', () => {
      if (!res.writableEnded && !upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    });

    // body 上行:手写 data/end 监听而非 `req.pipe()`,避免 race —
    //
    // Node 的 `req.pipe(target)` 在调用时同步注册 `data`/`end` listeners,
    // 但 **如果 req 的 `end` 事件在 pipe 调用之前已经触发**(Express
    // middleware 中常见:GET 无 body,req 'end' 在 listener 注册前已发),
    // pipe 会错过 `end`,导致 `upstreamReq.end()` 永远不调用,upstream 收到
    // incomplete request 后 RST,ClientRequest 触发 ECONNRESET。手写监听
    // 确保 listener 同步注册。
    req.on('data', (chunk: Buffer) => {
      if (!upstreamReq.destroyed) upstreamReq.write(chunk);
    });
    req.on('end', () => {
      if (!upstreamReq.destroyed) upstreamReq.end();
    });
    req.on('error', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
  };
}

/**
 * `server.on('upgrade')` handler:WebSocket 反向代理。
 *
 * 用法(dev/start.ts):
 * ```ts
 * const upgradeHandler = handleProxyUpgrade({ isEnabled: () => options.lan === true });
 * apiServer.on('upgrade', upgradeHandler);
 * ```
 *
 * Express 默认不处理 `upgrade`,所以 `app.use('/proxy', mw)` 不会拦截;
 * handler 在 server 层面直接接管 socket,手写 HTTP/1.1 upgrade 请求。
 */
export function handleProxyUpgrade(opts: ReverseProxyOptions) {
  return (
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void => {
    if (!opts.isEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsed = parseProxyPath(req.url);
    if (!parsed) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const { port, subPath } = parsed;

    const upstream = net.connect(port, '127.0.0.1', () => {
      // 手写 HTTP/1.1 upgrade 请求 — `http.request` 不能用于 upgrade
      // (它会读完整响应头,但 upgrade 没有响应头)。
      const inHeaders: http.IncomingHttpHeaders = req.headers;
      const headerLines: string[] = [];
      for (const [k, v] of Object.entries(inHeaders)) {
        const lower = k.toLowerCase();
        if (lower === 'upgrade' || lower === 'connection') continue;
        if (v === undefined) continue;
        headerLines.push(
          `${k}: ${Array.isArray(v) ? v.join(', ') : v}`,
        );
      }
      const upgradeVal = inHeaders.upgrade;
      const connectionVal = inHeaders.connection ?? 'Upgrade';
      const upgradeHeader = Array.isArray(upgradeVal)
        ? upgradeVal.join(', ')
        : (upgradeVal ?? 'websocket');
      const connectionHeader = Array.isArray(connectionVal)
        ? connectionVal.join(', ')
        : connectionVal;
      const newHost = `127.0.0.1:${port}`;
      // Host header 必须改写:某些严格 dev server(Vite / Express 自定义
      // host 校验)会拒绝 host=lan-ip 的请求,认为 host 不在 allowlist。
      // 这里把 host 改成 127.0.0.1:port,让 upstream 走 happy path。
      const hostIdx = headerLines.findIndex((l) =>
        l.toLowerCase().startsWith('host:'),
      );
      if (hostIdx >= 0) headerLines[hostIdx] = `Host: ${newHost}`;
      else headerLines.push(`Host: ${newHost}`);

      upstream.write(
        `${req.method} ${subPath} HTTP/1.1\r\n` +
          `${headerLines.join('\r\n')}\r\n` +
          `Upgrade: ${upgradeHeader}\r\n` +
          `Connection: ${connectionHeader}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      // 双向 pipe — HMR / 任何 WS 协议都依赖此
      socket.pipe(upstream).pipe(socket);
    });

    upstream.on('error', () => {
      try {
        socket.write(
          'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n',
        );
        socket.destroy();
      } catch {
        // ignore
      }
    });

    // 客户端断 → 杀上游
    socket.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
  };
}