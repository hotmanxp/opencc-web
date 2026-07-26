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

  // spec §5.4 coverage — branch coverage for the early abort shortcut
  // (get.ts L146): when signal.aborted is already true at entry, no IO
  // must run and the result must be [].
  test('returns empty array immediately when signal is already aborted', async () => {
    const c = controller()
    c.abort()
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: c.signal,
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
    expect(result[0].content).toMatch(/^<system-reminder>\n<bash-task/)
    expect(result[0].content).toContain('sleep 1')
    expect(result[0].content).toMatch(/<\/system-reminder>$/)
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
    expect(result[0].content).toMatch(/^<system-reminder>\n<background-agent/)
    expect(result[0].content).toContain('agent result')
    expect(result[0].content).toMatch(/<\/system-reminder>$/)
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

  // §4 case 7: bash attachment wraps content in <system-reminder>
  test('bash attachment wraps content in <system-reminder>', async () => {
    const tracker = makeBashTracker([
      makeBashTask('sess-1', 5000, 'failed', {
        exitCode: 2,
        stderr: 'boom',
      }),
    ])
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      bashTracker: tracker,
    })
    expect(result).toHaveLength(1)
    expect(result[0].content).toMatch(/^<system-reminder>/)
    expect(result[0].content).toContain('<bash-task taskId="bash-5000" status="failed" exitCode="2">')
    expect(result[0].content).toContain('[stderr]\nboom')
    expect(result[0].content).toMatch(/<\/system-reminder>$/)
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
    const skillAtt = result.find((a) => a.source === 'skill-prefetch')!
    expect(skillAtt.content).toMatch(/^<system-reminder>/)
    expect(skillAtt.content).toMatch(/The following skill is available: my-skill/)
    expect(skillAtt.content).toMatch(/\(source: disk\)/)
    expect(skillAtt.content).toContain('desc')
    expect(skillAtt.content).toMatch(/<\/system-reminder>$/)
    expect(skillAtt.content).not.toContain('<skill-prefetch')
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
    expect(result[0].content).toBe('<system-reminder>\nmemory payload for the agent\n</system-reminder>')
  })

  // spec §5.4 coverage — branch coverage for the try/catch around the
  // background-agent source (get.ts L150-159): when backgroundTaskStore.list
  // throws, getAttachmentMessages should swallow and return [].
  test('returns empty array when backgroundTaskStore.list throws', async () => {
    const brokenStore = {
      list: async () => {
        throw new Error('store exploded')
      },
    }
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      backgroundTaskStore: brokenStore,
    })
    expect(result).toEqual([])
  })

  // spec §5.4 coverage — branch coverage for the try/catch around the
  // skill-prefetch source (get.ts L161-165). collectSkills reads
  // pluginSnapshot.skills and currently cannot throw, but the guard still
  // covers malformed snapshot shapes (skills = undefined etc).
  test('returns empty array when pluginSnapshot.skills is malformed', async () => {
    const brokenSnapshot = { skills: undefined as unknown as LoadedSkill[] }
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      pluginSnapshot: brokenSnapshot,
    })
    expect(result).toEqual([])
  })

  // spec §5.4 coverage — branch coverage for the try/catch around the
  // memory-prefetch source (get.ts L167-172): when memoryCache.get throws,
  // getAttachmentMessages should swallow and return [].
  test('returns empty array when memoryCache.get throws', async () => {
    const brokenCache = {
      get: (_sessionId: string): string | null => {
        throw new Error('cache exploded')
      },
    }
    const result = await getAttachmentMessages({
      sessionId: 'sess-1',
      signal: signal(),
      memoryCache: brokenCache,
    })
    expect(result).toEqual([])
  })

  // spec §5.4 coverage — branch coverage for collectMemory (get.ts L248):
  // empty-string and null memoryCache.get() return values must NOT produce
  // an attachment. Covers the typeof/length guard branch.
  test('skips memory-prefetch attachment when memoryCache returns empty or null', async () => {
    const cache = {
      get: (sessionId: string): string | null => {
        if (sessionId === 'sess-empty') return ''
        if (sessionId === 'sess-null') return null
        return 'unused'
      },
    }
    const empty = await getAttachmentMessages({
      sessionId: 'sess-empty',
      signal: signal(),
      memoryCache: cache,
    })
    expect(empty).toEqual([])
    const nullRes = await getAttachmentMessages({
      sessionId: 'sess-null',
      signal: signal(),
      memoryCache: cache,
    })
    expect(nullRes).toEqual([])
  })
})
