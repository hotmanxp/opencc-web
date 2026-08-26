import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import execRouter from '../../src/server/routes/exec.js';

const app = express();
app.use(express.json());
app.use('/api', execRouter);

describe('POST /api/exec', () => {
  it('runs an allowed command and streams output', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'echo', args: ['hello'] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"start"');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('"type":"exit"');
  });

  it('rejects disallowed commands', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'rm', args: ['-rf', '/'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('command not allowed');
  });

  it('rejects missing cmd', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ args: ['hello'] });
    expect(res.status).toBe(400);
  });

  it('defaults args to empty array', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'pwd' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"exit"');
  });

  // cwd 参数: 让通用接口能在 workspace cwd 下跑命令 (e.g. `git`).
  // 之前 cwd 不在白名单传不到 spawner, 调用方不得不另起专用 endpoint.
  // 现在所有白名单命令都可以指定 cwd.
  it('runs command in provided cwd (git rev-parse in repo)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zai-exec-cwd-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

      const res = await request(app)
        .post('/api/exec')
        .send({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd: repo });
      expect(res.status).toBe(200);
      // stdout 应包含仓库绝对路径. macOS 把 /tmp symlink 成 /private/tmp,
      // git 解析出来的路径带 /private 前缀, 用 fs.realpathSync 对齐.
      const match = res.text.match(/"line":"([^"]+)"/);
      const { realpathSync } = await import('node:fs');
      expect(match?.[1]).toBe(realpathSync(repo));
      expect(res.text).toContain('"type":"exit"');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects cwd traversal with "../" — but cwd is not path-restricted, only "not a repository" matters', async () => {
    // cwd 透传给 spawner, 服务端不强制做路径校验 (与老 /exec 行为一致 — 调用方负责).
    // 这里只验证 cwd 字段透传不抛 zod 错误.
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'pwd', args: [], cwd: '/tmp' });
    expect(res.status).toBe(200);
  });

  it('omitting cwd falls back to process.cwd() (no regression)', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'pwd' });
    expect(res.status).toBe(200);
    const match = res.text.match(/"line":"([^"]+)"/);
    // process.cwd() 与 supertest 默认 cwd 一致 (vitest 工作目录)
    expect(match?.[1]).toBe(process.cwd());
  });
});
