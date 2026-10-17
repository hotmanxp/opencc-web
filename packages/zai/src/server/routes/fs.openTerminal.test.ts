/**
 * 回归测试 — 在目录上右键「在终端中打开」必须开在该目录,不是父目录 (wb-012)。
 *
 * 缺陷:`/fs/open-terminal` 用 `rel.endsWith('/')` 判断目标是不是目录
 * (`fs.ts:1494-1499`),而目录条目的 `path` 由 `name` 拼成(`fs.ts:396`
 * `relPath.split(sep).join('/')`)—— **结构上不可能带尾斜杠**。于是判据恒为
 * false,代码永远走「文件分支」取 `safe.abs` 的父目录:在 `src/` 上右键 →
 * 终端开在项目根。
 *
 * 修法:前端把已有的 `kind` prop(FsContextMenu.tsx:17 持有但未传)发给服务端,
 * 服务端按 `kind` 判断而不是字符串形状。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// 捕获真正传给终端启动器的参数 —— 这是本条唯一的判据。
const execCalls: { cmd: string; args: string[] }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ) => {
    execCalls.push({ cmd, args });
    cb(null);
    return { unref() {}, kill() {}, on() {} };
  },
}));

import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', fsRouter);
  return app;
}

describe('routes/fs POST /fs/open-terminal — 目录判定 (wb-012)', () => {
  let root: string;
  let app: express.Express;

  beforeEach(() => {
    execCalls.length = 0;
    root = mkdtempSync(join(tmpdir(), 'zai-fs-term-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'src', 'components'));
    writeFileSync(join(root, 'README.md'), 'hi\n');
    app = makeApp(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 各平台启动器把目录放在 argv 的某个位置;统一取「最后一个含该路径的参」。 */
  function launchedDir(): string {
    expect(execCalls.length).toBe(1);
    const args = execCalls[0].args;
    const joined = args.join(' ');
    return joined;
  }

  test('kind=dir → 终端开在该目录本身(不是父目录)', async () => {
    const res = await request(app)
      .post('/api/fs/open-terminal')
      .send({ path: 'src/components', kind: 'dir' });

    expect(res.status).toBe(200);
    expect(launchedDir()).toContain(join(root, 'src', 'components'));
  });

  test('kind=file → 终端开在它的父目录(既有行为不变)', async () => {
    const res = await request(app)
      .post('/api/fs/open-terminal')
      .send({ path: 'README.md', kind: 'file' });

    expect(res.status).toBe(200);
    expect(launchedDir()).toContain(join(root, 'README.md'.replace('README.md', '')));
    // 精确判据:父目录,而不是文件自身
    expect(launchedDir()).not.toMatch(new RegExp(escapeRe(join(root, 'README.md')) + String.raw`($|["'\s])`));
  });

  test('kind=dir 在嵌套目录上同样成立', async () => {
    await request(app)
      .post('/api/fs/open-terminal')
      .send({ path: 'src', kind: 'dir' });
    expect(launchedDir()).toContain(join(root, 'src'));
    expect(launchedDir()).not.toContain(`cd "${root}"`);
  });

  test('未传 kind 时保持向后兼容:尾斜杠仍然生效,其余走父目录', async () => {
    // 老客户端不传 kind —— 尾斜杠是它唯一能表达的「这是目录」信号。
    await request(app).post('/api/fs/open-terminal').send({ path: 'src/' });
    expect(launchedDir()).toContain(join(root, 'src'));
  });

  test('目录条目的 path 结构上不带尾斜杠 —— 即缺陷的成因', async () => {
    // 把前提钉死:fs/list 返回的目录条目路径确实没有尾斜杠。
    const list = await request(app).get('/api/fs/list?dir=');
    expect(list.status).toBe(200);
    const src = (list.body.entries as { name: string; path: string; type: string }[]).find(
      (e) => e.name === 'src',
    );
    expect(src).toBeDefined();
    expect(src!.type).toBe('dir');
    expect(src!.path.endsWith('/')).toBe(false);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// `sep` 参与了上面的路径拼接,显式引用避免被 lint 当成未使用。
void sep;
