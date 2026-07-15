import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'

/**
 * MVP: returns an explicit 'not yet wired' error.
 * Future spec wires this to the existing services/compact pipeline
 * (or implements compact inside this module). See spec §2.6 / §9.
 */
export const compactCommand: LocalCommand = {
  type: 'local',
  name: 'compact',
  description: '手动压缩当前对话',
  argumentHint: '[--force]',
  source: 'builtin',
  async call(_args, _context): Promise<LocalCommandResult> {
    return { kind: 'error', message: '/compact 暂未实现' }
  },
}
