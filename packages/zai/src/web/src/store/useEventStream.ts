import { useEffect } from 'react'
import { subscribeServerEvents } from '../lib/eventSource.js'
import { useAgentStore } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'
import type { ServerEvent } from '../../../shared/events.js'

export function useEventStream(): void {
  useEffect(() => {
    const handle = subscribeServerEvents(dispatch)
    return () => {
      handle.close()
    }
  }, [])
}

function dispatch(event: ServerEvent) {
  switch (event.type) {
    case 'runtime.started':
    case 'runtime.delta':
    case 'runtime.thinking':
    case 'runtime.tool_call':
    case 'runtime.tool_result':
    case 'runtime.done':
    case 'runtime.aborted':
    case 'runtime.error':
      useAgentStore.getState().applyRuntimeEvent(event)
      break
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
      useAgentStore.getState().applySessionEvent(event)
      break
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      useAppStore.getState().applyJobEvent(event)
      break
    case 'prompt.ask':
      useAgentStore.getState().applyPromptAsk(event)
      break
    case 'server.connected':
      useAppStore.getState().setConnected(true)
      break
    case 'server.error':
    case 'toast':
      useAppStore.getState().applySystemEvent(event)
      break
    case 'branch.changed':
      useAppStore.getState().applySystemEvent(event)
      break
  }
}
