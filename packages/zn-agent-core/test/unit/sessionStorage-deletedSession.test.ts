/**
 * 已删会话的 append 守卫 —— vendor 真实写盘链路
 * (bug `delete-session-resurrects--by-zai`)。
 *
 * 为什么守卫不能只护 compat 侧:legacyTranscriptStore.appendEntry 只是**旁路**
 * (slash 指令可见行、session-meta 等 zai 自己补的条目)。真正把内容写进
 * transcript 的有两条 vendor 链路,都做 `mkdir(dirname) + appendFile`,文件没了
 * 会**重新创建**:
 *   1. sessionStorage.appendEntry → appendDirectlyToFile (turn 主链路)
 *   2. sessionFacade-impl.append / patchSession → appendEntryAsync (服务端路径)
 *
 * 注意:测试全部走 `@zn-ai/zn-agent-core`(**构建产物**)。守卫模块在 bundle 里
 * 只有一个实例 —— 若从 `src/` 直接 import `markSessionDeleted`,会和 bundle 里的
 * 副本分属两个 Set,arm 不到守卫,测试必然假红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionFacade, TranscriptStore } from '@zn-ai/zn-agent-core'

let dataDir: string
let cwd: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'deleted-session-facade-'))
  cwd = mkdtempSync(join(tmpdir(), 'deleted-session-cwd-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function transcriptExists(sid: string): boolean {
  const projects = join(dataDir, 'projects')
  if (!existsSync(projects)) return false
  return readdirSync(projects).some((proj) => existsSync(join(projects, proj, `${sid}.jsonl`)))
}

describe('sessionFacade — 已删会话守卫', () => {
  it('removeSession 之后的 append 不会把 transcript 写回来', async () => {
    // 这就是缺陷本身:在跑的 turn 在 DELETE 之后继续 append。facade 的
    // appendEntryAsync 走 ENOENT → mkdir 分支,会把刚删的文件重建出来。
    const facade = await createSessionFacade({ dataDir, cwd })
    const sid = 'sess-resurrect-facade'

    await facade.append(sid, { type: 'user', uuid: 'u1', message: { role: 'user', content: 'before' } } as never)
    expect(transcriptExists(sid)).toBe(true)

    await facade.removeSession(sid)
    expect(transcriptExists(sid)).toBe(false)

    // 迟到的 append —— 修之前这里会把文件重建出来
    await facade.append(sid, { type: 'user', uuid: 'u2', message: { role: 'user', content: 'late' } } as never)
    expect(transcriptExists(sid)).toBe(false)
  })

  it('removeSession 之后的 patchSession 同样不写盘', async () => {
    const facade = await createSessionFacade({ dataDir, cwd })
    const sid = 'sess-resurrect-patch'

    await facade.append(sid, { type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } } as never)
    await facade.removeSession(sid)
    await facade.patchSession(sid, { type: 'custom-title', customTitle: 'late rename' } as never)

    expect(transcriptExists(sid)).toBe(false)
  })

  it('未删除的 session 照常 append(守卫不误伤)', async () => {
    const facade = await createSessionFacade({ dataDir, cwd })
    const sid = 'sess-alive-facade'

    await facade.append(sid, { type: 'user', uuid: 'u2', message: { role: 'user', content: 'alive' } } as never)

    expect(transcriptExists(sid)).toBe(true)
  })

  it('删 A 不影响 B —— 守卫按 sid 生效', async () => {
    const facade = await createSessionFacade({ dataDir, cwd })
    const a = 'sess-del-a'
    const b = 'sess-alive-b'

    await facade.append(a, { type: 'user', uuid: 'ua', message: { role: 'user', content: 'x' } } as never)
    await facade.append(b, { type: 'user', uuid: 'ub', message: { role: 'user', content: 'y' } } as never)
    await facade.removeSession(a)
    await facade.append(a, { type: 'user', uuid: 'ua2', message: { role: 'user', content: 'late a' } } as never)

    expect(transcriptExists(a)).toBe(false)
    expect(transcriptExists(b)).toBe(true)
  })

  it('compat 侧 TranscriptStore.remove 之后 appendMessageEntry 也不写回', async () => {
    // 另一条链:zai 自己补的条目(slash 可见行 / session-meta)走 compat。
    const store = new TranscriptStore(dataDir)
    const sid = 'sess-compat-guard'
    await store.create({ cwd, model: 'm' }, { cwd })
    await store.appendMessageEntry(sid, { type: 'user', text: 'before' }, { cwd })
    expect(transcriptExists(sid)).toBe(true)

    await store.remove(sid, { cwd })
    expect(transcriptExists(sid)).toBe(false)

    await store.appendMessageEntry(sid, { type: 'assistant', text: 'late' }, { cwd })
    expect(transcriptExists(sid)).toBe(false)
  })
})
