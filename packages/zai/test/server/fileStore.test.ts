import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readConfig,
  writeConfig,
  readAgentsMd,
  writeAgentsMd,
} from '../../src/server/services/fileStore.js';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-test-'));
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, '.nova'), { recursive: true });
  // 预创建 ~/.zai (zai 路径) 和 ~/.claude (opencc 路径),让它们的父目录
  // 在测试环境已存在;opencode 父目录不预创建,用于验证首次写入自动 mkdir。
  mkdirSync(join(tempHome, '.zai'), { recursive: true });
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('returns missing:true when config file does not exist', async () => {
    const result = await readConfig('nova');
    expect(result.exists).toBe(false);
    expect(result.missing).toBe(true);
  });
});

describe('writeConfig + readConfig roundtrip', () => {
  it('writes and reads back content atomically', async () => {
    const content = { env: { TEST: '1' } };
    await writeConfig('nova', content);
    const result = await readConfig('nova');
    expect(result.exists).toBe(true);
    expect(result.content).toEqual(content);
  });
});

describe('readAgentsMd', () => {
  it('returns missing:true with empty content when file absent', async () => {
    // opencode AGENTS.md 路径在 tempHome 下未创建 -> 必然 missing。
    const result = await readAgentsMd('opencode');
    expect(result.exists).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.content).toBe('');
    expect(result.path).toMatch(/\.config\/opencode\/AGENTS\.md$/);
  });
});

describe('writeAgentsMd + readAgentsMd roundtrip', () => {
  it('writes utf-8 markdown and reads it back', async () => {
    const md = '# Hello\n\n- 中文 + emoji 🚀\n';
    await writeAgentsMd('opencc', md);
    const result = await readAgentsMd('opencc');
    expect(result.exists).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(result.content).toBe(md);
    // opencc 走 ~/.claude/AGENTS.md, 与 zai 走 ~/.zai/AGENTS.md 互不影响。
    expect((await readAgentsMd('opencc')).path).toMatch(/\.claude\/AGENTS\.md$/);
    expect((await readAgentsMd('zai')).path).toMatch(/\.zai\/AGENTS\.md$/);
  });

  it('allows empty content (clears the file)', async () => {
    await writeAgentsMd('nova', 'something');
    await writeAgentsMd('nova', '');
    const result = await readAgentsMd('nova');
    expect(result.exists).toBe(true);
    expect(result.content).toBe('');
  });

  it('maps each tool to the right path', async () => {
    expect((await readAgentsMd('nova')).path).toMatch(/\.nova\/AGENTS\.md$/);
    expect((await readAgentsMd('opencode')).path).toMatch(/\.config\/opencode\/AGENTS\.md$/);
    expect((await readAgentsMd('opencc')).path).toMatch(/\.claude\/AGENTS\.md$/);
    expect((await readAgentsMd('zai')).path).toMatch(/\.zai\/AGENTS\.md$/);
  });

  it('opencc and zai do NOT share — paths are independent', async () => {
    await writeAgentsMd('opencc', 'opencc-md');
    await writeAgentsMd('zai', 'zai-md');
    expect((await readAgentsMd('opencc')).content).toBe('opencc-md');
    expect((await readAgentsMd('zai')).content).toBe('zai-md');
    expect((await readAgentsMd('opencc')).path).not.toBe((await readAgentsMd('zai')).path);
  });

  it('auto-creates parent dir on first write (opencode path not pre-created)', async () => {
    // beforeAll 只 mkdir 了 ~/.nova, ~/.zai, ~/.claude,但 opencode 父目录
    // ~/.config/opencode 没预创建 — 验证 mkdir parent 递归行为。
    await writeAgentsMd('opencode', 'auto-mkdir');
    expect((await readAgentsMd('opencode')).content).toBe('auto-mkdir');
  });
});
// H1 (docs/bugs/fix-plan-10-05.md):`writeConfig` 原本是整对象写,完全绕过
// `updateZaiSettings` 的 read-merge-write —— 在配置页保存一次「Zai」tab 就会
// 回滚设置抽屉期间写入的所有字段,**哪怕完全不并发**也会丢。
describe('writeConfig 浅合并语义 (H1)', () => {
  it('writeConfig 不会回滚 updateZaiSettings 先前写入的字段', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await import(
      '../../src/server/services/zaiSettingsStore.js'
    );
    await updateZaiSettings({ theme: 'high-contrast' });
    // 配置页 PUT /config/zai 的 body 里只有它自己读到的那部分
    await writeConfig('zai', { env: { FOO: '1' } });
    const onDisk = JSON.parse(readFileSync(zaiSettingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('high-contrast'); // 没被覆盖掉
    expect(onDisk.env).toEqual({ FOO: '1' });
  });

  it('opencc tab 与 zai tab 同指 settings.json,互相也是 patch 而非覆盖', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await import(
      '../../src/server/services/zaiSettingsStore.js'
    );
    await updateZaiSettings({ theme: 'light' });
    await writeConfig('opencc', { workMode: 'office' });
    const onDisk = JSON.parse(readFileSync(zaiSettingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(onDisk.theme).toBe('light');
    expect(onDisk.workMode).toBe('office');
  });

  it('非 zai 路径的工具也走浅合并(nova)', async () => {
    await writeConfig('nova', { a: 1 });
    await writeConfig('nova', { b: 2 });
    const result = await readConfig('nova');
    // 同文件里更早的用例写过 env —— 合并语义下它必须留下(整对象写会抹掉)
    expect(result.content).toMatchObject({ a: 1, b: 2 });
  });
});

// H1 残余(docs/bugs/fix-plan-10-05.md):浅合并只能保护「编辑器缓冲里没有」的
// 字段;缓冲里**带着**、但期间被设置抽屉改过的同名字段照样会被回滚。ego-browser
// 实测复现过:配置页打开时 disk=verbose,期间抽屉写入 default,再点保存 →
// disk 滚回 verbose。带 base 的三路合并才是真正的防线。
describe('writeConfig 三路合并 (H1 残余)', () => {
  async function freshZai() {
    const { __resetCacheForTests } = await import('../../src/server/services/zaiSettingsCache.js');
    __resetCacheForTests();
    const { updateZaiSettings, zaiSettingsPath } = await import(
      '../../src/server/services/zaiSettingsStore.js'
    );
    return { updateZaiSettings, zaiSettingsPath };
  }
  const diskOf = async (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

  it('陈旧缓冲不会回滚用户没动过的同名字段', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ outputStyle: 'verbose' });
    const base = { outputStyle: 'verbose' };          // 编辑器打开时的快照
    await updateZaiSettings({ outputStyle: 'default' }); // 期间抽屉改了同一个键
    // 用户在编辑器里啥也没改就保存
    await writeConfig('zai', { outputStyle: 'verbose' }, base);
    expect((await diskOf(zaiSettingsPath())).outputStyle).toBe('default'); // 没被回滚
  });

  it('用户真的改了才写入(且只改那一个键)', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ outputStyle: 'verbose', workMode: 'code' });
    const base = { outputStyle: 'verbose', workMode: 'code' };
    await updateZaiSettings({ workMode: 'office' }); // 抽屉改了 workMode
    await writeConfig('zai', { outputStyle: 'compact', workMode: 'code' }, base);
    const disk = await diskOf(zaiSettingsPath());
    expect(disk.outputStyle).toBe('compact'); // 用户改的 → 生效
    expect(disk.workMode).toBe('office');     // 用户没改的 → 保留抽屉的
  });

  it('用户在编辑器里删掉的键会被真的删掉(浅合并表达不了删除)', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ outputStyle: 'verbose', workMode: 'office' });
    const base = { outputStyle: 'verbose', workMode: 'office' };
    const edited: Record<string, unknown> = { outputStyle: 'verbose' }; // 用户删了 workMode
    await writeConfig('zai', edited, base);
    const disk = await diskOf(zaiSettingsPath());
    expect(disk.workMode).toBeUndefined();
    expect(disk.outputStyle).toBe('verbose');
  });

  it('用户新增的键写入;别人在打开之后新增的键不回滚', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ outputStyle: 'verbose' });
    const base = { outputStyle: 'verbose' };
    await updateZaiSettings({ addedLater: 'by-someone-else' });
    await writeConfig('zai', { outputStyle: 'verbose', mine: 'new' }, base);
    const disk = await diskOf(zaiSettingsPath());
    expect(disk.mine).toBe('new');
    expect(disk.addedLater).toBe('by-someone-else');
  });

  it('嵌套对象整体未动 → 保留磁盘现值;整体动过 → 写入', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ weixinBot: { enabled: true, model: 'a' } } as never);
    const base = { weixinBot: { enabled: true, model: 'a' } };
    await updateZaiSettings({ weixinBot: { enabled: true, model: 'b' } } as never);
    // 用户没动 weixinBot → 抽屉的 model:'b' 保留
    await writeConfig('zai', { weixinBot: { enabled: true, model: 'a' } }, base);
    expect(((await diskOf(zaiSettingsPath())).weixinBot as { model: string }).model).toBe('b');
    // 用户把整个块换成别的 → 写入
    await writeConfig('zai', { weixinBot: { enabled: false, model: 'a' } }, base);
    expect(((await diskOf(zaiSettingsPath())).weixinBot as { enabled: boolean }).enabled).toBe(false);
  });

  it('键序不同但值相同 → 视为用户没动(稳定序列化)', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ outputStyle: 'verbose', workMode: 'office' });
    const base = { outputStyle: 'verbose', workMode: 'office' };
    await updateZaiSettings({ workMode: 'general' });
    await writeConfig('zai', { workMode: 'office', outputStyle: 'verbose' }, base); // 同键不同序
    expect((await diskOf(zaiSettingsPath())).workMode).toBe('general');
  });

  it('不带 base 的旧客户端仍走两路浅合并(向后兼容)', async () => {
    const { updateZaiSettings, zaiSettingsPath } = await freshZai();
    await updateZaiSettings({ keepMe: 'yes' });
    await writeConfig('zai', { other: 'x' }); // 无 base
    const disk = await diskOf(zaiSettingsPath());
    expect(disk.keepMe).toBe('yes');
    expect(disk.other).toBe('x');
  });
});
