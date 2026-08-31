import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import desktopWallpaperRouter from './desktopWallpaper.js';

function makeApp(): express.Express {
  const app = express();
  // 与 server/index.ts 生产 wiring 一致:壁纸 dataURL 可达数 MB,默认 100kb 限制会 413
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', desktopWallpaperRouter);
  return app;
}

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('routes/desktopWallpaper', () => {
  let dataDir: string;
  const wpDir = () => join(dataDir, 'desktop', 'wallpapers');

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-wp-'));
    process.env.ZAI_DATA_DIR = dataDir;
  });
  afterAll(() => {
    delete process.env.ZAI_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('PUT dataURL → 落盘文件并返回 /api URL;GET 该 URL 返回原字节', async () => {
    const put = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: `data:image/png;base64,${PNG_B64}` });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(typeof put.body.id).toBe('string');
    expect(put.body.url).toBe(`/api/desktop/wallpaper/${put.body.id}`);

    // 文件确实写在 ~/.zai(desktop/wallpapers) 下,而不是任何 localStorage 语义
    expect(readdirSync(wpDir())).toEqual([`${put.body.id}.png`]);

    const get = await request(makeApp()).get(put.body.url).buffer();
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(get.body).toString('base64')).toBe(PNG_B64);
  });

  test('再次 PUT 会清理旧壁纸文件(目录只保留最新一张)', async () => {
    const first = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: `data:image/png;base64,${PNG_B64}` });
    expect(first.status).toBe(200);
    // 等异步清理任务完成(readdir 轮询目录,最多 ~1s)
    let names: string[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      names = readdirSync(wpDir());
      if (names.length === 1) break;
    }
    expect(names).toEqual([`${first.body.id}.png`]);
  });

  test('非图片 dataURL / 非法 dataURL → 400', async () => {
    const bad1 = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: 'data:text/plain;base64,aGk=' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: 'hello' });
    expect(bad2.status).toBe(400);
    const bad3 = await request(makeApp()).put('/api/desktop/wallpaper').send({});
    expect(bad3.status).toBe(400);
  });

  test('GET 未知 id → 404;路径穿越 id → 400', async () => {
    const miss = await request(makeApp()).get('/api/desktop/wallpaper/nope123');
    expect(miss.status).toBe(404);
    const trav = await request(makeApp()).get(
      `/api/desktop/wallpaper/${encodeURIComponent('../../../etc/passwd')}`,
    );
    expect(trav.status).toBe(400);
  });
});
