# Provider Model Route Overrides — 按模型路由端点与 API Key

日期: 2026-08-03
状态: 已批准（brainstorming 完成，待审阅）

## 背景与动机

在 opencc CLI 会话中，使用 `haiku` 别名调用 agent 时，请求被发送到错误的端点并失败：

```
400 invalid_request_error
The supported API model names are deepseek-v4-pro or deepseek-v4-flash,
but you passed MiniMax-M2.7-highspeed.
```

根因是**配置不一致**而非代码 bug：

- 会话应用了 `Anthropic-Deepseek` provider profile（`~/.claude.json` 的 `providerProfiles` 中 `provider_823c3755eb3d`），`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`。
- 但 `haiku` 别名解析为 `MiniMax-M2.7-highspeed`（`ANTHROPIC_DEFAULT_HAIKU_MODEL` env / `PROVIDER_ALIAS_OVERRIDES` 表，见 `opencc-src/utils/model/aliasOverrides.ts:25`），这是 MiniMax 的模型名。
- MiniMax 模型名被发到 deepseek 端点 → 400。

现有 provider 体系是**整体单 profile 粒度**：一个激活的 profile 只有一组 `(baseUrl, apiKey, model)`，作用于所有请求（`applyProviderProfileToProcessEnv`，`opencc-src/utils/providerProfiles.ts:439`）。无法做到"同 anthropic 类型下，不同模型各配端点与 key"。

## 需求

在 anthropic provider 类型下，允许**按具体模型名**为不同模型配置不同的 API 端点与 API key。配置以覆盖表形式叠加在 active provider profile 之上：

- 作用环境：opencc CLI 会话（`~/.claude.json` 配置体系）
- 粒度：按解析后的最终模型名精确匹配
- 形态：覆盖表叠加在 active profile 上，未命中的模型走 profile 默认
- 配置方式：仅手动编辑 `~/.claude.json`，不做 CLI 交互

## 设计

### 1. 配置结构

`~/.claude.json` 顶层新增 `providerModelOverrides` 字段，与 `providerProfiles` 平级：

```json
"providerModelOverrides": {
  "MiniMax-M2.7-highspeed": {
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "authToken": "sk-xxx"
  },
  "deepseek-v4-flash": {
    "baseUrl": "https://api.deepseek.com/anthropic",
    "authToken": "sk-yyy"
  }
}
```

- **key**：解析后的最终模型名（`parseUserSpecifiedModel` 的输出，例如 `haiku` 解析为 `MiniMax-M2.7-highspeed` 后用该名查表）。
- **value**：`{ baseUrl: 必填; apiKey?: string; authToken?: string }`
  - `apiKey` → SDK `apiKey` → `x-api-key` header
  - `authToken` → SDK `authToken` → `Authorization: Bearer`（与现有 `ANTHROPIC_AUTH_TOKEN` 语义一致；MiniMax / deepseek 的 `/anthropic` 端点均走 Bearer）
  - 两者至少提供一个，否则视为非法条目被忽略

### 2. 路由逻辑

**新函数 `getModelRouteOverride(model: string): ModelRouteOverride | undefined`**（位于 `opencc-src/utils/providerProfiles.ts`，与 `getProviderProfiles` 同处）：

1. 读取 `getGlobalConfig().providerModelOverrides`
2. 匹配顺序：
   - 剥离 `[1m]` 后缀后再匹配（端点与 key 与上下文窗口无关）
   - 先精确匹配（大小写敏感）
   - 再小写匹配（大小写不敏感回退）
3. 校验：`baseUrl` 非空、`apiKey` 或 `authToken` 至少一个；非法条目直接忽略（回退默认）

**`getAnthropicClient` 签名增加 `model?: string` 参数**（`opencc-src/services/api/client.ts:58`）：

1. 内部解析路由：`const route = model ? getModelRouteOverride(model) : undefined`
2. route 命中时：
   - `clientConfig.baseURL = route.baseUrl`（显式设置，覆盖 SDK 从 env 读取 `ANTHROPIC_BASE_URL` 的默认行为）
   - `apiKey` / `authToken` 用 route 的对应值
   - 跳过 firstParty OAuth 分支（route 属于第三方 anthropic 兼容端点）
3. 未命中时完全走现有逻辑（profile env / 默认端点）

### 3. 生效范围与行为细节

- **仅 anthropic 原生路径**：openai shim 分支（`providerOverride` / `CLAUDE_CODE_USE_OPENAI`）在 route 判断之前已 return，天然不受影响。
- **调用方零改动**：claude.ts 的 query 路径已在创建客户端时传入 `model: options.model`（`opencc-src/services/api/claude.ts:1853` 等 9 处调用点中，能拿到模型名的均已传），路由点天然存在。
- **不污染全局 env**：override 只在创建的客户端实例上生效，`process.env.ANTHROPIC_BASE_URL` 等保持不变；profile env 管理体系（`PROFILE_ENV_APPLIED_*` 对齐检查、`/provider` 摘要显示）完全不受影响。
- **重试一致性**：`withRetry` 每次重建客户端（401 / 断连时）都会重新走 `getModelRouteOverride`，同一请求重试不会漂移到别的端点。
- **并发安全**：并行子代理各带各的 model，各自创建独立客户端，互不干扰。
- **匹配时机**：用请求路径解析后的最终模型名查表（而非 `haiku` 这类别名）；fallbackModel 场景按实际发出请求的模型路由。

### 4. 测试

单测覆盖：

- `getModelRouteOverride`：
  - 精确匹配命中
  - 小写匹配命中
  - `[1m]` 后缀剥离后命中
  - 未命中返回 `undefined`
  - 非法条目（缺 `baseUrl`、无 key）被忽略
- `getAnthropicClient`（注入 model）：
  - 命中 override 时 `baseURL`、`authToken`、`apiKey` 正确透传
  - 未命中时保持现有行为（使用 profile env 默认）

### 5. 改动文件

| 文件 | 改动 |
|---|---|
| `packages/zn-agent-core/src/opencc-src/utils/providerProfiles.ts` | 新增 `ModelRouteOverride` 类型 + `getModelRouteOverride()` + `providerModelOverrides` 读取 |
| `packages/zn-agent-core/src/opencc-src/services/api/client.ts` | `getAnthropicClient` 签名加 `model?`，内部解析 route 并覆盖 baseURL / key |
| 新增测试文件（如 `providerModelRouteOverrides.test.ts`） | 上述单测 |

## 非目标

- 不做 `/provider` 命令的 CLI 交互扩展（仅手动编辑 JSON）
- 不改造 `providerProfiles` 为多模型结构（保持现有 4 个 profile 的兼容性）
- 不覆盖 openai provider 路径（openai shim 走 `OPENAI_*` env，不在本设计范围）
- 不做按 tier 别名（opus/sonnet/haiku）的端点路由（按具体模型名即可满足需求）
