import { ApiError, notifyApiError } from './apiError.js';

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    const err = new ApiError(res.status, method, path, body);
    notifyApiError(err);
    throw err;
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // 加 init 参数让调用方能传 headers (e.g. X-Session-Id). 兼容老调用
  // (init 可选). body 优先用 body, headers 走 init.headers, Content-Type
  // 由 request() 内部合并 — 调用方传进来的 headers 不会覆盖 Content-Type.
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      ...(init ?? {}),
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};