import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readConfig, writeConfig } from '../services/fileStore.js';
import type { ConfigTool } from '../../shared/types.js';

const router: IRouter = Router();
const ConfigToolSchema = z.enum(['nova', 'opencode', 'opencc']);

const CLAUDE_JSON_PATH = () => join(homedir(), '.claude.json');

export interface ProviderProfile {
  id?: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  apiFormat?: string;
}

async function readClaudeJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(CLAUDE_JSON_PATH(), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function writeClaudeJson(data: Record<string, unknown>): Promise<void> {
  const path = CLAUDE_JSON_PATH();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, path);
}

router.get('/config/:tool', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  try {
    const result = await readConfig(parsed.data as ConfigTool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/:tool', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  try {
    await writeConfig(parsed.data as ConfigTool, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// OpenCC ProviderProfile 配置（读写 ~/.claude.json 的 providerProfiles 字段）
router.get('/config/opencc/provider', async (_req, res) => {
  try {
    const data = await readClaudeJson();
    const profiles: ProviderProfile[] = (data.providerProfiles as ProviderProfile[]) || [];
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/opencc/provider', async (req, res) => {
  const schema = z.object({
    profiles: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      provider: z.string(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiFormat: z.string().optional(),
    })),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid body: ${parsed.error.message}` });
  }
  try {
    const data = await readClaudeJson();
    data.providerProfiles = parsed.data.profiles;
    await writeClaudeJson(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
