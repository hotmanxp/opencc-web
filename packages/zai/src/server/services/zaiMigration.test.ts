import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runClaudeToZaiMigration,
  type MigrationResult,
} from './zaiMigration.js';

/**
 * Tests for the boot-time ~/.claude → ~/.zai migration.
 *
 * Each test runs in a fresh `mkdtempSync` directory so a buggy test
 * can't pollute sibling tests or the user's real ~/.zai. The migration
 * accepts `home` / `zaiDir` / `claudeDir` overrides specifically so we
 * don't have to mock `homedir()`.
 *
 * `ZAI_DATA_DIR` is unset/reset in `beforeEach` so the env-var guard
 * test can flip it on and other tests aren't affected by a leftover.
 */

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-migration-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, obj: unknown): void {
  mkdirSync(dirnameOf(dir, name), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(obj), 'utf-8');
}

function writeText(dir: string, name: string, text: string): void {
  mkdirSync(dirnameOf(dir, name), { recursive: true });
  writeFileSync(join(dir, name), text, 'utf-8');
}

function dirnameOf(dir: string, name: string): string {
  // strip basename → dirname (path.dirname doesn't like relative segments)
  const ix = name.lastIndexOf('/');
  return ix === -1 ? dir : join(dir, name.slice(0, ix));
}

function readJson<T = unknown>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')) as T;
}

let home = '';
let zaiDir = '';
let claudeDir = '';

beforeEach(() => {
  home = makeTempHome();
  zaiDir = join(home, '.zai');
  claudeDir = join(home, '.claude');
  delete process.env.ZAI_DATA_DIR;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

describe('runClaudeToZaiMigration', () => {
  it('skips when ~/.claude does not exist', async () => {
    // no claudeDir created
    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    expect(r.skippedReason).toBe('no-claude-dir');
    expect(r.copied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(existsSync(join(zaiDir, '.claude-migration-v1.json'))).toBe(false);
  });

  it('skips when ZAI_DATA_DIR is set', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"model":"from-claude"}');
    process.env.ZAI_DATA_DIR = '/some/custom/path';

    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    expect(r.skippedReason).toBe('custom-data-dir');
    expect(r.copied).toEqual([]);
    // Even though ~/.claude had data, we did NOT touch ~/.zai.
    expect(existsSync(join(zaiDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(zaiDir, '.claude-migration-v1.json'))).toBe(false);
  });

  it('skips when sentinel already exists', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"model":"from-claude"}');
    mkdirSync(zaiDir, { recursive: true });
    writeFileSync(
      join(zaiDir, '.claude-migration-v1.json'),
      JSON.stringify({ version: 1, migratedAt: 'past' }),
      'utf-8',
    );

    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    expect(r.skippedReason).toBe('already-migrated');
    expect(r.copied).toEqual([]);
    // Did NOT copy even though source exists.
    expect(existsSync(join(zaiDir, 'settings.json'))).toBe(false);
  });

  it('copies all 7 resources when ~/.zai is empty', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"model":"from-claude"}');
    writeJson(home, '.claude.json', { enabledPlugins: { x: true } });
    writeText(claudeDir, 'agents/foo.md', '# agent');
    writeText(claudeDir, 'commands/bar.md', '# cmd');
    writeText(claudeDir, 'plugins/installed_plugins.json', '{}');
    writeText(claudeDir, 'skills/baz/SKILL.md', '# skill');
    writeText(claudeDir, 'output-styles/compact.md', '# style');

    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    expect(r.skippedReason).toBeUndefined();
    expect(r.copied).toEqual(
      expect.arrayContaining([
        join(zaiDir, 'settings.json'),
        join(home, '.zai.json'),
        join(zaiDir, 'agents'),
        join(zaiDir, 'commands'),
        join(zaiDir, 'plugins'),
        join(zaiDir, 'skills'),
        join(zaiDir, 'output-styles'),
      ]),
    );
    expect(r.copied).toHaveLength(7);
    expect(r.errors).toEqual([]);

    // Files copied correctly
    expect(readJson(join(zaiDir), 'settings.json')).toEqual({ model: 'from-claude' });
    expect(readJson(home, '.zai.json')).toEqual({ enabledPlugins: { x: true } });
    expect(readFileSync(join(zaiDir, 'agents/foo.md'), 'utf-8')).toBe('# agent');
    expect(readFileSync(join(zaiDir, 'skills/baz/SKILL.md'), 'utf-8')).toBe('# skill');

    // Sentinel written with v1 + full payload
    const sentinel = readJson<{ version: number; copied: string[]; errors: unknown[] }>(
      zaiDir,
      '.claude-migration-v1.json',
    );
    expect(sentinel.version).toBe(1);
    expect(sentinel.copied.length).toBe(7);
    expect(sentinel.errors).toEqual([]);
  });

  it('copies only missing resources when partial', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"from":"claude"}');
    writeText(claudeDir, 'agents/foo.md', '# claude agent');
    writeText(claudeDir, 'commands/bar.md', '# claude cmd');
    writeText(claudeDir, 'skills/baz/SKILL.md', '# claude skill');
    writeJson(home, '.claude.json', { enabledPlugins: { y: true } });
    writeText(claudeDir, 'plugins/installed_plugins.json', '{}');
    writeText(claudeDir, 'output-styles/compact.md', '# style');

    // Pre-populate ~/.zai/settings.json — should NOT be overwritten
    mkdirSync(zaiDir, { recursive: true });
    writeText(zaiDir, 'settings.json', '{"from":"zai"}');

    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    // settings.json skipped (dest exists), other 6 copied
    expect(r.skipped).toEqual([
      { path: join(zaiDir, 'settings.json'), reason: 'dest-exists' },
    ]);
    expect(r.copied).toEqual(
      expect.arrayContaining([
        join(home, '.zai.json'),
        join(zaiDir, 'agents'),
        join(zaiDir, 'commands'),
        join(zaiDir, 'plugins'),
        join(zaiDir, 'skills'),
        join(zaiDir, 'output-styles'),
      ]),
    );
    expect(r.copied).toHaveLength(6);

    // Pre-existing settings.json content preserved (no overwrite)
    expect(readJson(zaiDir, 'settings.json')).toEqual({ from: 'zai' });
    // Newly-copied resources have claude content
    expect(readFileSync(join(zaiDir, 'agents/foo.md'), 'utf-8')).toBe('# claude agent');
    expect(readJson(home, '.zai.json')).toEqual({ enabledPlugins: { y: true } });
  });

  it('records no-source when source is missing', async () => {
    mkdirSync(claudeDir, { recursive: true });
    // Only settings.json exists in ~/.claude
    writeText(claudeDir, 'settings.json', '{"from":"claude"}');

    const r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });

    expect(r.copied).toEqual([join(zaiDir, 'settings.json')]);
    expect(
      r.skipped.filter((s) => s.reason === 'no-source').map((s) => s.path),
    ).toEqual(
      expect.arrayContaining([
        join(home, '.zai.json'),
        join(zaiDir, 'agents'),
        join(zaiDir, 'commands'),
        join(zaiDir, 'plugins'),
        join(zaiDir, 'skills'),
        join(zaiDir, 'output-styles'),
      ]),
    );
  });

  it('isolates per-resource errors and still writes sentinel', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"from":"claude"}');
    writeText(claudeDir, 'agents/foo.md', '# agent');

    // Make settings.json source unreadable to trigger a copy error.
    // Use chmod 000 — works on macOS for read denial.
    chmodSync(join(claudeDir, 'settings.json'), 0o000);

    let r: MigrationResult;
    try {
      r = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });
    } finally {
      // Always restore permissions so rmSync in afterEach can clean up.
      chmodSync(join(claudeDir, 'settings.json'), 0o644);
    }

    // settings.json failed, agents/ succeeded
    expect(r.copied).toEqual([join(zaiDir, 'agents')]);
    expect(r.errors).toEqual([
      expect.objectContaining({ path: join(zaiDir, 'settings.json') }),
    ]);

    // agents/ WAS copied despite sibling failure
    expect(readFileSync(join(zaiDir, 'agents/foo.md'), 'utf-8')).toBe('# agent');

    // Sentinel still written — we don't want every boot to retry
    // a permissions error we already know about.
    const sentinelPath = join(zaiDir, '.claude-migration-v1.json');
    expect(existsSync(sentinelPath)).toBe(true);
    const sentinel = readJson<{ errors: unknown[] }>(zaiDir, '.claude-migration-v1.json');
    expect(sentinel.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent across runs', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeText(claudeDir, 'settings.json', '{"from":"claude"}');
    writeText(claudeDir, 'agents/foo.md', '# agent');

    const r1 = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });
    expect(r1.copied.length).toBeGreaterThan(0);
    expect(r1.skippedReason).toBeUndefined();

    const sentinelStat1 = statSync(join(zaiDir, '.claude-migration-v1.json'));

    // Second run: sentinel exists, so we short-circuit.
    const r2 = await runClaudeToZaiMigration({ home, zaiDir, claudeDir });
    expect(r2.skippedReason).toBe('already-migrated');
    expect(r2.copied).toEqual([]);

    // Sentinel unchanged (no rewrite on the no-op path).
    const sentinelStat2 = statSync(join(zaiDir, '.claude-migration-v1.json'));
    expect(sentinelStat2.mtimeMs).toBe(sentinelStat1.mtimeMs);

    // Files from first run still intact.
    expect(readJson(zaiDir, 'settings.json')).toEqual({ from: 'claude' });
  });
});
