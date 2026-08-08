import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  readConfig,
  writeConfig,
  readTopLevelJson,
  writeTopLevelJson,
} from '../services/fileStore.js';
import type { ConfigTool, ProviderProfile } from '../../shared/types.js';

const router: IRouter = Router();
const ConfigToolSchema = z.enum(['nova', 'opencode', 'opencc', 'zai']);

const CLAUDE_JSON_PATH = () => join(homedir(), '.zai.json');

// Capability metadata for one model entry on a provider profile.
// All fields optional so existing pre-capability profiles round-trip cleanly.
const ModelCapabilitiesSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsVision: z.boolean().optional(),
  supportsFunctionCalling: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsJsonMode: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
}).strict();

const ProviderProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiFormat: z.string().optional(),
  // Map keyed by model name → per-model capabilities. Unknown model keys
  // are passed through (the picker filters by what it knows about).
  capabilities: z.record(z.string(), ModelCapabilitiesSchema).optional(),
}).strict();

export type ProviderProfileInput = z.infer<typeof ProviderProfileSchema>;

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

// 顶层 JSON 配置文件(~/.zai.json / ~/.zai.json)的读取与原子写。
// 注册顺序必须在 /config/:tool 之前 — Express 按注册顺序匹配,
// /config/claude-json 会被 /config/:tool (tool=claude-json) 抢先吃掉,
// 然后 ConfigToolSchema 校验失败。直读直写 ConfigFile 形状,不走
// ConfigTool 枚举(这两个文件不在用户视角的"工具"分类里)。
router.get('/config/claude-json', async (_req, res) => {
  try {
    res.json(await readTopLevelJson('claude-json'));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/claude-json', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  try {
    await writeTopLevelJson('claude-json', req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/config/zai-json', async (_req, res) => {
  try {
    res.json(await readTopLevelJson('zai-json'));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/zai-json', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  try {
    await writeTopLevelJson('zai-json', req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

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

// OpenCC ProviderProfile 配置（读写 ~/.zai.json 的 providerProfiles 字段）
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
    profiles: z.array(ProviderProfileSchema),
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
