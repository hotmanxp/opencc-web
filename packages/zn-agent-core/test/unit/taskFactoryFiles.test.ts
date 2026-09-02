import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolTask, listTasks, moveTask, markTaskStatus,
  deleteTasks, getTaskDetails, getTaskSummary, taskFactoryRoot, emitTaskFactoryEvent,
  TASK_YAML_FILENAME, LEGACY_INDEX_MD_FILENAME,
} from '../../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tf-test-')) , process.env.ZAI_TASK_FACTORY_DIR = dir })
afterAll(async () => { delete process.env.ZAI_TASK_FACTORY_DIR; await rm(dir, { recursive: true, force: true }) })

describe('taskFactoryFiles (task.yaml 2026-09-02)', () => {
  it('createPoolTask 初始化 task.yaml + docs/ + process.md，落到 queue-tasks', async () => {
    const s = await createPoolTask({ title: '打印 CSV 报表', agent: 'default' })
    expect(s.id.startsWith('tf-')).toBe(true)
    expect(s.bucket).toBe('queue-tasks')
    const yaml = await readFile(join(dir, 'queue-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml).toContain('status: queued')
    expect(yaml).toContain('title: 打印 CSV 报表')
    expect(yaml).toContain('agent: default')
    const docs = await readdir(join(dir, 'queue-tasks', s.id, 'docs'))
    expect(docs.sort()).toEqual(['plan.md', 'spec.md'])
    await expect(readFile(join(dir, 'queue-tasks', s.id, 'process.md'), 'utf-8')).resolves.toContain('# 执行记录')
    // 不再写 index.md
    expect(existsSync(join(dir, 'queue-tasks', s.id, LEGACY_INDEX_MD_FILENAME))).toBe(false)
  })

  it('moveTask 移目录并更新 task.yaml status=processing', async () => {
    const s = await createPoolTask({ title: 't' })
    const moved = await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    expect(moved.status).toBe('processing')
    await expect(readdir(join(dir, 'processing-tasks', s.id))).resolves.not.toThrow()
    const yaml = await readFile(join(dir, 'processing-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml).toContain('status: processing')
  })

  it('markTaskStatus 回填 executorTaskId 与 startedAt', async () => {
    const s = await createPoolTask({ title: 't' })
    const m = await markTaskStatus(s.id, 'queue-tasks', {
      status: 'processing', startedAt: '2026-09-01T00:00:00.000Z', executorTaskId: 'a1234567',
    })
    expect(m.executorTaskId).toBe('a1234567')
    const yaml = await readFile(join(dir, 'queue-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml).toContain('executorTaskId: a1234567')
    expect(yaml).toContain('startedAt: 2026-09-01T00:00:00.000Z')
  })

  it('deleteTasks 只允许 queue/finished，拒绝 processing（含 paused）', async () => {
    const s = await createPoolTask({ title: 'keep' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await expect(deleteTasks([s.id])).rejects.toThrow(/processing/)
  })

  it('getTaskDetails 读回 spec/plan/process + summary（不再含 indexMd）', async () => {
    const s = await createPoolTask({ title: 'd', spec: '# SPEC' })
    const d = await getTaskDetails(s.id)
    expect(d?.specMd).toContain('# SPEC')
    expect(d?.summary.title).toBe('d')
    // TaskDetails 不再含 indexMd 字段(2026-09-02)
    expect((d as unknown as { indexMd?: string } | null)?.indexMd).toBeUndefined()
  })

  it('taskFactoryRoot 走 ZAI_TASK_FACTORY_DIR 覆盖', () => {
    expect(taskFactoryRoot()).toBe(dir)
  })

  it('moveTask 到 finished-tasks 后 summary.status=done 且 task.yaml 含 status: done', async () => {
    const s = await createPoolTask({ title: 't' })
    const moved = await moveTask(s.id, 'queue-tasks', 'finished-tasks')
    expect(moved.status).toBe('done')
    expect(moved.bucket).toBe('finished-tasks')
    const yaml = await readFile(join(dir, 'finished-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml).toContain('status: done')
  })

  it('deleteTasks 删除 queue 中的任务，返回后 listTasks 不再含该 id', async () => {
    const s = await createPoolTask({ title: 't' })
    await deleteTasks([s.id])
    expect(existsSync(join(dir, 'queue-tasks', s.id))).toBe(false)
    const bucket = await listTasks()
    expect(bucket.queue.map((t) => t.id)).not.toContain(s.id)
    expect(bucket.finished.map((t) => t.id)).not.toContain(s.id)
  })

  it('deleteTasks 批量含不存在的 id 时不删除任何任务（先整批预校验）', async () => {
    const a = await createPoolTask({ title: 'a' })
    const b = await createPoolTask({ title: 'b' })
    await expect(deleteTasks([a.id, 'tf-no-such-0000'])).rejects.toThrow(/not found/)
    expect(existsSync(join(dir, 'queue-tasks', a.id))).toBe(true)
    expect(existsSync(join(dir, 'queue-tasks', b.id))).toBe(true)
  })

  it('moveTask 目标已存在时 rejects（信息含 already exists）', async () => {
    const s = await createPoolTask({ id: 'dup-test', title: 't' })
    await mkdir(join(dir, 'finished-tasks', 'dup-test'), { recursive: true })
    await expect(moveTask('dup-test', 'queue-tasks', 'finished-tasks')).rejects.toThrow(/already exists/)
  })

  it('createPoolTask 写入 cwd 到 task.yaml，缺省回退 process.cwd()', async () => {
    const s = await createPoolTask({ title: 'cwd-task', cwd: '/abs/code/proj-a' })
    expect(s.cwd).toBe('/abs/code/proj-a')
    const yaml = await readFile(join(dir, 'queue-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    // cwd 是绝对路径，冒号必须保留 —— YAML 字符串不需要转义
    expect(yaml).toContain('cwd: /abs/code/proj-a')
    const s2 = await createPoolTask({ title: 'no-cwd' })
    expect(s2.cwd).toBe(process.cwd())
    // 空串 cwd 不被接受（'' 穿透 ?? 会毒化下游 SpawnAgent）——回退 process.cwd()
    const s3 = await createPoolTask({ title: 'empty-cwd', cwd: '' })
    expect(s3.cwd).toBe(process.cwd())
  })

  it('description 直接走 task.yaml 顶层字段（不再依赖 markdown 解析）', async () => {
    const a = await createPoolTask({ title: 'desc-task', description: '在 /abs/proj 创建 hello.txt 并汇报' })
    const b = await createPoolTask({ title: 'no-desc-task' })
    const bucket = await listTasks()
    const found = bucket.queue.find((t) => t.id === a.id)
    expect(found?.description).toBe('在 /abs/proj 创建 hello.txt 并汇报')
    const bSum = bucket.queue.find((t) => t.id === b.id)
    expect(bSum?.description).toBeUndefined()
    // markTaskStatus / moveTask 后 description 仍保留
    const m = await markTaskStatus(a.id, 'queue-tasks', { status: 'processing', executorTaskId: 'x1' })
    expect(m.description).toBe('在 /abs/proj 创建 hello.txt 并汇报')
    const moved = await moveTask(a.id, 'queue-tasks', 'processing-tasks')
    expect(moved.description).toBe('在 /abs/proj 创建 hello.txt 并汇报')
    // 多行 description 原样保留(不再截断为首段)
    const c = await createPoolTask({
      title: 'mline', description: '第一段目标说明。\n\n第二段也会保留。',
    })
    const cSum = (await listTasks()).queue.find((t) => t.id === c.id)
    expect(cSum?.description).toBe('第一段目标说明。\n\n第二段也会保留。')
    const cYaml = await readFile(join(dir, 'queue-tasks', c.id, TASK_YAML_FILENAME), 'utf-8')
    // yaml block scalar 用 | 或 |- 承载多行,保留换行
    expect(cYaml).toMatch(/description:\s*\|[-+]?\s*\n\s*第一段/)
  })

  it('执行期 markTaskStatus 与 moveTask 保留 cwd 字段', async () => {
    const s = await createPoolTask({ title: 'keep', cwd: '/p/q' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'a1234567' })
    const moved = await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    expect(moved.cwd).toBe('/p/q')
    const yaml = await readFile(join(dir, 'processing-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml).toContain('cwd: /p/q')
  })

  it('emitTaskFactoryEvent 无 emitter 时 no-op 不抛错', () => {
    const g = globalThis as { __zaiTaskFactoryEmitter?: unknown }
    const prev = g.__zaiTaskFactoryEmitter
    g.__zaiTaskFactoryEmitter = undefined
    try {
      expect(() => emitTaskFactoryEvent('task.updated', { id: 'tf-x' })).not.toThrow()
    } finally {
      if (prev === undefined) delete g.__zaiTaskFactoryEmitter
      else g.__zaiTaskFactoryEmitter = prev
    }
  })

  it('createPoolTask 接受 verifierAgent 写入 task.yaml（默认 null）', async () => {
    const s1 = await createPoolTask({ title: 'v1' })
    expect(s1.verifierAgent ?? null).toBeNull()
    const yaml1 = await readFile(join(dir, 'queue-tasks', s1.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml1).toContain('verifierAgent: null')
    const s2 = await createPoolTask({ title: 'v2', verifierAgent: 'code-reviewer' })
    expect(s2.verifierAgent).toBe('code-reviewer')
    const yaml2 = await readFile(join(dir, 'queue-tasks', s2.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yaml2).toContain('verifierAgent: code-reviewer')
    const sum = await getTaskSummary(s2.id, 'queue-tasks')
    expect(sum?.verifierAgent).toBe('code-reviewer')
  })

  it('moveTask processing → verifying 时 status=verifying，verifying → finished 时 status=done', async () => {
    const s = await createPoolTask({ title: 'v3', verifierAgent: 'code-reviewer' })
    const p = await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    expect(p.status).toBe('processing')
    expect(p.bucket).toBe('processing-tasks')
    const v = await moveTask(s.id, 'processing-tasks', 'verifying-tasks')
    expect(v.status).toBe('verifying')
    expect(v.bucket).toBe('verifying-tasks')
    // verifierAgent 应保留
    expect(v.verifierAgent).toBe('code-reviewer')
    const yamlV = await readFile(join(dir, 'verifying-tasks', s.id, TASK_YAML_FILENAME), 'utf-8')
    expect(yamlV).toContain('status: verifying')
    // 验证通过 → 归档
    const f = await moveTask(s.id, 'verifying-tasks', 'finished-tasks')
    expect(f.status).toBe('done')
    expect(f.bucket).toBe('finished-tasks')
  })

  it('listTasks 返回四桶（含 verifying）', async () => {
    const q = await createPoolTask({ title: 'qa' })
    const p = await createPoolTask({ title: 'pb' })
    const v = await createPoolTask({ title: 'vc' })
    await moveTask(p.id, 'queue-tasks', 'processing-tasks')
    await moveTask(v.id, 'queue-tasks', 'processing-tasks')
    await moveTask(v.id, 'processing-tasks', 'verifying-tasks')
    const bucket = await listTasks()
    expect(bucket.queue.map((t) => t.id)).toContain(q.id)
    expect(bucket.processing.map((t) => t.id)).toContain(p.id)
    expect(bucket.verifying.map((t) => t.id)).toContain(v.id)
    expect(bucket.verifying[0]?.status).toBe('verifying')
  })

  it('deleteTasks 拒绝 verifying 桶任务（验证闭环保护）', async () => {
    const s = await createPoolTask({ title: 'dv' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await moveTask(s.id, 'processing-tasks', 'verifying-tasks')
    await expect(deleteTasks([s.id])).rejects.toThrow(/verifying/)
  })
})

describe('taskFactoryFiles legacy index.md 兼容 (2026-09-02)', () => {
  it('读到旧 index.md 时自动迁移到 task.yaml 并删除旧文件', async () => {
    const id = 'legacy-mig-01'
    await createPoolTask({ id, title: 'legacy-task' })
    const dirQ = join(dir, 'queue-tasks', id)
    // 模拟旧版本写入的 index.md(YAML frontmatter + markdown 描述)
    const legacy = [
      '---',
      `id: ${id}`,
      'title: legacy-task',
      'status: queued',
      'agent: default',
      'verifierAgent: null',
      `cwd: ${dirQ}`,
      'createdAt: 2026-08-01T00:00:00.000Z',
      'startedAt: null',
      'completedAt: null',
      'executorTaskId: null',
      '---',
      '',
      '# legacy-task',
      '',
      '旧任务简介:测试迁移。',
      '',
    ].join('\n')
    // 删除新建的 task.yaml,改写 index.md,模拟旧数据
    await rm(join(dirQ, TASK_YAML_FILENAME))
    await writeFile(join(dirQ, LEGACY_INDEX_MD_FILENAME), legacy, 'utf-8')

    // 触发迁移(listTasks 走读路径)
    const bucket = await listTasks()
    const found = bucket.queue.find((t) => t.id === id)
    expect(found).toBeTruthy()
    expect(found?.title).toBe('legacy-task')
    expect(found?.description).toBe('旧任务简介:测试迁移。')
    expect(found?.createdAt).toBe('2026-08-01T00:00:00.000Z')

    // 迁移产物:task.yaml 存在,index.md 不存在
    expect(existsSync(join(dirQ, TASK_YAML_FILENAME))).toBe(true)
    expect(existsSync(join(dirQ, LEGACY_INDEX_MD_FILENAME))).toBe(false)

    // 迁移后写入仍走 task.yaml(再次 markTaskStatus 路径不应重建 index.md)
    await markTaskStatus(id, 'queue-tasks', { executorTaskId: 'x9' })
    expect(existsSync(join(dirQ, LEGACY_INDEX_MD_FILENAME))).toBe(false)
    const yamlAfter = await readFile(join(dirQ, TASK_YAML_FILENAME), 'utf-8')
    expect(yamlAfter).toContain('executorTaskId: x9')
  })

  it('getTaskSummary 命中 legacy index.md 也走迁移路径', async () => {
    const id = 'legacy-sum-01'
    const dirQ = join(dir, 'queue-tasks', id)
    await mkdir(dirQ, { recursive: true })
    await writeFile(join(dirQ, LEGACY_INDEX_MD_FILENAME), [
      '---',
      `id: ${id}`,
      'title: 旧任务',
      'status: queued',
      `cwd: ${dirQ}`,
      '---',
      '',
      '# 旧任务',
      '',
      '仅供迁移测试。',
      '',
    ].join('\n'), 'utf-8')

    const sum = await getTaskSummary(id, 'queue-tasks')
    expect(sum?.title).toBe('旧任务')
    expect(sum?.description).toBe('仅供迁移测试。')
    expect(existsSync(join(dirQ, LEGACY_INDEX_MD_FILENAME))).toBe(false)
    expect(existsSync(join(dirQ, TASK_YAML_FILENAME))).toBe(true)
  })
})
