import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One-shot boot-time migration: copies user data from `~/.claude/` (and
 * `~/.claude.json`) to `~/.zai/` (and `~/.zai.json`) on first zai start,
 * so a user upgrading from upstream claude-code keeps their settings,
 * agents, commands, plugins, skills, and output styles without manual
 * copying. A sentinel file (`~/.zai/.claude-migration-v1.json`) prevents
 * the migration from running on subsequent boots.
 *
 * Rules:
 *   - Skip if `ZAI_DATA_DIR` is set (user has a custom data dir).
 *   - Skip if `~/.claude/` doesn't exist.
 *   - Skip if sentinel exists.
 *   - For each entry: copy if source exists AND dest is missing. Never
 *     overwrite — a present dest means "user already settled this in zai".
 *   - Per-entry errors are isolated (caught + recorded). The migration
 *     itself never throws — boot must not be derailed by a permission
 *     hiccup on one resource.
 *
 * Resources covered:
 *   - `~/.claude/settings.json`     → `~/.zai/settings.json`
 *   - `~/.claude.json`              → `~/.zai.json`
 *   - `~/.claude/agents/`           → `~/.zai/agents/`
 *   - `~/.claude/commands/`         → `~/.zai/commands/`
 *   - `~/.claude/plugins/`          → `~/.zai/plugins/`
 *   - `~/.claude/skills/`           → `~/.zai/skills/`
 *   - `~/.claude/output-styles/`    → `~/.zai/output-styles/`
 *
 * Out of scope (intentionally):
 *   - `~/.claude/projects/<sid>` transcripts — too large, user explicitly
 *     opted to skip. New sessions land in `~/.zai/projects/<sid>`.
 *   - Third-party caches (`~/.claude/.playwright-mcp/` etc.) — vendor
 *     never reads them, no point copying.
 */

const SENTINEL_FILENAME = '.claude-migration-v1.json';

type EntryType = 'file' | 'dir';

interface MigrationEntry {
  source: string;
  dest: string;
  type: EntryType;
  /** Short label used in logs and the sentinel payload. */
  label: string;
}

export type SkippedResource = {
  path: string;
  reason: 'no-source' | 'dest-exists';
};

export type MigrationError = {
  path: string;
  error: string;
};

export type MigrationResult = {
  copied: string[];
  skipped: SkippedResource[];
  errors: MigrationError[];
  /**
   * Set when the whole migration short-circuited before touching any
   * entry. Mutually exclusive with non-empty `copied`/`skipped`/`errors`.
   */
  skippedReason?: 'no-claude-dir' | 'already-migrated' | 'custom-data-dir';
};

export type RunMigrationOptions = {
  /** Override `homedir()` for testing. */
  home?: string;
  /** Override `~/.zai` for testing. */
  zaiDir?: string;
  /** Override `~/.claude` for testing. */
  claudeDir?: string;
};

/**
 * Build the (source, dest) entry list from a resolved home + base dirs.
 * Centralized so tests can read what would run without invoking the
 * migration.
 */
function buildEntries(home: string, zaiDir: string, claudeDir: string): MigrationEntry[] {
  return [
    {
      source: join(claudeDir, 'settings.json'),
      dest: join(zaiDir, 'settings.json'),
      type: 'file',
      label: 'settings.json',
    },
    {
      source: join(home, '.claude.json'),
      dest: join(home, '.zai.json'),
      type: 'file',
      label: '.zai.json',
    },
    {
      source: join(claudeDir, 'agents'),
      dest: join(zaiDir, 'agents'),
      type: 'dir',
      label: 'agents/',
    },
    {
      source: join(claudeDir, 'commands'),
      dest: join(zaiDir, 'commands'),
      type: 'dir',
      label: 'commands/',
    },
    {
      source: join(claudeDir, 'plugins'),
      dest: join(zaiDir, 'plugins'),
      type: 'dir',
      label: 'plugins/',
    },
    {
      source: join(claudeDir, 'skills'),
      dest: join(zaiDir, 'skills'),
      type: 'dir',
      label: 'skills/',
    },
    {
      source: join(claudeDir, 'output-styles'),
      dest: join(zaiDir, 'output-styles'),
      type: 'dir',
      label: 'output-styles/',
    },
  ];
}

/**
 * Recursive directory copy. Skips devices/sockets/fifos (we only know
 * how to copy regular files and symlinks). Symlinks are copied as the
 * link itself, not the target — preserves whatever the user wired up
 * (e.g. a plugin cache symlink).
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await copyFile(s, d);
    }
    // device/socket/fifo — silently skip. They'd just fail later anyway.
  }
}

/**
 * Run the migration. Always resolves; never throws. The caller (boot
 * hook) can safely `.catch(console.warn)` and continue.
 *
 * @param opts - Test-only path overrides; production callers omit this.
 */
export async function runClaudeToZaiMigration(
  opts: RunMigrationOptions = {},
): Promise<MigrationResult> {
  const emptyResult: MigrationResult = {
    copied: [],
    skipped: [],
    errors: [],
  };

  // Guard 1: user has a custom data dir. They opted out of ~/.zai/,
  // so we MUST NOT touch their setup.
  if (process.env.ZAI_DATA_DIR) {
    return { ...emptyResult, skippedReason: 'custom-data-dir' };
  }

  const home = opts.home ?? homedir();
  const zaiDir = opts.zaiDir ?? join(home, '.zai');
  const claudeDir = opts.claudeDir ?? join(home, '.claude');

  // Guard 2: nothing to migrate from.
  if (!existsSync(claudeDir)) {
    return { ...emptyResult, skippedReason: 'no-claude-dir' };
  }

  // Guard 3: already migrated on a prior boot.
  const sentinelPath = join(zaiDir, SENTINEL_FILENAME);
  if (existsSync(sentinelPath)) {
    return { ...emptyResult, skippedReason: 'already-migrated' };
  }

  const entries = buildEntries(home, zaiDir, claudeDir);
  const result: MigrationResult = { copied: [], skipped: [], errors: [] };

  for (const entry of entries) {
    if (!existsSync(entry.source)) {
      result.skipped.push({ path: entry.dest, reason: 'no-source' });
      continue;
    }
    if (existsSync(entry.dest)) {
      // User already has data here — never overwrite. They may have
      // customized things in zai before the migration ran.
      result.skipped.push({ path: entry.dest, reason: 'dest-exists' });
      continue;
    }
    try {
      await mkdir(dirname(entry.dest), { recursive: true });
      if (entry.type === 'file') {
        await copyFile(entry.source, entry.dest);
      } else {
        await copyDir(entry.source, entry.dest);
      }
      result.copied.push(entry.dest);
    } catch (err) {
      result.errors.push({ path: entry.dest, error: (err as Error).message });
    }
  }

  // Write sentinel AFTER the loop. Even if some entries errored, we
  // still write the sentinel so the boot doesn't keep retrying the
  // same failures on every restart. The errors[] field in the sentinel
  // records what didn't migrate.
  try {
    await mkdir(zaiDir, { recursive: true });
    await writeFile(
      sentinelPath,
      JSON.stringify(
        {
          version: 1,
          migratedAt: new Date().toISOString(),
          sourceHome: home,
          copied: result.copied,
          skipped: result.skipped,
          errors: result.errors,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch (err) {
    // Sentinel write failure means we'll re-run next boot. Not fatal;
    // log it via the caller's `.catch` (we still return cleanly).
    result.errors.push({
      path: sentinelPath,
      error: `sentinel write failed: ${(err as Error).message}`,
    });
  }

  return result;
}
