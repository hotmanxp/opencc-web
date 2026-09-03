import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolTask, deleteTasks, getTasksSnapshot, computeFingerprint,
  invalidateTasksSnapshot, TASK_YAML_FILENAME, LEGACY_INDEX_MD_FILENAME,
} from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-snap-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
})
afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
})
beforeEach(() => {
  invalidateTasksSnapshot()
})

describe('getTasksSnapshot 快照缓存', () => {
  it('未改动 → 指纹一致,复用缓存 buckets 对象引用', async () => {
    await createPoolTask({ title: 'snap-stable' })
    const s1 = await getTasksSnapshot()
    const s2 = await getTasksSnapshot()
    expect(s2.fingerprint).toBe(s1.fingerprint)
    expect(s2).toBe(s1) // 单槽缓存直接返回同一对象
    expect(s2.buckets).toBe(s1.buckets)
    expect(s2.buckets.queue.length).toBeGreaterThan(0)
  })

  it('新增任务 → 指纹变化,buckets 重算', async () => {
    const s1 = await getTasksSnapshot()
    const before = s1.buckets.queue.length
    await createPoolTask({ title: 'snap-add' })
    const s2 = await getTasksSnapshot()
    expect(s2.fingerprint).not.toBe(s1.fingerprint)
    expect(s2.buckets.queue.length).toBe(before + 1)
  })

  it('删除任务 → 指纹变化', async () => {
    const s = await createPoolTask({ title: 'snap-del' })
    const s1 = await getTasksSnapshot()
    await deleteTasks([s.id])
    const s2 = await getTasksSnapshot()
    expect(s2.fingerprint).not.toBe(s1.fingerprint)
    expect(s2.buckets.queue.find((t) => t.id === s.id)).toBeUndefined()
  })

  it('task.yaml 内容变化 → 指纹变化', async () => {
    const s = await createPoolTask({ title: 'snap-yaml' })
    const s1 = await getTasksSnapshot()
    // 追加注释改变 size(避免同毫秒同字节的已知漏检)
    await appendFile(join(dir, 'queue-tasks', s.id, TASK_YAML_FILENAME), '\n# touched\n')
    const s2 = await getTasksSnapshot()
    expect(s2.fingerprint).not.toBe(s1.fingerprint)
  })

  it('仅改 md 文件内容也触发指纹变化(spec/plan/process/verification)', async () => {
    const s = await createPoolTask({ title: 'snap-md' })
    await getTasksSnapshot() // 建立基线缓存
    for (const rel of ['docs/spec.md', 'docs/plan.md', 'process.md', 'docs/verification.md']) {
      const base = (await getTasksSnapshot()).fingerprint
      const p = join(dir, 'queue-tasks', s.id, rel)
      // verification.md 由 verifier 首次写入,创建前不存在 → 首次写入同样要触发指纹变化
      await appendFile(p, 'x').catch(() => writeFile(p, '# verification\n'))
      const next = (await getTasksSnapshot()).fingerprint
      expect(next, rel).not.toBe(base)
    }
  })

  it('invalidateTasksSnapshot → 同指纹也强制重算新对象', async () => {
    await createPoolTask({ title: 'snap-inval' })
    const s1 = await getTasksSnapshot()
    invalidateTasksSnapshot()
    const s2 = await getTasksSnapshot()
    expect(s2.fingerprint).toBe(s1.fingerprint)
    expect(s2.buckets).not.toBe(s1.buckets) // 缓存已清空 → 重新全量组装
    expect(s2.buckets).toEqual(s1.buckets)
  })

  it('目录不存在/为空 → 稳定空指纹 + 空桶', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'tf-snap-empty-'))
    process.env.ZAI_TASK_FACTORY_DIR = emptyRoot
    try {
      invalidateTasksSnapshot()
      const f1 = await computeFingerprint()
      const f2 = await computeFingerprint()
      expect(f2).toBe(f1) // 空集合指纹稳定
      const s = await getTasksSnapshot()
      expect(s.fingerprint).toBe(f1)
      expect(s.buckets).toEqual({ queue: [], processing: [], verifying: [], finished: [] })
    } finally {
      process.env.ZAI_TASK_FACTORY_DIR = dir
      await rm(emptyRoot, { recursive: true, force: true })
    }
  })
})

describe('computeFingerprint legacy index.md 兼容', () => {
  it('legacy index.md 参与指纹(新增/改写均改变指纹)', async () => {
    const legacyId = 'tf-legacy01'
    const legacyDir = join(dir, 'queue-tasks', legacyId)
    const legacyMd = join(legacyDir, LEGACY_INDEX_MD_FILENAME)
    const base = await computeFingerprint()
    await mkdir(legacyDir, { recursive: true })
    await writeFile(legacyMd, '---\ntitle: legacy task\nstatus: queued\n---\n\n# legacy task\n\n描述段落\n')
    const withLegacy = await computeFingerprint()
    expect(withLegacy).not.toBe(base) // 任务 id + index.md 元组参与指纹
    // 改写 index.md 内容(size 变化)→ 指纹变化
    await appendFile(legacyMd, '追加一行\n')
    expect(await computeFingerprint()).not.toBe(withLegacy)
    // 删除整个任务目录 → 指纹回到新增前的状态(不比较 mtimeMs 浮点序列化,
    // 因为其余任务可能被读路径迁移过 task.yaml,mtime 已变而 size 相同)
    await rm(legacyDir, { recursive: true, force: true })
    const afterDelete = await computeFingerprint()
    await mkdir(legacyDir, { recursive: true })
    await writeFile(legacyMd, '---\ntitle: legacy task\nstatus: queued\n---\n\n# legacy task\n\n描述段落\n')
    await rm(legacyDir, { recursive: true, force: true })
    expect(await computeFingerprint()).toBe(afterDelete)
  })

  it('task.yaml 与 index.md 同时存在时以 task.yaml 计,index.md 改写不影响指纹', async () => {
    const s = await createPoolTask({ title: 'both-meta' })
    const legacyPath = join(dir, 'queue-tasks', s.id, LEGACY_INDEX_MD_FILENAME)
    await writeFile(legacyPath, '---\ntitle: stale\n---\n')
    const f1 = await computeFingerprint()
    await appendFile(legacyPath, 'more\n')
    expect(await computeFingerprint()).toBe(f1) // legacy 已被 task.yaml 遮蔽,不参与
    await rm(legacyPath)
  })
})
