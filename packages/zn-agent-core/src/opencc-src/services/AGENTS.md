# AGENTS.md — src/services

## OVERVIEW
Service layer providing API clients, MCP protocol implementation, LSP language server management, GitHub integration, analytics, and voice processing.

## WHERE TO LOOK

### API Layer (`api/`)
- **openaiShim.ts** — OpenAI-compatible provider shim; translates Anthropic SDK calls to OpenAI chat completions API. Supports OpenAI, Azure, Ollama, LM Studio, OpenRouter, Together, Groq, Fireworks, DeepSeek, Mistral, GitHub Models, Codex.
- **client.ts** — Primary API client with multi-provider support (Anthropic direct, AWS Bedrock, Azure Foundry, Vertex AI). Handles auth, retries, streaming.
- **providerConfig.ts** — Provider resolution and request configuration.
- **sessionIngress.ts** — Session ingress handling.

### MCP (`mcp/`)
- **client.ts** — MCP client implementation using @modelcontextprotocol/sdk. Handles tool calls, resource listing, elicitation.
- **MCPConnectionManager.tsx** — React component managing MCP connections lifecycle.
- **auth.ts** — OAuth authentication flow for MCP servers.
- **normalization.ts** — Response normalization across providers.
- **types.ts** — Shared MCP type definitions.
- **doctor.ts** — MCP diagnostic and health checks.

### LSP (`lsp/`)
- **manager.ts** — LSP server lifecycle management.
- **LSPClient.ts** — Client-server communication.
- **LSPServerInstance.ts** — Individual LSP server instance.
- **LSPServerManager.ts** — Multi-server orchestration.

### GitHub (`github/`)
- **deviceFlow.ts** — OAuth device flow for GitHub authentication.

### Analytics (`analytics/`)
- **sink.ts** — Event sink for telemetry.
- **firstPartyEventLogger.ts** — First-party event logging.
- **growthbook.ts** — Feature flag integration.

### Voice (`voice.ts`)
- Voice processing and streaming.

## CONVENTIONS

### Provider Shim Pattern
API clients must implement provider-agnostic interfaces. When adding provider support:
1. Add provider detection in `providerConfig.ts`
2. Normalize responses in shim layer (e.g., `openaiShim.ts`)
3. Use shared types from `api/types.ts`

### MCP Server Implementation
MCP servers follow the Model Context Protocol specification:
- Use `@modelcontextprotocol/sdk` for client implementation
- Implement tool schema in `tools.ts` format
- Handle streaming via SSE or StreamableHTTP transports

### Error Handling
- Use `errorUtils.ts` for structured error creation
- Provider-specific errors wrapped with context
- Retry logic via `withRetry.ts` with exponential backoff

### Streaming
- SSE for real-time event streaming
- StreamableHTTP for MCP transport
- Token streaming normalized to Anthropic event format

## ANTI-PATTERNS

- **DO NOT** override API parameters that differ from parent request — respect original provider constraints (e.g., maxOutputTokens, temperature ranges vary by provider)
- **DO NOT** set maxOutputTokens on forked threads — inherit from parent request
- **DO NOT** mix provider-specific types with generic interfaces — keep normalization layer clean
- **DO NOT** assume synchronous initialization — MCP connections and auth flows are async
- **DO NOT** hardcode model names — use config resolution via `providerConfig.ts`
