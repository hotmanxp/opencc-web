import { Router, type IRouter } from 'express';
import { z } from 'zod';
import {
  readConfig,
  writeConfig,
  readTopLevelJson,
  writeTopLevelJson,
  readAgentsMd,
  writeAgentsMd,
} from '../services/fileStore.js';
import type { ConfigTool, ProviderProfile } from '../../shared/types.js';

const router: IRouter = Router();
const ConfigToolSchema = z.enum(['nova', 'opencode', 'opencc', 'zai']);

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
  // zai patch: per-provider API key env var name. Lets two profiles
  // share the same provider-family (e.g. two anthropic ones) while
  // each uses its own key. Resolution order: inline apiKey →
  // env[apiKeyEnv] → provider-family global env
  // (OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN).
  apiKeyEnv: z.string().optional(),
  // zai patch: free-form request-body fields merged into every LLM
  // call routed through this profile (anthropic → messages.create,
  // openai → POST /chat/completions). Lets users pin per-provider
  // defaults like temperature / top_p / reasoning_effort without
  // code changes. Schema is open because the consumer (modelCaller)
  // forwards keys verbatim.
  extraParams: z.record(z.string(), z.unknown()).optional(),
  // Map keyed by model name → per-model capabilities. Unknown model keys
  // are passed through (the picker filters by what it knows about).
  capabilities: z.record(z.string(), ModelCapabilitiesSchema).optional(),
});
// Not .strict() — zai profile shapes evolved beyond the opencc baseline
// (apiKeyEnv / extraParams were added in zai-specific patches), and
// ~/.zai.json may already carry legacy keys (e.g. authToken) from
// hand-edits or migration scripts. Strip unknown keys on save so the
// on-disk profile stays clean and round-trips stay idempotent, instead
// of failing every PUT once a stray key shows up.

export type ProviderProfileInput = z.infer<typeof ProviderProfileSchema>;

// 顶层 JSON 配置文件(~/.claude.json / ~/.claude/settings.json)的读取与原子写。
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

router.get('/config/claude-settings', async (_req, res) => {
  try {
    res.json(await readTopLevelJson('claude-settings'));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/claude-settings', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  try {
    await writeTopLevelJson('claude-settings', req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ~/.zai.json — zai tab 下 "Config" 卡的全文编辑端点。
// providerProfiles 字段走 /config/zai/provider(自有 schema),
// 二者写同一文件,但路径不同:本端点写整对象,provider 端点只换 providerProfiles。
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

// AGENTS.md 编辑 — 每个 tool 独立路径(missing 时写盘自动 mkdir 父目录)。
// 必须注册在 /config/:tool 之前:Express 按注册顺序匹配,新路由被通用路由
// 抢先匹配会触发 ConfigToolSchema 解析 tool 后调 readConfig(tool),返回
// content:{} (Record) 而不是 string,形状错乱。4 个工具互不共享:
// opencc → ~/.claude/AGENTS.md,zai → ~/.zai/AGENTS.md,
// opencode/nova 各自落到自己的 config dir。
router.get('/config/:tool/agents-md', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  try {
    res.json(await readAgentsMd(parsed.data as ConfigTool));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/:tool/agents-md', async (req, res) => {
  const parsed = ConfigToolSchema.safeParse(req.params.tool);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid tool: ${req.params.tool}` });
  }
  const body = req.body as { content?: unknown } | undefined;
  if (!body || typeof body.content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  try {
    await writeAgentsMd(parsed.data as ConfigTool, body.content);
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

// OpenCC ProviderProfile 配置（读写 ~/.claude.json 的 providerProfiles 字段）
router.get('/config/opencc/provider', async (_req, res) => {
  try {
    const file = await readTopLevelJson('claude-json');
    const profiles: ProviderProfile[] =
      (file.content.providerProfiles as ProviderProfile[]) || [];
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
    const file = await readTopLevelJson('claude-json');
    file.content.providerProfiles = parsed.data.profiles;
    await writeTopLevelJson('claude-json', file.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Zai ProviderProfile 配置（读写 ~/.zai.json 的 providerProfiles 字段 —
// zai 运行时 modelCaller/resolveModel/agentSettings 均从该字段读取）.
// 与 opencc/provider 共享同一 schema,但落在不同文件。
router.get('/config/zai/provider', async (_req, res) => {
  try {
    const file = await readTopLevelJson('zai-json');
    const profiles: ProviderProfile[] =
      (file.content.providerProfiles as ProviderProfile[]) || [];
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/config/zai/provider', async (req, res) => {
  const schema = z.object({
    profiles: z.array(ProviderProfileSchema),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid body: ${parsed.error.message}` });
  }
  try {
    const file = await readTopLevelJson('zai-json');
    file.content.providerProfiles = parsed.data.profiles;
    await writeTopLevelJson('zai-json', file.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
