/**
 * Integration tests — D.1 mid-turn attachment messages (getAttachmentMessages).
 *
 * Covers spec §3 behaviors 1-5 + §4 the 7 cases listed for d-attachment-messages.
 * TDD: tests first, then implementation in get.ts makes them green.
 *
 * Duck-typed sources (spec §3 行为 9-11):
 *   - bashTracker.list({sessionId, limit?})
 *   - backgroundTaskStore.list({status?, limit?})
 *   - pluginSnapshot.skills
 */
import { describe, test, expect } from 'vitest'
import { getAttachmentMessages } from '../../../../src/runtime/attachment/get.js'
import type {
  BashTaskInfo,
  BashTaskStatus,
} from '../../../../src/tools/BashTool/bashTracker.js'
import type { BackgroundTask } from '../../../../src/runtime/background/types.js'
import type { LoadedSkill } from '../../../../src/runtime/skills/types.js'
import type { AnthropicMessage } from '../../../../src/transcript/types.js'

// ---- test fixtures ---------------------------------------------------------

function makeBashTask(
  sessionId: string,
  finishedAt: number,
  status: BashTaskStatus = 'completed',
  overrides: Partial<BashTaskInfo> = {},
): BashTaskInfo {
  return {
    taskId: `bash-${finishedAt}`,
    sessionId,
    command: 'sleep 1',
    description: 'sleep',
    startedAt: finishedAt - 100,
    finishedAt,
    status,
    stdout: 'hello from bash',
    stderr: '',
    isBackgrounded: true,
    notified: false,
    ...overrides,
  }
}

function makeBackgroundTask(
  parentSessionId: string,
  finishedAt: number,
  status: BackgroundTask['status'] = 'completed',
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask {
  return {
    id: `bg-${finishedAt}`,
    status,
    input: { prompt: 'do a thing' },
    createdAt: finishedAt - 200,
    startedAt: finishedAt - 150,
    finishedAt,
    resultText: 'agent result',
    eventCount: 3,
    parentSessionId,
    ...overrides,
  }
}

function makeBashTracker(tasks: BashTaskInfo[]) {
  return {
    list: (filter?: { sessionId?: string; limit?: number }) => {
      const filtered = filter?.sessionId
        ? tasks.filter((t) => t.sessionId === filter.sessionId)
        : tasks
      return filtered.slice(0, filter?.limit ?? 200)
    },
  }
}

function makeTaskStore(tasks: BackgroundTask[]) {
  return {
    list: async (filter?: { status?: BackgroundTask['status']; limit?: number }) => {
      const filtered = filter?.status
        ? tasks.filter((t) => t.status === filter.status)
        : tasks
      const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt)
      return sorted.slice(0, filter?.limit ?? 200)
    },
  }
}

function makePluginSnapshot(skills: LoadedSkill[] = []) {
  return { skills }
}

const controller = () => new AbortController()
const signal = (c = controller()) => c.signal

// ---- tests -----------------------------------------------------------------

describe('integration: getAttachmentMessages (mid-turn attachment)', () => {
  // §3 行为 1 + §4 case 1: empty array when nothing
  test('returns empty array when no background tasks, agents, or skill prefetches exist', async () => {
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
    })
    expect(result).toEqual([])
  })

  // §3 行为 2 + §4 case 2: bash attachments from BashTracker
  test('returns background-bash attachment from BashTracker', async () => {
    const tracker = makeBashTracker([makeBashTask('sess-1', 1000)])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
    })
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('background-bash')
    expect(result[0].consumedAt).toBe(1000)
    expect(result[0].payload.role).toBe('assistant')
    // assistant message content is a string with bash command + output summary
    const text = Array.isArray(result[0].payload.content)
      ? (result[0].payload.content[0] as { text: string }).text
      : result[0].payload.content
    expect(text).toContain('sleep 1')
  })

  // §3 行为 2 + §4 case 3: agent attachments from BackgroundRuntime task store
  test('returns background-agent attachment from BackgroundRuntime task store', async () => {
    const store = makeTaskStore([makeBackgroundTask('sess-1', 2000)])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      backgroundTaskStore: store,
    })
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('background-agent')
    expect(result[0].consumedAt).toBe(2000)
    expect(result[0].payload.role).toBe('assistant')
  })

  // §3 行为 5 + §4 case 4: sort by consumedAt asc across sources
  test('sorts attachments by consumedAt ascending', async () => {
    const tracker = makeBashTracker([makeBashTask('sess-1', 3000)])
    const store = makeTaskStore([makeBackgroundTask('sess-1', 1000)])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
      backgroundTaskStore: store,
    })
    expect(result.map((a) => a.consumedAt)).toEqual([1000, 3000])
    expect(result[0].source).toBe('background-agent')
    expect(result[1].source).toBe('background-bash')
  })

  // §3 行为 4 + §4 case 5: fromTimestamp filter
  test('filters by fromTimestamp (excluding items before)', async () => {
    const tracker = makeBashTracker([
      makeBashTask('sess-1', 1000),
      makeBashTask('sess-1', 2000),
      makeBashTask('sess-1', 3000),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      fromTimestamp: 2000,
      signal: signal(),
      bashTracker: tracker,
    })
    expect(result.map((a) => a.consumedAt)).toEqual([2000, 3000])
  })

  // §2.4 错误契约 + §4 case 6: never throws, returns [] on error
  test('on error returns empty array (does not throw)', async () => {
    const brokenTracker = {
      list: () => {
        throw new Error('tracker exploded')
      },
    }
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: brokenTracker,
    })
    expect(result).toEqual([])
  })

  // §4 case 7: AnthropicMessage shape for assistant form
  test('properly populates AnthropicMessage shape for assistant message form', async () => {
    const tracker = makeBashTracker([
      makeBashTask('sess-1', 5000, 'failed', {
        exitCode: 2,
        stderr: 'boom',
      }),
    ])
    const [att] = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
    })
    const payload: AnthropicMessage = att.payload
    expect(payload.role).toBe('assistant')
    // content is string or [{type:'text', text:string}]
    if (typeof payload.content === 'string') {
      expect(payload.content.length).toBeGreaterThan(0)
    } else {
      expect(payload.content[0].type).toBe('text')
      expect((payload.content[0] as { text: string }).text.length).toBeGreaterThan(0)
    }
  })

  // bonus: filters out non-terminal bash tasks (running) — terminal-only spec
  test('excludes running bash tasks (terminal only)', async () => {
    const tracker = makeBashTracker([
      makeBashTask('sess-1', 1000, 'running', { finishedAt: undefined }),
      makeBashTask('sess-1', 2000, 'completed'),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
    })
    expect(result.map((a) => a.consumedAt)).toEqual([2000])
  })

  // bonus: filters by sessionId on bash tracker
  test('filters bash tasks by sessionId', async () => {
    const tracker = makeBashTracker([
      makeBashTask('sess-OTHER', 1000),
      makeBashTask('sess-1', 2000),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
    })
    expect(result).toHaveLength(1)
    expect(result[0].consumedAt).toBe(2000)
  })

  // bonus: filters agent tasks by parentSessionId
  test('filters background tasks by parentSessionId', async () => {
    const store = makeTaskStore([
      makeBackgroundTask('sess-OTHER', 1000),
      makeBackgroundTask('sess-1', 2000),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      backgroundTaskStore: store,
    })
    expect(result).toHaveLength(1)
    expect(result[0].consumedAt).toBe(2000)
  })

  // bonus: skill-prefetch source emits an attachment per loaded skill (only if
  // caller passes a plugin snapshot — otherwise source has nothing to read).
  test('emits skill-prefetch attachments when pluginSnapshot.skills provided', async () => {
    const snapshot = makePluginSnapshot([
      {
        name: 'my-skill',
        source: 'disk',
        frontmatter: { description: 'desc' },
      },
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      pluginSnapshot: snapshot,
    })
    expect(result.some((a) => a.source === 'skill-prefetch')).toBe(true)
  })

  // bonus: only completed/failed agent tasks (terminal) qualify
  test('excludes running/queued background agent tasks (terminal only)', async () => {
    const store = makeTaskStore([
      makeBackgroundTask('sess-1', 0, 'running'),
      makeBackgroundTask('sess-1', 1000, 'completed'),
      makeBackgroundTask('sess-1', 2000, 'failed'),
      makeBackgroundTask('sess-1', 3000, 'cancelled'),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      backgroundTaskStore: store,
    })
    expect(result.map((a) => a.consumedAt).sort((x, y) => x - y)).toEqual([1000, 2000, 3000])
  })

  // bonus: memory-prefetch source emits attachment when memoryCache.get() returns content
  test('emits memory-prefetch attachment when memoryCache provides content', async () => {
    const cache = {
      get: (sessionId: string): string | null =>
        sessionId === 'sess-1' ? 'memory payload for the agent' : null,
    }
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      memoryCache: cache,
    })
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('memory-prefetch')
    const text = Array.isArray(result[0].payload.content)
      ? (result[0].payload.content[0] as { text: string }).text
      : result[0].payload.content
    expect(text).toContain('memory payload for the agent')
  })
})