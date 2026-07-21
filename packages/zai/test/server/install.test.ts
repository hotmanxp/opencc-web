import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression: installFromCache used to skip `mkdirSync(target)` for
 * directory resources and rely on DirectoryMerger to create the
 * destination. DirectoryMerger only creates intermediate sub-dirs
 * on demand, so when the target dir (e.g. ~/.nova/skills/<name>/)
 * was entirely missing, the very first file copy threw ENOENT and
 * the SSE stream emitted "merging..." before crashing — the UI
 * showed a misleading success hint without surfacing the failure.
 *
 * The fix: install.ts now calls `mkdirSync(target, { recursive: true })`
 * unconditionally for every target before delegating to DirectoryMerger
 * or copyFileSync.
 */
describe('install.ts source guards', () => {
  it('creates the destination directory for every target before merging/copying', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../src/server/services/install.ts'),
      'utf-8',
    );
    const loopMatch = src.match(/for \(const t of targets\) \{[\s\S]*?\n  \}/);
    expect(loopMatch, 'install loop should be found').toBeTruthy();
    const loop = loopMatch![0];

    expect(loop).toMatch(/mkdirSync\(target,\s*\{\s*recursive:\s*true\s*\}\)/);
    expect(loop).toMatch(/DirectoryMerger/);
  });
});

/**
 * Regression: `installDirsForType` in routes/resources.ts used to
 * hard-code `[globalSkills]` for skills — never checking
 * `~/.nova/skills`. So on a Nova-only box (no ~/.config/opencode or
 * ~/.claude), `install` wrote to `~/.nova/skills` but `isInstalled`
 * returned false → "installed but UI says not installed" drift.
 *
 * The fix: both files now share `targetDirsForType` from install.ts.
 */
describe('install.ts + resources.ts share target resolution', () => {
  it('resources.ts imports targetDirsForType from install.ts (no inline duplicate)', () => {
    const res = readFileSync(
      join(import.meta.dirname, '../../src/server/routes/resources.ts'),
      'utf-8',
    );
    // The fix removed the inline skills/[globalSkills] hard-code.
    expect(res).not.toMatch(/skills:\s*\[globalSkills\]/);
    // And it imports targetDirsForType from install.
    expect(res).toMatch(/import\s*\{[^}]*targetDirsForType[^}]*\}\s*from\s*['"]\.\.\/services\/install\.js['"]/);
  });
});

/**
 * End-to-end regression on a Nova-only environment (HOME contains
 * ~/.nova but no ~/.config/opencode / ~/.claude):
 *   - install writes to ~/.nova/skills/<name>/
 *   - isInstalled must look at ~/.nova/skills/<name>/
 */
describe('install + isInstalled parity on a Nova-only box', () => {
  let work: string;
  let fakeCache: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'zai-novaonly-'));
    fakeCache = join(work, 'cache', 'v1.2.3');
    mkdirSync(join(fakeCache, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(fakeCache, 'skills', 'foo', 'SKILL.md'), '# foo', 'utf-8');

    // install.ts's targetDirsForType gates each platform on
    // existsSync(NOVA_DIR/OPENCODE_DIR/OPENCC_DIR). For a Nova-only
    // environment we need ~/.nova to actually exist so the nova
    // target is added. (No opencode/opencc on this fake HOME.)
    mkdirSync(join(work, '.nova'), { recursive: true });

    // Stub the extractor to point at our fake cache.
    vi.doMock('../../src/server/services/extractor.js', () => ({
      resolveResourcePath: (_v: string, _t: string, name: string) =>
        join(fakeCache, 'skills', name),
      listCollectionResourcePaths: () => [],
    }));

    // HOME = work (which contains ONLY ~/.nova; no opencode/opencc).
    // install.ts's NOVA_DIR is computed at module load from homedir(),
    // so HOME must be set BEFORE dynamic import.
    process.env.HOME = work;
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    vi.doUnmock('../../src/server/services/extractor.js');
    vi.resetModules();
    process.env.HOME = origHome;
  });

  it('install + targetDirsForType agree on ~/.nova/skills', async () => {
    const { installFromCache, targetDirsForType } = await import(
      '../../src/server/services/install.js'
    );

    installFromCache({ type: 'skills', name: 'foo', version: 'v1.2.3' });

    // The actual install landing zone.
    const novaSkillsFoo = join(work, '.nova', 'skills', 'foo');
    expect(existsSync(novaSkillsFoo), 'install wrote to ~/.nova/skills/foo').toBe(true);

    // The list/isInstalled check must now also look there.
    const dirs = targetDirsForType('skills').map((p) => p.target);
    expect(dirs).toContain(join(work, '.nova', 'skills'));
    // And on a Nova-only box, ~/.agents/skills must NOT be in the list —
    // it would only get added when opencode OR opencc is detected.
    expect(dirs).not.toContain(join(work, '.agents', 'skills'));
  });
});