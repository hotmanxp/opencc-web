import { Router, type IRouter } from 'express';
import { readdir, access, stat, readFile } from 'node:fs/promises';
import { join, resolve, sep, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { DirectoryStatus, DirInfo, FileCount } from '../../shared/types.js';

const router: IRouter = Router();

async function countDir(path: string): Promise<FileCount> {
  try {
    const items = await readdir(path);
    return { count: items.length, items };
  } catch {
    return { count: 0, items: [] };
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildDirInfo(basePath: string): Promise<DirInfo> {
  const exists = await dirExists(basePath);
  return {
    path: basePath,
    exists,
    agents: await countDir(join(basePath, 'agents')),
    commands: await countDir(join(basePath, 'commands')),
    skills: await countDir(join(basePath, 'skills')),
    extensions: await countDir(join(basePath, 'extensions')),
  };
}

router.get('/dirs', async (_req, res) => {
  try {
    const home = homedir();
    const status: DirectoryStatus = {
      nova: await buildDirInfo(join(home, '.nova')),
      opencode: await buildDirInfo(join(home, '.config', 'opencode')),
      opencc: await buildDirInfo(join(home, '.claude')),
      globalSkills: await buildDirInfo(join(home, '.agents', 'skills')),
    };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- File preview (read-only) ---------------------------------------------
//
// Directory tree rows are top-level platform dirs (e.g. ~/.nova); each row
// contains agents/commands/skills/extensions sub-trees. The frontend
// re-uses the absolute path from /api/dirs as the Tree node key, so the
// file path we receive here is e.g. ~/.nova/agents/foo/AGENTS.md.
//
// To keep this endpoint safe we:
//   1. Whitelist the platform roots (only directories we own).
//   2. Require the path to live inside one of those roots, not above.
//   3. Require the second segment to be a resource sub-dir (agents /
//      commands / skills / extensions) — keeps the preview button scoped
//      to resource files, no random $HOME/* browsing.
//   4. Enforce a hard size cap and only serve known text extensions, so
//      we never dump binaries into the UI.

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

function platformRoots(): string[] {
  const home = homedir();
  return [
    join(home, '.nova'),
    join(home, '.config', 'opencode'),
    join(home, '.claude'),
    join(home, '.agents', 'skills'),
  ].map((p) => resolve(p));
}

router.get('/dirs/file', async (req, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  if (!raw) {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }

  const abs = resolve(raw);
  const roots = platformRoots();
  const matchedRoot = roots.find((root) => abs === root || abs.startsWith(root + sep));
  if (!matchedRoot) {
    res
      .status(403)
      .json({ error: '禁止访问：仅允许预览 ~/.nova、~/.config/opencode、~/.claude、~/.agents/skills 下的文件' });
    return;
  }

  // Second segment after the platform root must be a resource sub-dir.
  // Format: <root>/<resource>/...  →  <resource> is the second segment.
  const remainder = abs.slice(matchedRoot.length).split(sep).filter(Boolean);
  const subDir = remainder[0];
  if (!subDir || !['agents', 'commands', 'skills', 'extensions'].includes(subDir)) {
    res.status(403).json({ error: '禁止访问：仅允许预览 agents/commands/skills/extensions 下的文件' });
    return;
  }

  const ext = extname(abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    res.status(415).json({ error: `不支持的文件类型：${ext || '(无扩展名)'}` });
    return;
  }

  let info;
  try {
    info = await stat(abs);
  } catch (err) {
    res.status(404).json({ error: `文件不存在：${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  if (!info.isFile()) {
    res.status(400).json({ error: '不是文件' });
    return;
  }

  if (info.size > MAX_FILE_BYTES) {
    res.status(413).json({
      error: `文件过大（${(info.size / 1024 / 1024).toFixed(2)} MB > ${MAX_FILE_BYTES / 1024 / 1024} MB），暂不支持预览`,
    });
    return;
  }

  try {
    const content = await readFile(abs, 'utf8');
    res.json({
      path: abs,
      name: basename(abs),
      size: info.size,
      mtime: info.mtime.toISOString(),
      content,
    });
  } catch (err) {
    res.status(500).json({ error: `读取失败：${err instanceof Error ? err.message : String(err)}` });
  }
});

export default router;