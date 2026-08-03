# Provider Model Route Overrides 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 opencc CLI 在 anthropic provider 类型下，按具体模型名将 API 请求路由到不同的端点与 API key（`~/.claude.json` 新增 `providerModelOverrides` 覆盖表，叠加在 active profile 之上）。

**Architecture:** 新增 `getModelRouteOverride(model)` 纯函数从 `getGlobalConfig().providerModelOverrides` 按最终模型名查表；`getAnthropicClient` 增加 `model?` 参数，命中覆盖表时用该条目的 baseUrl / apiKey / authToken 构造 Anthropic SDK 客户端，未命中完全走现有 profile env 逻辑。

**Tech Stack:** TypeScript (strict)、vitest、pnpm workspace（包 `@zn-ai/zn-agent-core`，vendor opencc-src 目录）。

## Global Constraints

- 遵循 opencc-src 约定：import 路径带 `.js` 后缀（`from './foo.js'`）；tsconfig strict；测试 `*.test.ts` 与源文件同目录。
- 配置仅手动编辑 `~/.claude.json`，本计划不新增任何 CLI 交互。
- 不污染全局 env：覆盖只作用于创建的客户端实例，`process.env.ANTHROPIC_BASE_URL` 等保持不变。
- 覆盖表仅作用于 anthropic 原生路径；openai shim 分支（`providerOverride` / `CLAUDE_CODE_USE_OPENAI`）不受影响。
- 匹配用**解析后的最终模型名**（`parseUserSpecifiedModel` 的输出，如 `haiku` → `MiniMax-M2.7-highspeed`），非别名。

---

### Task 1: `providerModelOverrides` 类型与 `getModelRouteOverride` 解析

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/utils/config.ts:208-219`（`ProviderProfile` 类型附近新增 `ProviderModelRouteOverride` 类型）、`config.ts:621-622`（`GlobalConfig` 中 `activeProviderProfileId` 附近新增字段）
- Modify: `packages/zn-agent-core/src/opencc-src/utils/providerProfiles.ts`（新增 `ModelRouteOverride` 类型 + `getModelRouteOverride` + `isValidModelRouteOverride`）
- Test: `packages/zn-agent-core/src/opencc-src/utils/providerProfiles.test.ts`（新建）

**Interfaces:**
- Consumes: `getGlobalConfig()`（`config.ts:1163`，NODE_ENV=test 时返回模块级 `TEST_GLOBAL_CONFIG_FOR_TESTING`，测试用 `saveGlobalConfig(updater)` 修改）、`saveGlobalConfig`（test 环境走 `Object.assign` 分支，`config.ts:899-905`）
- Produces: `getModelRouteOverride(model: string): ModelRouteOverride | undefined`，其中 `ModelRouteOverride = { baseUrl: string; apiKey?: string; authToken?: string }`。Task 2 依赖此签名。

- [ ] **Step 1: 写失败测试** — 新建 `utils/providerProfiles.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { saveGlobalConfig } from './config.js'
import { getModelRouteOverride } from './providerProfiles.js'

describe('getModelRouteOverride', () => {
  beforeEach(() => {
    saveGlobalConfig(c => ({
      ...c,
      providerModelOverrides: {
        'MiniMax-M2.7-highspeed': {
          baseUrl: 'https://api.minimaxi.com/anthropic',
          authToken: 'sk-minimax',
        },
        'deepseek-v4-flash': {
          baseUrl: 'https://api.deepseek.com/anthropic',
          authToken: 'sk-deepseek',
        },
      },
    }))
  })

  afterEach(() => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: undefined }))
  })

  it('exact match returns the override', () => {
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')?.authToken).toBe(
      'sk-minimax',
    )
  })

  it('matches case-insensitively as a fallback', () => {
    expect(getModelRouteOverride('minimax-m2.7-highspeed')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
  })

  it('strips a [1m] suffix before matching', () => {
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed[1m]')?.baseUrl).toBe(
      'https://api.minimaxi.com/anthropic',
    )
  })

  it('returns undefined when no model matches', () => {
    expect(getModelRouteOverride('no-such-model')).toBeUndefined()
  })

  it('returns undefined when no overrides are configured', () => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: undefined }))
    expect(getModelRouteOverride('MiniMax-M2.7-highspeed')).toBeUndefined()
  })

  it('ignores invalid entries (missing baseUrl or keys)', () => {
    saveGlobalConfig(c => ({
      ...c,
      providerModelOverrides: {
        'bad-empty-base': { baseUrl: '' },
        'bad-no-key': { baseUrl: 'https://example.com' },
      },
    }))
    expect(getModelRouteOverride('bad-empty-base')).toBeUndefined()
    expect(getModelRouteOverride('bad-no-key')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core test -t "getModelRouteOverride"`
（若 filter 名不对，改用 `pnpm -r test -t "getModelRouteOverride"`）
Expected: FAIL — `getModelRouteOverride` 未定义（模块不存在或未导出）。

- [ ] **Step 3: 实现类型与函数**

在 `utils/config.ts` 的 `ProviderProfile` 类型定义（约 208-219 行）后新增：

```ts
export type ProviderModelRouteOverride = {
  baseUrl: string
  apiKey?: string
  authToken?: string
}
```

在 `GlobalConfig` 类型中 `activeProviderProfileId?: string`（约 622 行）后新增：

```ts
  // 按具体模型名覆盖 API 端点与 key（叠加在 active provider profile 之上）。
  // key 为解析后的最终模型名（parseUserSpecifiedModel 的输出）。
  providerModelOverrides?: Record<string, ProviderModelRouteOverride>
```

在 `utils/providerProfiles.ts` 中新增（放在 `getProviderProfiles` 之前；顶部从 config 复用类型，避免重复定义等价类型）：

```ts
import type { ProviderModelRouteOverride } from './config.js'

export type ModelRouteOverride = ProviderModelRouteOverride

function isValidModelRouteOverride(
  override: ModelRouteOverride | undefined,
): override is ModelRouteOverride {
  if (!override || typeof override !== 'object') return false
  if (typeof override.baseUrl !== 'string' || override.baseUrl.trim() === '') {
    return false
  }
  return (
    (typeof override.apiKey === 'string' && override.apiKey !== '') ||
    (typeof override.authToken === 'string' && override.authToken !== '')
  )
}

/**
 * 按解析后的最终模型名查找 per-model 端点+key 覆盖条目。
 * 匹配顺序：剥离 [1m] 后缀 → 精确匹配 → 小写匹配。非法条目忽略。
 */
export function getModelRouteOverride(
  model: string,
): ModelRouteOverride | undefined {
  const overrides = getGlobalConfig().providerModelOverrides
  if (!overrides) return undefined

  const base = model.replace(/\[1m\]$/i, '').trim()
  const exact = overrides[base]
  if (isValidModelRouteOverride(exact)) return exact

  const lower = base.toLowerCase()
  for (const [name, override] of Object.entries(overrides)) {
    if (name.toLowerCase() === lower && isValidModelRouteOverride(override)) {
      return override
    }
  }
  return undefined
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zn-agent-core test -t "getModelRouteOverride"`
Expected: 6 个用例全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/utils/config.ts packages/zn-agent-core/src/opencc-src/utils/providerProfiles.ts packages/zn-agent-core/src/opencc-src/utils/providerProfiles.test.ts
git commit -m "feat(zn-agent-core): add per-model provider route override resolution"
```

---

### Task 2: `getAnthropicClient` 按模型路由接线

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/services/api/client.ts:58-187`（`getAnthropicClient` 增加 `model?` 参数并应用路由）
- Test: `packages/zn-agent-core/src/opencc-src/services/api/client.test.ts`（新建）

**Interfaces:**
- Consumes: `getModelRouteOverride(model)`（Task 1 产出）、`getGlobalConfig` / `saveGlobalConfig`（config.ts）
- Produces: 无新导出。`getAnthropicClient` 增加可选参数 `model?: string`（向后兼容，现有 9 个调用方不受影响；claude.ts 已传 `model: options.model`，路由自动生效）

- [ ] **Step 1: 写失败测试** — 新建 `services/api/client.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { saveGlobalConfig } from '../../utils/config.js'
import { getAnthropicClient } from './client.js'

describe('getAnthropicClient model routing', () => {
  const OVERRIDE = {
    'MiniMax-M2.7-highspeed': {
      baseUrl: 'https://api.minimaxi.com/anthropic',
      authToken: 'sk-minimax-test',
    },
  }

  beforeEach(() => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: OVERRIDE }))
  })

  afterEach(() => {
    saveGlobalConfig(c => ({ ...c, providerModelOverrides: undefined }))
  })

  it('uses the override baseURL when the model matches', async () => {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: 'MiniMax-M2.7-highspeed',
    })
    expect(client.baseURL).toBe('https://api.minimaxi.com/anthropic')
  })

  it('sends the override authToken as Bearer authorization', async () => {
    const capturedHeaders: string[] = []
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M2.7-highspeed',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    const client = await getAnthropicClient({
      maxRetries: 0,
      model: 'MiniMax-M2.7-highspeed',
    })
    await client.messages.create({
      model: 'MiniMax-M2.7-highspeed',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(capturedHeaders[0]).toBe('Bearer sk-minimax-test')
  })

  it('falls back to env baseURL when the model has no override', async () => {
    const prev = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    try {
      const client = await getAnthropicClient({
        maxRetries: 0,
        model: 'no-such-model',
      })
      expect(client.baseURL).toBe('https://api.deepseek.com/anthropic')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prev
    }
  })
})
```

注意：第 3 个用例依赖 SDK 从 env 读 `ANTHROPIC_BASE_URL` 的默认行为；若 Anthropic SDK 在 test 环境对该字段有其它默认，以实际运行为准调整期望值。若 `messages.create` 对 mock 响应校验过严导致第 2 个用例失败，保留第 1、3 个用例（baseURL 断言已覆盖路由接线），并删除或跳过第 2 个用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core test -t "getAnthropicClient model routing"`
Expected: FAIL — 第 1 个用例断言失败（`client.baseURL` 不等于 override 端点，因为 model 参数目前被忽略）。

- [ ] **Step 3: 实现路由接线**

在 `services/api/client.ts` 的 `getAnthropicClient` 中：

1. 函数签名增加 `model` 参数（在 `effortValue` 之后）：

```ts
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  fetchOverride,
  source,
  providerOverride,
  effortValue,
  model,
}: {
  apiKey?: string
  maxRetries: number
  fetchOverride?: ClientOptions['fetch']
  source?: string
  // @ts-ignore
  providerOverride?: ProviderOverride
  effortValue?: EffortValue
  model?: string
}): Promise<Anthropic> {
```

2. 顶部增加 import：

```ts
import { getModelRouteOverride } from '../../utils/providerProfiles.js'
```

3. 在 `providerOverride` 分支和 `CLAUDE_CODE_USE_OPENAI` 分支（约 158 行）之后、`shouldUseFirstPartyAuth` 定义（约 110 行）**之前**插入路由解析，并把 firstParty 判断改为路由命中时跳过：

```ts
  // Per-model route override (anthropic native path only): when the final
  // model name matches a providerModelOverrides entry, use that entry's
  // endpoint + credentials instead of the profile env defaults.
  const routeOverride = model ? getModelRouteOverride(model) : undefined

  const shouldUseFirstPartyAuth =
    !routeOverride && shouldUseFirstPartyAnthropicAuth(providerOverride)
```

4. 修改客户端构造（约 169-186 行）：

```ts
  // Determine authentication method based on available tokens
  const resolvedApiKey = isClaudeAISubscriber()
    ? null
    : routeOverride?.apiKey || apiKey || getAnthropicApiKey()

  // baseURL: per-model override wins; else OAuth staging; else SDK default
  // (reads ANTHROPIC_BASE_URL from env).
  const baseURL = routeOverride?.baseUrl ?? (
    process.env.USER_TYPE === 'ant' && isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? getOauthConfig().BASE_API_URL
      : undefined
  )

  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: resolvedApiKey,
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken
      : routeOverride?.authToken ?? undefined,
    ...(baseURL ? { baseURL } : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }
```

> 说明：route 命中时 `shouldUseFirstPartyAuth` 为 false，故 `checkAndRefreshOAuthTokenIfNeeded` / `configureApiKeyHeaders` 分支跳过，defaultHeaders 不注入 Authorization，认证由 SDK 的 `authToken`/`apiKey` 参数发出。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zn-agent-core test -t "getAnthropicClient model routing"`
Expected: 用例全部 PASS（若按 Step 1 备注降级，至少第 1、3 个用例 PASS）。

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/services/api/client.ts packages/zn-agent-core/src/opencc-src/services/api/client.test.ts
git commit -m "feat(zn-agent-core): route anthropic client by per-model override"
```

---

### Task 3: 全量验证与文档

**Files:**
- Modify: 无（验证 + 可选补充）

- [ ] **Step 1: 全量类型检查**

Run: `pnpm -r exec tsc --noEmit`
Expected: 无错误（若出现与本次改动无关的既有错误，记录并说明）。

- [ ] **Step 2: 全量单测**

Run: `pnpm -r test -t "getModelRouteOverride|getAnthropicClient model routing"`
Expected: 本计划新增用例全部 PASS，且无既有用例回归。

- [ ] **Step 3: 人工 smoke（真实配置）**

将 `~/.claude.json` 顶层加入（示例，key 按实际端点填写）：

```json
"providerModelOverrides": {
  "MiniMax-M2.7-highspeed": {
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "authToken": "<minimax-key>"
  }
}
```

重启 opencc CLI，用 `haiku` 作为模型调用 agent，确认请求命中 MiniMax 端点（不再出现 deepseek 400 报错）。验证完可移除该配置段。

- [ ] **Step 4: Commit（若有文档/补充改动）**

```bash
git add -A
git commit -m "chore(zn-agent-core): verify per-model route override plan"
```
（若无改动，跳过本步。）
