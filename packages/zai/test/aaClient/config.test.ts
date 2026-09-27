/**
 * Tests for AA config load/write + schema validation.
 *
 * Run with: bun test (vitest is invoked via the `test` script in package.json).
 *
 * Per the project convention (see test/setup.isolation.ts), ZAI_DATA_DIR is
 * overridden per test via process.env so writes don't touch the real
 * `~/.zai/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-cfg-'));
  process.env.ZAI_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('aaClient/config', () => {
  it('readAaConfig returns null when file missing', async () => {
    const { readAaConfig } = await import('../../src/server/services/aaClient/config.js');
    expect(await readAaConfig()).toBeNull();
  });

  it('round-trips a valid config', async () => {
    const { buildAaConfigFromPairing, readAaConfig, writeAaConfig } = await import(
      '../../src/server/services/aaClient/config.js'
    );
    const config = buildAaConfigFromPairing({
      serverUrl: 'https://web.agents-anywhere.com',
      connectorId: 'conn_ABC123xyz',
      connectorToken: 'cxt_test-token-value',
      connectorName: 'zai Mac',
    });
    await writeAaConfig(config);
    const loaded = await readAaConfig();
    expect(loaded).toEqual(config);
  });

  it('rejects invalid serverUrl', async () => {
    const { AaConfigSchema } = await import('../../src/server/services/aaClient/config.js');
    const result = AaConfigSchema.safeParse({
      serverUrl: 'not-a-url',
      connectorId: 'conn_ABC',
      connectorToken: 'cxt_TKN',
      connectorName: 'x',
      pairedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid connectorId format', async () => {
    const { AaConfigSchema } = await import('../../src/server/services/aaClient/config.js');
    const result = AaConfigSchema.safeParse({
      serverUrl: 'https://x.example.com',
      connectorId: 'not_conn_prefixed',
      connectorToken: 'cxt_TKN',
      connectorName: 'x',
      pairedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid connectorToken format', async () => {
    const { AaConfigSchema } = await import('../../src/server/services/aaClient/config.js');
    const result = AaConfigSchema.safeParse({
      serverUrl: 'https://x.example.com',
      connectorId: 'conn_ABC',
      connectorToken: 'wrong_prefix',
      connectorName: 'x',
      pairedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('strips trailing slash on serverUrl', async () => {
    const { buildAaConfigFromPairing } = await import('../../src/server/services/aaClient/config.js');
    const config = buildAaConfigFromPairing({
      serverUrl: 'https://web.agents-anywhere.com/',
      connectorId: 'conn_ABC',
      connectorToken: 'cxt_TKN',
      connectorName: 'x',
    });
    expect(config.serverUrl).toBe('https://web.agents-anywhere.com');
  });

  it('readAaConfig throws on malformed JSON', async () => {
    const { ensureAaDir } = await import('../../src/server/services/paths.js');
    const { readAaConfig } = await import('../../src/server/services/aaClient/config.js');
    const { writeFile } = await import('node:fs/promises');
    await ensureAaDir();
    await writeFile(join(dataDir, 'aa', 'config.json'), '{not json', 'utf-8');
    await expect(readAaConfig()).rejects.toThrow(/not valid JSON/);
  });

  it('writeAaConfigQueued serializes concurrent writes', async () => {
    const { buildAaConfigFromPairing, readAaConfig, writeAaConfigQueued } = await import(
      '../../src/server/services/aaClient/config.js'
    );
    const baseConfig = buildAaConfigFromPairing({
      serverUrl: 'https://x.example.com',
      connectorId: 'conn_ABC',
      connectorToken: 'cxt_TKN',
      connectorName: 'x',
    });
    // Fire 5 concurrent writes with different pairedAt; final state should be one of them, not partial.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        writeAaConfigQueued({ ...baseConfig, pairedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    );
    const loaded = await readAaConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.pairedAt).toMatch(/^2026-01-0[1-5]T/);
  });
});
