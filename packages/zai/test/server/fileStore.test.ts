import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/server/services/fileStore.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
let tempHome: string;

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'zai-test-'));
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, '.nova'), { recursive: true });
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
