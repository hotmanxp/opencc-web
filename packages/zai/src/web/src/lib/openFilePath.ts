/**
 * 「点开一个文件路径」的统一入口 —— 供 Markdown chip 等调用。
 *
 * 预览落地在两处,不能只写 store:
 *   - /agent、/m: store.filePreviewPath → FilePreviewDrawer(挂在页面根)
 *   - /desktop:   预览窗口是 Desktop 页面内的局部 state,挂不上 store
 * 所以先派一个 window 事件让 Desktop 认领(认领时把 detail.handled 置 true),
 * 没人认领再回落 store。同 AGENT_INPUT_INSERT_EVENT 的既有先例(见 agentInputEvents.ts)。
 *
 * 路径解析由服务端 /fs/resolve 完成:
 *   1) 绝对路径直接 stat
 *   2) 相对路径先 join(session initCwd) → 命中即返回
 *   3) 还没命中 → join(实例 cwd) → 命中即返回
 *   4) 兜底:在实例 cwd 范围内按 basename 模糊搜 + 路径末段精确匹配
 *      命中 0 条 → 文件不存在;1 条 → 直接打开;多条 → 弹候选列表
 */
import type { FsResolveCandidate, FsResolveResult } from '../../../shared/fs.js'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'

export const FILE_PREVIEW_OPEN_EVENT = 'zai:file-preview-open'

export interface FilePreviewOpenDetail {
  /** 绝对路径(由 /fs/resolve 解析后填入)。 */
  path: string
  /** 监听方置 true 表示已自行打开,调用方不再回落 store。 */
  handled?: boolean
}

export type { FsResolveCandidate, FsResolveResult as ResolveResult }

/**
 * 当前会话的 initCwd —— 来自 SessionInfo.cwd(会话创建时确定,与 cwd.changed
 * 随 bash cd 变化的 cwdBySession 区分)。没有 sessionId / session 还没载入
 * / cwdBySession 还没收过 SSE 时,统一回落到实例 cwd。
 */
export function currentSessionCwd(): string | undefined {
  const { sessionId, sessions, cwdBySession } = useAgentStore.getState()
  if (sessionId) {
    const fromSession = sessions.find((s) => s.sessionId === sessionId)?.cwd
    if (fromSession) return fromSession
    if (cwdBySession[sessionId]) return cwdBySession[sessionId]
  }
  return useAppStore.getState().instanceContext?.cwd || undefined
}

/**
 * POST /api/fs/resolve:服务器端按"绝对 → sessionCwd → 实例 cwd → 实例 cwd 内搜索"逐级解析。
 *
 * 注意前缀必须是 /api —— fsRouter 在 server 挂载于 app.use('/api'),vite dev
 * proxy 也只转发 /api;早期写 /fs/resolve 请求根本到不了服务端,vite 返回
 * 404(res.json() 抛异常),chip 点击表现为"点了没反应"。
 * 网络/HTTP 失败不抛异常,统一折成 ok:false 结构,让调用方 message.error。
 */
export async function resolveFilePath(rawPath: string): Promise<FsResolveResult> {
  const body: { path: string; sessionCwd?: string } = { path: rawPath }
  const sc = currentSessionCwd()
  if (sc) body.sessionCwd = sc
  let res: Response
  try {
    res = await fetch('/api/fs/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return {
      ok: false,
      code: 'EIO',
      error: `路径解析请求失败:${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!res.ok) {
    return { ok: false, code: 'EIO', error: `路径解析失败(HTTP ${res.status})` }
  }
  try {
    return (await res.json()) as FsResolveResult
  } catch {
    return { ok: false, code: 'EIO', error: '路径解析响应不是合法 JSON' }
  }
}

/**
 * 打开文件预览:
 *   - exact     → 派 FILE_PREVIEW_OPEN_EVENT(给 Desktop),未认领则写 store(给 FilePreviewDrawer)
 *   - multiple  → 把 candidates 返给调用方,UI 弹选择器
 *   - !ok       → 返错误文案,调用方 message.error
 *
 * 返回结构化结果让调用方能区分多匹配场景。
 */
export async function openFilePathPreview(rawPath: string): Promise<FsResolveResult> {
  const result = await resolveFilePath(rawPath)
  if (result.ok === 'exact') {
    const detail: FilePreviewOpenDetail = { path: result.abs }
    window.dispatchEvent(new CustomEvent<FilePreviewOpenDetail>(FILE_PREVIEW_OPEN_EVENT, { detail }))
    if (!detail.handled) useAgentStore.getState().openFilePreview(result.abs)
  }
  return result
}

/**
 * 走 /fs/resolve 解析后调用 /fs/{reveal|open-terminal}。
 * 多匹配场景不静默选第一个 —— 让用户先点 chip 选过(返回 exact)再用菜单。
 */
export async function callFsCommand(
  cmd: 'reveal' | 'open-terminal',
  rawPath: string,
): Promise<{ ok: true; abs: string } | { ok: false; error: string }> {
  const result = await resolveFilePath(rawPath)
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  if (result.ok === 'multiple') {
    return { ok: false, error: '存在多个匹配,请先点击预览选择' }
  }
  const abs = result.abs
  try {
    const res = await fetch(`/api/fs/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: abs }),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    return { ok: true, abs }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
