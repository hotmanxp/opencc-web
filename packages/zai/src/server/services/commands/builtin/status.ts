import { getCurrentSessionId } from '../../agentRuntime.js'
import type { LocalCommand, LocalCommandResult, StatusPayload } from '@zn-ai/zai-agent-core'

export const statusCommand: LocalCommand = {
  type: 'local',
  name: 'status',
  description: '查看当前会话状态',
  argumentHint: '',
  source: 'builtin',
  async call(_args, context): Promise<LocalCommandResult> {
    const payload: StatusPayload = {
      sessionId: getCurrentSessionId(),
      cwd: context.cwd,
      cwdName: context.cwd.split('/').pop() || '/',
      branch: '', // branch 由前端 useAppStore.instanceContext.branch 提供,服务端不解析
      model: context.model ?? 'unknown',
      version: '0.1.0',
    }
    return { kind: 'status', payload }
  },
}
