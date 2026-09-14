// Server tests for POST /api/fs/resolve — multi-stage path resolution.
//
// 覆盖级联:
//   - 绝对路径存在 → exact
//   - 绝对路径不存在 → ENOENT
//   - 绝对路径是目录 → EISDIR
//   - 相对路径在 sessionCwd 内命中 → exact
//   - 相对路径在实例 cwd 内命中 → exact
//   - 都不命中、gitRoot 内 1 条 → exact
//   - 都不命中、gitRoot 内多条 → multiple
//   - 都不命中、无候选 → ENOENT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { fsRouter } from '../../../src/server/routes/fs.js'

interface AppWithLocals extends express.Express {
  locals: { instanceContext: { cwd: string; cwdName: string } }
}

function makeApp(cwd: string): AppWithLocals {
  const app = express() as AppWithLocals
  app.use(express.json())
  app.locals.instanceContext = { cwd, cwdName: 'test' }
  app.use('/api', fsRouter)
  return app
}

let cwd: string
let app: AppWithLocals

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fs-resolve-'))
  app = makeApp(cwd)
  // 项目结构:
  //   <cwd>/a/session-cwd-target.ts   ← sessionCwd 命中
  //   <cwd>/b/cwd-target.ts            ← 实例 cwd 命中
  //   <cwd>/d/deep/uniq.ts             ← 搜索兜底命中
  //   <cwd>/e/also/uniq.ts             ← 搜索兜底命中(多匹配)
  //   <cwd>/f/seed.txt
  mkdirSync(join(cwd, 'a'), { recursive: true })
  mkdirSync(join(cwd, 'b'), { recursive: true })
  mkdirSync(join(cwd, 'd/deep'), { recursive: true })
  mkdirSync(join(cwd, 'e/also'), { recursive: true })
  mkdirSync(join(cwd, 'f'), { recursive: true })
  writeFileSync(join(cwd, 'a/session-cwd-target.ts'), 'session')
  writeFileSync(join(cwd, 'b/cwd-target.ts'), 'cwd')
  writeFileSync(join(cwd, 'd/deep/uniq.ts'), 'uniq-d')
  writeFileSync(join(cwd, 'e/also/uniq.ts'), 'uniq-e')
  writeFileSync(join(cwd, 'f/seed.txt'), 'txt')
})

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true })
})

beforeEach(() => {
  // 每个用例前重置 app 没什么需要,但保留 hook 备扩展
})

describe('POST /api/fs/resolve', () => {
  it('绝对路径存在 → exact', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: join(cwd, 'b/cwd-target.ts') })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'b/cwd-target.ts'))
  })

  it('绝对路径不存在 → ENOENT', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: join(cwd, 'does/not/exist.ts') })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('ENOENT')
    expect(res.body.error).toBe('文件不存在')
  })

  it('绝对路径是目录 → EISDIR', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: join(cwd, 'a') })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('EISDIR')
  })

  it('缺 path → BADREQ', async () => {
    const res = await request(app).post('/api/fs/resolve').send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('BADREQ')
  })

  it('相对路径在 sessionCwd 内命中 → exact(优先于实例 cwd)', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'session-cwd-target.ts', sessionCwd: join(cwd, 'a') })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'a/session-cwd-target.ts'))
  })

  it('相对路径在实例 cwd 内命中 → exact', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'b/cwd-target.ts' })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'b/cwd-target.ts'))
  })

  it('sessionCwd 找不到时落到实例 cwd 直接 stat', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'b/cwd-target.ts', sessionCwd: join(cwd, 'nowhere') })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'b/cwd-target.ts'))
  })

  it('直接 stat 都失败时,搜索兜底命中 1 个 → exact', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'deep/uniq.ts', sessionCwd: join(cwd, 'nowhere') })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'd/deep/uniq.ts'))
  })

  it('搜索兜底命中多个 → multiple(列举候选 + rel 路径)', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'uniq.ts' })
    expect(res.body.ok).toBe('multiple')
    const candidates = res.body.candidates as Array<{ abs: string; rel: string }>
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const rels = candidates.map((c) => c.rel).sort()
    expect(rels).toContain('d/deep/uniq.ts')
    expect(rels).toContain('e/also/uniq.ts')
    // 绝对路径都在 cwd 下
    for (const c of candidates) {
      expect(c.abs.startsWith(cwd)).toBe(true)
    }
  })

  it('找不到 → ENOENT', async () => {
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'definitely-not-a-real-file-xyz.ts' })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('ENOENT')
  })

  it('搜索结果按相对路径段匹配(过滤掉同 basename 但不同后段)', async () => {
    // seed.txt 是 cwd 顶层;相对路径 'seed.txt' 也应该命中
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'seed.txt' })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'f/seed.txt'))
  })

  it('git 仓库内:被 .gitignore 忽略目录里的同名文件不出现在候选里', async () => {
    // 把临时目录变成 git 仓库:.gitignore 忽略 ignored/,里面放同名文件
    writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
    execFileSync('git', ['-C', cwd, 'init', '-q'])
    mkdirSync(join(cwd, 'ignored'), { recursive: true })
    writeFileSync(join(cwd, 'ignored/uniq.ts'), 'ignored-copy')
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'uniq.ts' })
    expect(res.body.ok).toBe('multiple')
    const rels = (res.body.candidates as Array<{ rel: string }>).map((c) => c.rel)
    expect(rels).toContain('d/deep/uniq.ts')
    expect(rels).toContain('e/also/uniq.ts')
    // 关键断言:gitignore 命中的 ignored/ 不进候选
    expect(rels.some((r) => r.startsWith('ignored/'))).toBe(false)
  })

  it('带目录前缀的路径命中忽略目录内的文件 → 直接 stat 命中(不进搜索)', async () => {
    // 明确写了 ignored/ 前缀 = 用户真的指这个文件,直接 stat 放行
    const res = await request(app)
      .post('/api/fs/resolve')
      .send({ path: 'ignored/uniq.ts' })
    expect(res.body.ok).toBe('exact')
    expect(res.body.abs).toBe(join(cwd, 'ignored/uniq.ts'))
  })
})
