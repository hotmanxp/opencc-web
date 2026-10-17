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

  /** 轮询目录直到满足条件(或超时),返回最后一次读到的文件名数组。 */
  async function waitForDir(pred: (names: string[]) => boolean, tries = 40): Promise<string[]> {
    let names: string[] = [];
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 50));
      names = readdirSync(wpDir());
      if (pred(names)) return names;
    }
    return names;
  }

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
    // 先等第一轮的上传窗口(grace)彻底结束 —— 目录里只剩 first 一个文件。
    // 这一步是必要的:上传窗口内的文件受保护,**两次 PUT 挨得近时两张都会
    // 留下**(这是 oc-004 修复的既定取舍:200 必须意味着文件活着)。不先等
    // 窗口关闭,下一条断言就变成对时序的运气。
    await waitForDir((n) => n.length === 1);

    const second = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: `data:image/png;base64,${PNG_B64}` });
    expect(second.status).toBe(200);

    // 第二轮窗口关闭后,first 被回收,只剩最新一张。
    const names = await waitForDir((n) => n.length === 1);
    expect(names).toEqual([`${second.body.id}.png`]);
  });

  // 回归 oc-004: 清理曾是 `void readdir(dir)` fire-and-forget,与写入无互斥。
  // N 个并发 PUT 各自写完自己的文件后各自起清理,最后落地的那次清理会把
  // 同批其余 N-1 个文件全删掉 → 那 N-1 个 PUT 的响应仍是 200(假成功),
  // 前端把坏 URL 存进 localStorage,此后每次刷新都是坏图而 UI 显示
  // 「壁纸已更新」。断言:N 个 URL 全部可 GET 200。
  test('并发 N 次 PUT → N 个返回的 URL 全部 GET 200(清理不得删掉同批并发写入)', async () => {
    const N = 6;
    const app = makeApp();
    const puts = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).put('/api/desktop/wallpaper').send({ dataUrl: `data:image/png;base64,${PNG_B64}` }),
      ),
    );
    // PUT 一律 200(这是既有契约,不是本条的判据)
    expect(puts.map((p) => p.status)).toEqual(Array(N).fill(200));
    const urls = puts.map((p) => p.body.url as string);
    expect(new Set(urls).size).toBe(N);

    // 给 fire-and-forget 清理留出跑完的时间:若清理与写入无互斥,此刻
    // 目录里只会剩最后一个文件,前面 N-1 个 URL 全部 404。
    await new Promise((r) => setTimeout(r, 300));

    const gets = await Promise.all(urls.map((u) => request(app).get(u)));
    expect(gets.map((g) => g.status)).toEqual(Array(N).fill(200));
  });

  // oc-002:壁纸端点接受 image/svg+xml,回吐时必须与 fs.ts 对齐加
  // nosniff / CSP sandbox —— SVG 内嵌脚本在直接导航该 URL 时会以应用
  // origin 执行。
  test('GET 回吐 SVG → 带 X-Content-Type-Options: nosniff 与 CSP: sandbox', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const put = await request(makeApp())
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
    expect(put.status).toBe(200);
    expect(put.body.id).toBeTruthy();

    const get = await request(makeApp()).get(put.body.url).buffer();
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/svg+xml');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toBe('sandbox');
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
