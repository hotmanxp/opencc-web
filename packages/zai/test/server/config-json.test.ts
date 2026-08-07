import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTopLevelJson,
  writeTopLevelJson,
} from '../../src/server/services/fileStore.js';

// ~/.claude.json / ~/.claude/settings.json 顶层 JSON 配置的 read/write 服务测试。
// 沿用 fileStore.test.ts 的 HOME-override 模式:把 process.env.HOME
// 指向临时目录,确保不会污染真实的 ~/.claude.json / ~/.claude/settings.json。

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-config-json-test-'));
  process.env.HOME = tempHome;
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('readTopLevelJson', () => {
  it('returns missing:true when ~/.claude.json does not exist', async () => {
    const result = await readTopLevelJson('claude-json');
    expect(result.exists).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.path).toBe(join(tempHome, '.claude.json'));
  });

  it('returns missing:true when ~/.claude/settings.json does not exist', async () => {
    const result = await readTopLevelJson('claude-settings');
    expect(result.exists).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.path).toBe(join(tempHome, '.claude', 'settings.json'));
  });
});

describe('writeTopLevelJson + readTopLevelJson roundtrip', () => {
  it('writes and reads back ~/.claude.json atomically', async () => {
    const content = { providerProfiles: [{ name: 'test', provider: 'openai' }] };
    await writeTopLevelJson('claude-json', content);
    const result = await readTopLevelJson('claude-json');
    expect(result.exists).toBe(true);
    expect(result.content).toEqual(content);
    // 原子写:tmp 文件不应残留
    expect(existsSync(result.path + '.tmp')).toBe(false);
    // 落盘内容是格式化后的 JSON,直接读盘确认
    expect(JSON.parse(readFileSync(result.path, 'utf-8'))).toEqual(content);
  });

  it('writes and reads back ~/.claude/settings.json atomically', async () => {
    const content = { permissions: { defaultMode: 'bypassPermissions' } };
    await writeTopLevelJson('claude-settings', content);
    const result = await readTopLevelJson('claude-settings');
    expect(result.exists).toBe(true);
    expect(result.content).toEqual(content);
    expect(existsSync(result.path + '.tmp')).toBe(false);
    expect(JSON.parse(readFileSync(result.path, 'utf-8'))).toEqual(content);
  });

  it('preserves unknown keys on rewrite (no field filtering)', async () => {
    // 关键不变式:写入不应剥离任何字段,以保持与现有 ConfigFile 形状兼容。
    const content = { customField: 'kept', nested: { a: 1 } };
    await writeTopLevelJson('claude-json', content);
    await writeTopLevelJson('claude-json', { ...content, added: true });
    const result = await readTopLevelJson('claude-json');
    expect(result.content).toEqual({ ...content, added: true });
  });
});

describe('test isolation guard', () => {
  it('HOME is overridden to a temp dir, not the real $HOME', () => {
    expect(process.env.HOME).toBe(tempHome);
    expect(process.env.HOME).not.toBe(ORIGINAL_HOME);
  });
});