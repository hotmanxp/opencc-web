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
    // it would only get added when opencode, opencc, OR zai is detected.
    expect(dirs).not.toContain(join(work, '.agents', 'skills'));
  });
});

/**
 * Regression: a `zai/<name>` agent must land under `~/.zai/agents/`,
 * not under any other platform's tree. Mirrors the same name-prefix
 * filter the rest of the matrix already uses for nova/opencode/opencc.
 */
describe('install + targetDirsForType parity on a zai-only box', () => {
  let work: string;
  let fakeCache: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'zai-zaionly-'));
    fakeCache = join(work, 'cache', 'v1.2.3');
    // Cache a `zai/foo` agent so installFromCache has something to copy.
    mkdirSync(join(fakeCache, 'agents', 'zai'), { recursive: true });
    writeFileSync(join(fakeCache, 'agents', 'zai', 'foo.md'), '# foo', 'utf-8');
    // Also stash a top-level skill so the skills branch is covered.
    mkdirSync(join(fakeCache, 'skills', 'bar'), { recursive: true });
    writeFileSync(join(fakeCache, 'skills', 'bar', 'SKILL.md'), '# bar', 'utf-8');

    // Only `~/.zai` exists on this fake HOME — no nova/opencode/claude.
    // targetDirsForType gates each platform on existsSync on those dirs,
    // so this isolates the zai branch.
    mkdirSync(join(work, '.zai'), { recursive: true });

    vi.doMock('../../src/server/services/extractor.js', () => ({
      resolveResourcePath: (_v: string, type: string, name: string) => {
        // Mirror the real extractor: nested names like "zai/foo" live at
        // <type>/<platform>/<name-without-platform-prefix>.
        const slash = name.indexOf('/');
        if (slash >= 0) {
          const col = name.slice(0, slash);
          const leaf = name.slice(slash + 1);
          return join(fakeCache, type, col, `${leaf}.md`);
        }
        return join(fakeCache, type, name);
      },
      listCollectionResourcePaths: () => [],
    }));

    // HOME must be set before the dynamic import — install.ts computes
    // its path constants from homedir() at module load.
    process.env.HOME = work;
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    vi.doUnmock('../../src/server/services/extractor.js');
    vi.resetModules();
    process.env.HOME = origHome;
  });

  it('zai/<name> agent lands at ~/.zai/agents/foo.md and nowhere else', async () => {
    const { installFromCache, targetDirsForType } = await import(
      '../../src/server/services/install.js'
    );

    const result = installFromCache({
      type: 'agents',
      name: 'zai/foo',
      version: 'v1.2.3',
    });

    // Written under zai's own tree.
    expect(existsSync(join(work, '.zai', 'agents', 'foo.md'))).toBe(true);

    // And NOT under any other platform — `zai/foo` is a platform-prefixed
    // name, so filterTargetsForResource keeps only platform==='zai'.
    expect(result.platforms).toEqual(['zai']);
    expect(result.targetPaths).toEqual([
      join(work, '.zai', 'agents', 'foo.md'),
    ]);
  });

  it('zai is present in targetDirsForType(agents) and lives at ~/.zai/', async () => {
    const { targetDirsForType } = await import(
      '../../src/server/services/install.js'
    );

    const dirs = targetDirsForType('agents').map((p) => p.target);
    expect(dirs).toContain(join(work, '.zai', 'agents'));
    // On a zai-only box, none of the other platforms should sneak in.
    expect(dirs).not.toContain(join(work, '.nova', 'agents'));
    expect(dirs).not.toContain(join(work, '.config', 'opencode', 'agents'));
    expect(dirs).not.toContain(join(work, '.claude', 'agents'));
  });

  it('skill on a zai-only box lands at ~/.agents/skills/', async () => {
    const { installFromCache, targetDirsForType } = await import(
      '../../src/server/services/install.js'
    );

    installFromCache({ type: 'skills', name: 'bar', version: 'v1.2.3' });

    expect(
      existsSync(join(work, '.agents', 'skills', 'bar')),
      'skill merged into ~/.agents/skills/bar',
    ).toBe(true);

    // The shared skills dir appears in the platform list as 'opencode'
    // (the designated platform key for the shared tree), even when the
    // only detected trigger is ZAI_DIR — matching the OPENCC/OpenCode
    // parity rule.
    const dirs = targetDirsForType('skills').map((p) => p.target);
    expect(dirs).toContain(join(work, '.agents', 'skills'));
  });
});

/**
 * Regression: OPENCC platform now writes to ~/.claude/, distinct from
 * zai's ~/.zai/. Make sure an opencc/<name> agent lands under ~/.claude
 * on an OpenCC-only box so neither tree pollutes the other.
 */
describe('install + targetDirsForType parity on an opencc-only box', () => {
  let work: string;
  let fakeCache: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'zai-openconly-'));
    fakeCache = join(work, 'cache', 'v1.2.3');
    mkdirSync(join(fakeCache, 'agents', 'opencc'), { recursive: true });
    writeFileSync(join(fakeCache, 'agents', 'opencc', 'bar.md'), '# bar', 'utf-8');

    mkdirSync(join(work, '.claude'), { recursive: true });

    vi.doMock('../../src/server/services/extractor.js', () => ({
      resolveResourcePath: (_v: string, type: string, name: string) => {
        const slash = name.indexOf('/');
        if (slash >= 0) {
          const col = name.slice(0, slash);
          const leaf = name.slice(slash + 1);
          return join(fakeCache, type, col, `${leaf}.md`);
        }
        return join(fakeCache, type, name);
      },
      listCollectionResourcePaths: () => [],
    }));

    process.env.HOME = work;
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    vi.doUnmock('../../src/server/services/extractor.js');
    vi.resetModules();
    process.env.HOME = origHome;
  });

  it('opencc/<name> agent lands at ~/.claude/agents/bar.md', async () => {
    const { installFromCache } = await import(
      '../../src/server/services/install.js'
    );

    const result = installFromCache({
      type: 'agents',
      name: 'opencc/bar',
      version: 'v1.2.3',
    });

    expect(existsSync(join(work, '.claude', 'agents', 'bar.md'))).toBe(true);
    // Must NOT have crossed over into the zai tree.
    expect(existsSync(join(work, '.zai', 'agents', 'bar.md'))).toBe(false);

    expect(result.platforms).toEqual(['opencc']);
  });
});