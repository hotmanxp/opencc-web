import type { AskUserAnswers } from '@zn-ai/zai-agent-core'

type Pending = {
  resolve: (a: AskUserAnswers) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
}

export class AskRegistry {
  private pending = new Map<string, Pending>()

  register(toolUseId: string, sessionId: string, abortSignal: AbortSignal): Promise<AskUserAnswers> {
    return new Promise<AskUserAnswers>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(toolUseId)) {
          reject(new Error('aborted'))
        }
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolUseId, {
        resolve: (a) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(a)
        },
        reject: (e) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(e)
        },
        toolUseId,
        sessionId,
      })
    })
  }

  // 只读 peek, 不 consume. 给 answer/reject handler 在执行实际 resolve/reject
  // 之前校验 pendingAsk 的 sessionId, 防御跨 sid 串号. 没找到 → undefined.
  peek(toolUseId: string): Pending | undefined {
    return this.pending.get(toolUseId)
  }

  answer(toolUseId: string, payload: AskUserAnswers): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.resolve(payload)
    return true
  }

  reject(toolUseId: string, reason = 'user_rejected'): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.reject(new Error(reason))
    return true
  }

  abortAll(reason = 'session_aborted'): void {
    for (const p of this.pending.values()) {
      this.pending.delete(p.toolUseId)
      p.reject(new Error(reason))
    }
  }
}
