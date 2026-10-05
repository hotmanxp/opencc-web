import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from './atomicWrite.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-write-'))
})
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWriteFile', () => {
  test('写入成功:内容正确,且不留任何 tmp 残留', async () => {
    const path = join(dir, 'settings.json')
    await atomicWriteFile(path, '{"a":1}')
    expect(await readFile(path, 'utf-8')).toBe('{"a":1}')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  test('覆盖已有文件:新内容生效,且不留 tmp 残留', async () => {
    const path = join(dir, 'settings.json')
    await writeFile(path, 'old', 'utf-8')
    await atomicWriteFile(path, 'new')
    expect(await readFile(path, 'utf-8')).toBe('new')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  // 计划 §R1 验证项:「写 tmp 失败时原文件内容不变」。这是整条修复的核心断言 ——
  // 旧的 writeFile(path, ...) 在 open('w') 就把目标截断成 0 字节,内容还
  // 没开始写;任何中途失败都会留下空文件且原内容不可恢复。
  test('写 tmp 失败(父目录不存在)→ 抛错,且不波及其它文件', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, 'PREVIOUS CONTENT', 'utf-8')

    await expect(
      atomicWriteFile(join(dir, 'missing-dir', 'state.json'), 'new'),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await readFile(path, 'utf-8')).toBe('PREVIOUS CONTENT')
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  test('写不动(目录只读 + 文件只读)→ 抛错且原文件内容保持不变', async () => {
    const path = join(dir, 'locked.json')
    await writeFile(path, 'PREVIOUS CONTENT', 'utf-8')
    // 目录和文件都只读:建不了 tmp,原地写也不行,两条路都失败。
    // (只把目录设只读是不够的 —— 那正是 atomicWriteFile 会回退原地写的场景)
    await chmod(path, 0o444)
    await chmod(dir, 0o500)
    try {
      await expect(atomicWriteFile(path, 'new')).rejects.toMatchObject({ code: 'EACCES' })
      expect(await readFile(path, 'utf-8')).toBe('PREVIOUS CONTENT')
    } finally {
      await chmod(dir, 0o700)
      await chmod(path, 0o644)
    }
  })

  test('mode 选项生效:凭据文件落盘 0600(微信 QR token 依赖)', async () => {
    const path = join(dir, 'account.json')
    await atomicWriteFile(path, '{"token":"x"}', { mode: 0o600 })
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test('mode 在覆盖写后依然生效(tmp inode 的 mode 被 rename 带过去)', async () => {
    const path = join(dir, 'account.json')
    await atomicWriteFile(path, 'first', { mode: 0o600 })
    await atomicWriteFile(path, 'second', { mode: 0o600 })
    expect(await readFile(path, 'utf-8')).toBe('second')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  // rename 换的是**新 inode**,目标文件原有的 mode 不会跟过来。写用户源码的
  // 路径(/api/fs/file PUT)能改任意文件,漏掉这条 = `chmod 600 .env` 存一次
  // 就变世界可读,`chmod +x` 的脚本掉执行位。
  test('覆盖写保留目标文件原有 mode(不把 0600 降成 0644)', async () => {
    const path = join(dir, '.env')
    await writeFile(path, 'SECRET=1', 'utf-8')
    await chmod(path, 0o600)
    await atomicWriteFile(path, 'SECRET=2')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf-8')).toBe('SECRET=2')
  })

  test('覆盖写保留可执行位', async () => {
    const path = join(dir, 'deploy.sh')
    await writeFile(path, '#!/bin/sh\n', 'utf-8')
    await chmod(path, 0o755)
    await atomicWriteFile(path, '#!/bin/sh\necho hi\n')
    expect((await stat(path)).mode & 0o777).toBe(0o755)
  })

  test('显式 mode 优先于目标文件现有 mode', async () => {
    const path = join(dir, 'account.json')
    await writeFile(path, 'a', 'utf-8')
    await chmod(path, 0o644)
    await atomicWriteFile(path, 'b', { mode: 0o600 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  // 「文件可写但所在目录不可写」时建不了 tmp —— 别人 root 所有的目录、
  // sticky /tmp 里你拥有的文件。原先原地写能成功,纯 tmp+rename 会变 500,
  // 属于行为回退,这里保证仍然能写。
  test('目录不可写但文件可写 → 仍能覆盖写(回退原地写)', async () => {
    const roDir = join(dir, 'ro')
    await mkdir(roDir, { recursive: true })
    const path = join(roDir, 'mine.txt')
    await writeFile(path, 'OLD', 'utf-8')
    await chmod(roDir, 0o500)
    try {
      await atomicWriteFile(path, 'NEW')
      expect(await readFile(path, 'utf-8')).toBe('NEW')
    } finally {
      await chmod(roDir, 0o700)
    }
  })

  // tmp 名必须带计数器:fileStore 与 zaiSettingsStore 是同进程内的两个并发
  // 写者,pid 相同。裸 `${path}.${pid}.tmp` 会让二者撞名(第二次 rename 报
  // ENOENT,先发者的更新被后发者覆盖)。
  test('同进程并发写同一文件 → 不撞名,最终内容完整且无残留', async () => {
    const path = join(dir, 'settings.json')
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i }))
    await Promise.all(payloads.map((p) => atomicWriteFile(path, p)))

    const final = JSON.parse(await readFile(path, 'utf-8')) as { i: number }
    expect(final.i).toBeGreaterThanOrEqual(0)
    expect(final.i).toBeLessThan(payloads.length)
    // 没有半截文件:解析成功即证明内容是某个完整 payload
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  test('接受 Buffer payload', async () => {
    const path = join(dir, 'bin')
    await atomicWriteFile(path, Buffer.from([1, 2, 3]))
    expect([...((await readFile(path)) as Buffer)]).toEqual([1, 2, 3])
  })

  // ===== 孤儿 tmp 清扫 =====
  // SIGKILL 恰好落在「写 tmp」与「rename」之间会留下 <base>.<pid>.<n>.tmp,
  // 永远等不到 rename,在用户项目里表现为 git status 里凭空多出的文件。

  test('清扫:删除属于已死进程的残留 tmp', async () => {
    // pid 2^22 是内核保留的,几乎不可能有活进程
    const orphan = join(dir, 'app.ts.4194303.0.tmp')
    await writeFile(orphan, 'half-written', 'utf-8')
    await atomicWriteFile(join(dir, 'app.ts'), 'real content')
    expect(await readdir(dir)).toEqual(['app.ts'])
  })

  test('清扫:不动属于存活进程的 tmp(可能正写到一半)', async () => {
    // process.pid 一定存活;另一个用 init(1) 的 pid 近似常驻
    const mine = join(dir, 'keep.ts')
    await writeFile(join(dir, `keep.ts.${process.pid}.99.tmp`), 'in flight', 'utf-8')
    await atomicWriteFile(mine, 'x')
    const left = await readdir(dir)
    expect(left).toContain(`keep.ts.${process.pid}.99.tmp`)
  })

  test('清扫:不误伤名字相近但不符合命名格式的文件', async () => {
    await writeFile(join(dir, 'note.ts.abc.0.tmp'), 'mine', 'utf-8')   // pid 非数字
    await writeFile(join(dir, 'other.ts.4194303.0.tmp.bak'), 'x', 'utf-8') // 后缀不对
    await atomicWriteFile(join(dir, 'note.ts'), 'a')
    await atomicWriteFile(join(dir, 'other.ts'), 'b')
    const left = await readdir(dir)
    expect(left).toContain('note.ts.abc.0.tmp')
    expect(left).toContain('other.ts.4194303.0.tmp.bak')
  })

  test('清扫:只删同名前缀的,别的文件的孤儿不碰', async () => {
    await writeFile(join(dir, 'unrelated.txt.4194303.0.tmp'), 'x', 'utf-8')
    await atomicWriteFile(join(dir, 'app.ts'), 'y')
    expect(await readdir(dir)).toContain('unrelated.txt.4194303.0.tmp')
  })
})
