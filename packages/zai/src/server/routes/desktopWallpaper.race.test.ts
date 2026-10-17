/**
 * oc-004 续 — 清理定时器 × 写入 的交错竞态(确定性复现)。
 *
 * 缺陷:静默期定时器的回调把 `st.timer` 置 null 之后才把 sweep 排到目录锁
 * 后面。若**另一次写入此刻正持有锁**,那个写入随后完成时 `armCleanup` 看到
 * timer 已是 null,于是又排一个新定时器;排在前面的 sweep 跑完会**清空**
 * protectedNames,后一个定时器就带着空快照去扫,把刚返回 200 的文件删掉:
 *
 *   t=299.9  PUT B 进锁,开始 writeFile
 *   t=300    timer₁ 触发 → st.timer=null → sweep 排在 B 后面
 *   t=300.5  B 写完 → armCleanup:protected={A,B};timer 是 null → 再排 timer₂
 *   t=300.6  sweep 跑(keep={A,B})→ protectedNames={}     ← 抹掉保护
 *   t=600.5  timer₂ 触发 → keep={} → 把 B 也 unlink
 *
 * B 在 t=300.5 返回 200,文件却在 300ms 后没了 —— 正是 oc-004 的症状。
 *
 * 窗口只有一次 writeFile 的时长(约 1ms / 300ms ≈ 0.3%),真跑撞不上,所以把
 * writeFile 变慢,把交错放大成必然。
 *
 * 修法:`DirState.sweepPending` —— 已有 sweep 排队时 `armCleanup` 不再排新的
 * (排队中的 sweep 拿到锁后才读 protectedNames,必然看得见新加的 name)。
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 让下一次 writeFile 变慢,人为放大定时器与写入的交错窗口。
let writeDelayMs = 0;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const delay = writeDelayMs;
      writeDelayMs = 0; // 只影响下一次写入
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(...args);
    },
  };
});

import desktopWallpaperRouter from './desktopWallpaper.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', desktopWallpaperRouter);
  return app;
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 轮询目录直到满足条件(或超时)。 */
async function waitForDir(dir: string, pred: (n: string[]) => boolean, tries = 40): Promise<string[]> {
  let names: string[] = [];
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 50));
    names = readdirSync(dir);
    if (pred(names)) return names;
  }
  return names;
}

describe('oc-004: 清理定时器与写入交错时不得删掉刚返回的 URL', () => {
  let dataDir: string;
  const wpDir = () => join(dataDir, 'desktop', 'wallpapers');

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-wp-race-'));
    process.env.ZAI_DATA_DIR = dataDir;
  });
  afterAll(() => {
    delete process.env.ZAI_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('写入跨过静默期边界 → 刚返回 200 的 URL 不得在后续静默期后消失', async () => {
    const app = makeApp();

    // A 在 t=0 上传 → armCleanup 排出 timer₁@t=300
    await request(app).put('/api/desktop/wallpaper').send({ dataUrl: `data:image/png;base64,${PNG_B64}` });

    // B 在 t=280 抵达并进锁,写入被拖到 t=630 —— 于是 timer₁ 必然在
    // **B 持锁期间**(t=300)触发,把 sweep 排在 B 后面。
    // (不能先等 A 的窗口关闭:那样 timer₁ 早已触发,交错就不成立了。)
    await new Promise((r) => setTimeout(r, 280));
    writeDelayMs = 350;
    const put = await request(app)
      .put('/api/desktop/wallpaper')
      .send({ dataUrl: `data:image/png;base64,${PNG_B64}` });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    const url = put.body.url as string;
    const newName = `${put.body.id}.png`;

    // 跨过三个静默期,覆盖「旧 sweep 清空保护集 → 新定时器带空快照扫」整条链
    await new Promise((r) => setTimeout(r, 300 * 3));

    // 判据:B 的文件必须还在(修复前此处目录为空,GET 404)
    expect(readdirSync(wpDir())).toContain(newName);
    const get = await request(app).get(url).buffer();
    expect(get.status).toBe(200);
  });
});
