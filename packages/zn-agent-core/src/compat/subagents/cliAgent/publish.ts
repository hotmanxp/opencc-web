/**
 * Publish a spawned CLI agent's run to the background-runtime task surface
 * (SSE timeline in the zai web UI).
 *
 * This is the "register/publish" half of the vendor spawn semantics, done
 * the lightweight way: reuse the existing `mirror*` helpers from
 * `compat/runtime/agentTaskBridge.ts` so the drawer sees attach → streaming
 * events → finalize with `task_id` as the single key. We deliberately do
 * NOT write AppState tasks / team files here — LocalAgentTask's lifecycle
 * assumes an in-process `runAgent` loop, while CLI children emit an event
 * stream that maps naturally onto `mirrorAppendBgEvent`. If AppState
 * registration is ever needed (teammate roster / TaskOutput), the fields
 * `spawnCliAgent` already returns (`agent_id`, `task_id`, `name`,
 * `team_name`, `model`) are all in place to build it.
 *
 * Mirrors `subagentProviderBridge.runSubagentProvider`'s pump loop, minus
 * the provider lookup — the caller hands in a settled spawn. Fire-and-forget,
 * same try/catch swallow style so a poisoned event never kills the run.
 */

import {
  mirrorAppendBgEvent,
  mirrorAttachTaskToBg,
  mirrorFinalizeBgTask,
} from '../../runtime/agentTaskBridge.js'
import type { CliAgentSpawn } from './spawn.js'

export interface PublishMeta {
  /** Parent session id for task attribution / notifier delivery. */
  parentSessionId?: string
}

/** Map provider event vocabulary to the bg-event keys the SSE drawer selects on. */
export function mapSubagentEventType(type: string): string {
  switch (type) {
    case 'agentMessage':
      return 'assistant_message'
    case 'toolCall':
      return 'tool_use'
    case 'toolResult':
      return 'tool_result'
    case 'commentary':
      return 'commentary'
    case 'turnStarted':
      return 'subagent_turn_started'
    case 'turnCompleted':
      return 'subagent_turn_completed'
    default:
      return type
  }
}

/**
 * Attach + stream + finalize the spawn's run under `task_id`. Resolves when
 * the terminal state is mirrored; never rejects.
 */
export async function publishSpawnToBackground(
  spawn: CliAgentSpawn,
  meta: PublishMeta = {},
): Promise<void> {
  const { task_id, run, prompt, description } = spawn
  await mirrorAttachTaskToBg({
    id: task_id,
    input: {
      prompt,
      cwd: undefined,
      agent: spawn.agent_type,
      model: spawn.model ?? undefined,
    },
    metadata: {
      parentSessionId: meta.parentSessionId,
      agentType: spawn.agent_type,
      description,
      invocationKind: 'spawn',
    },
  })

  void pumpEvents(run, task_id)

  let result
  try {
    result = await run.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await mirrorFinalizeBgTask(task_id, 'failed', {
      message,
      category: 'subagent_provider_error',
    })
    return
  }

  const finalizeStatus: 'completed' | 'failed' | 'cancelled' =
    result.stopReason === 'completed'
      ? 'completed'
      : result.stopReason === 'aborted'
        ? 'cancelled'
        : 'failed'
  await mirrorFinalizeBgTask(
    task_id,
    finalizeStatus,
    result.errorMessage
      ? { message: result.errorMessage, category: 'subagent_provider_error' }
      : undefined,
  )
}

async function pumpEvents(
  run: CliAgentSpawn['run'],
  taskId: string,
): Promise<void> {
  try {
    for await (const event of run.events) {
      await mirrorAppendBgEvent(taskId, {
        type: mapSubagentEventType(event.type),
        text: event.text,
        phase: event.phase,
        raw: event.raw,
      })
    }
  } catch {
    // Event-pump failure is non-fatal — the tool result still resolves via
    // `run.result` (same tolerance as subagentProviderBridge).
  }
}