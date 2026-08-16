import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import configRouter from '../../../src/server/routes/config.js';

// AGENTS.md 路由回归 — /api/config/:tool/agents-md (GET / PUT)
// 必须注册在 /config/:tool 之前(见 src/server/routes/config.ts 注释),
// 一旦顺序破坏, /config/:tool 会抢先匹配然后 readConfig(tool) 返回
// content:{} (Record),下方"路由顺序回归保护"测试会立刻失败。

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-config-agents-md-'));
  process.env.HOME = tempHome;
  // 预创建 ~/.zai (zai 路径) 和 ~/.claude (opencc 路径) 让首次写入走 mkdir parent 已覆盖;
  // nova/opencode 路径不预创建,用于验证"首次 PUT 自动 mkdir 父目录"。
  mkdirSync(join(tempHome, '.zai'), { recursive: true });
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', configRouter);
  return app;
}

describe('GET /api/config/:tool/agents-md', () => {
  it('returns missing:true with empty content when file absent', async () => {
    const res = await request(buildApp()).get('/api/config/nova/agents-md');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.missing).toBe(true);
    expect(res.body.content).toBe('');
    expect(res.body.path).toMatch(/\.nova\/AGENTS\.md$/);
  });

  it('rejects invalid tool name', async () => {
    const res = await request(buildApp()).get('/api/config/foo/agents-md');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid tool');
  });

  it('route order regression guard — /config/:tool MUST NOT swallow agents-md', async () => {
    // 一旦未来有人把 agents-md 路由挪到 /config/:tool 之后, Express 会优先匹配
    // /config/:tool, ConfigToolSchema 解析到 'nova' 通过, 然后调 readConfig
    // 返回 {content: {}} (Record, 不是 string)。下方 typeof === 'string' 断言
    // 会立刻失败,作为路由顺序回归的强保护。
    const res = await request(buildApp()).get('/api/config/nova/agents-md');
    expect(res.status).toBe(200);
    expect(typeof res.body.content).toBe('string');
  });
});

describe('PUT /api/config/:tool/agents-md', () => {
  it('writes markdown and reads it back atomically', async () => {
    const app = buildApp();
    const put = await request(app).put('/api/config/opencc/agents-md').send({ content: '# hi\n' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });

    const get = await request(app).get('/api/config/opencc/agents-md');
    expect(get.body.content).toBe('# hi\n');
    expect(get.body.exists).toBe(true);
    expect(get.body.path).toMatch(/\.claude\/AGENTS\.md$/);
  });

  it('creates the file (with parent dir) when missing', async () => {
    const app = buildApp();
    // opencode 父目录 ~/.config/opencode 在 beforeAll 没预创建, 验证 mkdir parent。
    const put = await request(app).put('/api/config/opencode/agents-md').send({ content: 'x' });
    expect(put.status).toBe(200);
    const path = join(tempHome, '.config', 'opencode', 'AGENTS.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('x');
  });

  it('allows empty content (clear file)', async () => {
    const app = buildApp();
    await request(app).put('/api/config/nova/agents-md').send({ content: 'before' });
    const clear = await request(app).put('/api/config/nova/agents-md').send({ content: '' });
    expect(clear.status).toBe(200);
    const get = await request(app).get('/api/config/nova/agents-md');
    expect(get.body.content).toBe('');
  });

  it('rejects body with non-string content', async () => {
    const res = await request(buildApp())
      .put('/api/config/nova/agents-md')
      .send({ content: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content must be a string');
  });

  it('rejects body missing content field', async () => {
    const res = await request(buildApp())
      .put('/api/config/nova/agents-md')
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects invalid tool name', async () => {
    const res = await request(buildApp())
      .put('/api/config/foo/agents-md')
      .send({ content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid tool');
  });

  it('opencc and zai do NOT share — paths are independent', async () => {
    const app = buildApp();
    await request(app).put('/api/config/opencc/agents-md').send({ content: 'opencc-md' });
    await request(app).put('/api/config/zai/agents-md').send({ content: 'zai-md' });

    const openccGet = await request(app).get('/api/config/opencc/agents-md');
    expect(openccGet.body.content).toBe('opencc-md');
    expect(openccGet.body.path).toMatch(/\.claude\/AGENTS\.md$/);

    const zaiGet = await request(app).get('/api/config/zai/agents-md');
    expect(zaiGet.body.content).toBe('zai-md');
    expect(zaiGet.body.path).toMatch(/\.zai\/AGENTS\.md$/);
  });
});