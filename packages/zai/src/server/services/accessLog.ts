import { appendFileSync } from 'node:fs';

/**
 * HTTP/上游调用日志 — console 与 /tmp/zai-http.log 双写。
 *
 * 背景: zai 的 dev/start 进程 stdout 常被重定向到终端或任务文件, 排障时
 * 没人盯着终端 console 输出就丢了。这里把同一条日志落盘到固定路径
 * /tmp/zai-http.log, 排查 500 时直接 `tail /tmp/zai-http.log` 即可。
 *
 * 级别语义: error/warn 无条件打 console; debug 仅在 ZAI_DEBUG=1 时打
 * (与调用方已有多处 `if (ZAI_DEBUG === '1')` 的惯例保持一致)。
 * 落盘失败静默忽略 — 日志不能拖垮请求路径。
 */
const LOG_FILE = '/tmp/zai-http.log';

export function logHttp(line: string, level: 'error' | 'warn' | 'debug' = 'debug'): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (process.env.ZAI_DEBUG === '1') console.error(line);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore — logging must never break the request path
  }
}