import { getTranscriptStore, getCurrentSessionId, abortAgentSession } from '../../agentRuntime.js'
import { clearMemoryCache } from '@zn-ai/zai-agent-core'
import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'

export const clearCommand: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: '清空当前对话',
  argumentHint: '',
  source: 'builtin',
  async call(_args, context): Promise<LocalCommandResult> {
    // 优先用 context.sessionId(由 /agent/command 路由透传),其次回退到 server
    // 进程内 last-known sid。两条路径覆盖:① slash 选单走 /agent/command
    // (body 携带 sid);② 输入框按 enter 走同路由,均通过 context.sessionId
    // 传入,这里不再依赖 getCurrentSessionId() 在多 tab 下可能错指别 session。
    const sessionId =
      (context && typeof context.sessionId === 'string' && context.sessionId) ||
      getCurrentSessionId()
    if (sessionId) {
      await abortAgentSession('user_clear')
      const store = getTranscriptStore()
      try {
        // 保留 transcript 文件,只清空 messages。这是关键修复:
        // 旧实现 store.remove(sessionId) 会把 transcript JSON 文件物理删除,
        // 而前端 store 还持有这个 sid → 下一次 POST /agent/prompt 携带同 sid
        // → server `read()` ENOENT → agent.ts:374 返 404 'Session not found'。
        // 改成 store.replace(sessionId, []) 后,文件保留,messages 清零,sid
        // 持续可续传,与 /compact 路径(同样保留文件只改 messages)语义一致,
        // 与前端 '清屏但保留 session' 的用户心智模型一致。
        await store.replace(sessionId, [])
      } catch {
        // 文件不存在/损坏 — 静默兜底。clear 的本意是"清屏",文件没了也无所谓,
        // 用户下一条消息能正常发出去(进入"无 transcript"新建分支)。
      }
    }
    clearMemoryCache()
    return { kind: 'cleared' }
  },
}
