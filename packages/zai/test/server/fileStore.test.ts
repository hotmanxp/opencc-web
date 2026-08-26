import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readConfig,
  writeConfig,
  readAgentsMd,
  writeAgentsMd,
} from '../../src/server/services/fileStore.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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