// packages/zai-agent-core/test/tools/Tasks/TaskListStore.test.ts
//
// 主要覆盖 TaskListStore.update 的 auto-cleanup 路径: 当 LLM 调
// TaskUpdate 把一条任务推到终态 (completed / deleted) 时,如果该
// session 内已经"全部任务都已终态",应删除该 session 的任务文件。

import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { access, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  TaskListStore,
  type TaskStatus,
} from '../../../src/tools/Tasks/TaskListStore.js'

let tmpDir: string
let store: TaskListStore
const SESSION = 'sess-cleanup-001'

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-tasklist-test-'))
  store = new TaskListStore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** 文件是否存在 (ENOENT → false)。 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('TaskListStore — auto-cleanup on all-terminal', () => {
  test('所有任务都 completed 后, session 任务文件被删除', async () => {
    const t1 = await store.create(SESSION, { subject: 't1' })
    const t2 = await store.create(SESSION, { subject: 't2' })

    // 把 t1 推到终态 — 还有 t2 pending → 文件应保留
    await store.update(SESSION, t1.id, { status: 'completed' as TaskStatus })
    expect(await store.list(SESSION)).toHaveLength(2)

    // 把 t2 也推到终态 → 整 session 文件应被清掉
    await store.update(SESSION, t2.id, { status: 'completed' as TaskStatus })

    const tasks = await store.list(SESSION)
    expect(tasks).toEqual([])
  })

  test('completed + deleted 混合也算"全部完成"', async () => {
    const t1 = await store.create(SESSION, { subject: 'keep' })
    const t2 = await store.create(SESSION, { subject: 'drop' })

    await store.update(SESSION, t1.id, { status: 'completed' as TaskStatus })
    await store.update(SESSION, t2.id, { status: 'deleted' as TaskStatus })

    expect(await store.list(SESSION)).toEqual([])
  })

  test('仍存在 pending 任务时, 不清理', async () => {
    const t1 = await store.create(SESSION, { subject: 'a' })
    const t2 = await store.create(SESSION, { subject: 'b' })
    const t3 = await store.create(SESSION, { subject: 'c' })

    // t1 + t2 完成,但 t3 还 pending → 不应清
    await store.update(SESSION, t1.id, { status: 'completed' as TaskStatus })
    await store.update(SESSION, t2.id, { status: 'completed' as TaskStatus })

    const remaining = await store.list(SESSION)
    expect(remaining.map((t) => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort())
    // t3 还在 pending
    expect(remaining.find((t) => t.id === t3.id)?.status).toBe('pending')
  })

  test('非终态 patch (例如只改 subject) 不触发清理', async () => {
    const t = await store.create(SESSION, { subject: 'orig' })

    await store.update(SESSION, t.id, { subject: 'renamed' })

    // 文件仍存在,任务仍可列出
    const list = await store.list(SESSION)
    expect(list).toHaveLength(1)
    expect(list[0]?.subject).toBe('renamed')
  })

  test('in_progress → completed 触发清理, 而 completed → in_progress 不触发', async () => {
    const t1 = await store.create(SESSION, { subject: 'only' })

    // 先标 in_progress
    await store.update(SESSION, t1.id, { status: 'in_progress' as TaskStatus })
    expect(await store.list(SESSION)).toHaveLength(1)

    // in_progress → completed: map 里只有它一个,且已终态 → 应清
    await store.update(SESSION, t1.id, { status: 'completed' as TaskStatus })
    expect(await store.list(SESSION)).toEqual([])
  })

  test('跨 session 清理互不影响', async () => {
    const sessA = 'sess-A'
    const sessB = 'sess-B'

    const a1 = await store.create(sessA, { subject: 'a1' })
    await store.create(sessA, { subject: 'a2' })
    const b1 = await store.create(sessB, { subject: 'b1' })
    const b2 = await store.create(sessB, { subject: 'b2' })

    // 收尾 sessA
    await store.update(sessA, a1.id, { status: 'completed' as TaskStatus })
    const a2 = (await store.list(sessA)).find((t) => t.subject === 'a2')!
    await store.update(sessA, a2.id, { status: 'completed' as TaskStatus })

    // sessA 应清掉,sessB 应保留
    expect(await store.list(sessA)).toEqual([])
    const bRemaining = await store.list(sessB)
    expect(bRemaining.map((t) => t.id).sort()).toEqual([b1.id, b2.id].sort())
  })

  test('deleteSession 后仍能正常 create 任务 (新会话复用根目录无副作用)', async () => {
    const t = await store.create(SESSION, { subject: 'first' })
    await store.update(SESSION, t.id, { status: 'completed' as TaskStatus })

    // 应清掉
    expect(await store.list(SESSION)).toEqual([])

    // 同一 session 再 create — 因为文件被删,loadSession 返回空 map,新任务可正常写入
    const t2 = await store.create(SESSION, { subject: 'second' })
    expect(t2.id).toBeTruthy()
    expect(t2.status).toBe('pending')

    const list = await store.list(SESSION)
    expect(list).toHaveLength(1)
    expect(list[0]?.subject).toBe('second')
  })
})
