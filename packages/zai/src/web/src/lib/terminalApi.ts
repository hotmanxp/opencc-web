import type {
  CreateTerminalRequest,
  TerminalEnvironment,
  TerminalShell,
  WebTerminalInfo,
} from '../../../shared/terminal.js'

/**
 * 持久 PTY 终端 API client（分屏 Bash 面板）。
 * 与 bashReplApi.ts 同风格：裸 fetch，非 2xx 抛 TerminalApiError。
 * hint 字段来自服务端 503（node-pty 装不上时的修复提示），UI 直接展示。
 */
export class TerminalApiError extends Error {
  readonly status: number
  readonly hint: string | undefined

  constructor(message: string, status: number, hint?: string) {
    super(message)
    this.name = 'TerminalApiError'
    this.status = status
    this.hint = hint
  }
}

async function readError(res: Response): Promise<TerminalApiError> {
  let detail = ''
  let hint: string | undefined
  try {
    const json = (await res.json()) as { error?: string; hint?: string }
    detail = json.error ?? ''
    hint = json.hint
  } catch {
    detail = await res.text().catch(() => '')
  }
  return new TerminalApiError(`terminal api ${res.status}: ${detail}`.trim(), res.status, hint)
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

/** 能力与上限（含 node-pty 可用性）。 */
export async function fetchTerminalEnvironment(cwd: string | null): Promise<TerminalEnvironment> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
  return getJson<TerminalEnvironment>(`/api/terminal/environment${query}`)
}

/** 本机已安装的 shell（`+` 菜单用）。 */
export async function fetchTerminalShells(): Promise<TerminalShell[]> {
  const json = await getJson<{ shells: TerminalShell[] }>('/api/terminal/shells')
  return json.shells
}

/** 该会话保留的终端（刷新后重建 tab 用）。 */
export async function fetchTerminalList(sessionId: string): Promise<WebTerminalInfo[]> {
  const json = await getJson<{ terminals: WebTerminalInfo[] }>(
    `/api/terminal/list?sessionId=${encodeURIComponent(sessionId)}`,
  )
  return json.terminals
}

export async function createTerminal(request: CreateTerminalRequest): Promise<WebTerminalInfo> {
  return postJson<WebTerminalInfo>('/api/terminal/create', request)
}

function terminalUrl(id: string, action: string, sessionId: string): string {
  return `/api/terminal/${encodeURIComponent(id)}/${action}?sessionId=${encodeURIComponent(sessionId)}`
}

export async function writeTerminal(sessionId: string, id: string, data: string): Promise<void> {
  await postJson<{ ok: true }>(terminalUrl(id, 'write', sessionId), { data })
}

export async function resizeTerminal(
  sessionId: string,
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  await postJson<{ ok: true }>(terminalUrl(id, 'resize', sessionId), { cols, rows })
}

export async function renameTerminal(sessionId: string, id: string, title: string): Promise<void> {
  await postJson<{ ok: true }>(terminalUrl(id, 'rename', sessionId), { title })
}

/** 关闭终端并杀掉其 shell 进程（关 tab 才调；收起分屏/切 tab 不调）。 */
export async function closeTerminal(sessionId: string, id: string): Promise<void> {
  await postJson<{ ok: true }>(terminalUrl(id, 'close', sessionId), {})
}

/** SSE 输出流：首帧 snapshot，随后 output / state。 */
export function terminalEventsUrl(sessionId: string, id: string): string {
  return terminalUrl(id, 'events', sessionId)
}