import { getTranscriptStore, getCurrentSessionId, abortAgentSession } from '../../agentRuntime.js'
import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'

export const clearCommand: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: '清空当前对话',
  argumentHint: '',
  source: 'builtin',
  async call(_args, _context): Promise<LocalCommandResult> {
    const sessionId = getCurrentSessionId()
    if (sessionId) {
      await abortAgentSession('user_clear')
      await getTranscriptStore().remove(sessionId)
    }
    return { kind: 'cleared' }
  },
}
