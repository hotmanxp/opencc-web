# Task 3 Report: dsh-bridge contentBlock.ts — zod schema + parse helper

## Status: DONE

## Commits
- `8b2a75bb` — feat(dsh-bridge): 新增 contentBlock zod schema + parse helper

## Test Summary
```bash
pnpm vitest run test/subagent/contentBlock.test.ts
```
Result: PASS — 8 tests passed (thinking/text/tool_use/tool_result/image block parsing, unknown type throw, array handling, schema export)

## Concerns
- 新增 `zod` 到 dsh-bridge devDependencies;生产依赖无需 zod(Typescript 类型已足够),dev 仅测试用。

## Self-review
- Schema 形同 zai `SubagentContentBlockSchema`(zai-side Task 1 消费侧镜像),结构一致;
- `parseContentBlocks` 单条失败时跳过而非全局 throw,符合「部分可解析」的需求;
- console.warn 在 throw 前输出,兼顾调试可见性与错误冒泡。

## Fix Round 1 (2026-08-24)
- **Critical**: Moved `"zod": "^3.23.8"` from `devDependencies` → `dependencies` in `packages/dsh-bridge/package.json`. `contentBlock.ts:1` imports `zod` at runtime via `dist/`, so it must be a production dependency.
- **Important**: Replaced misleading source comment in `contentBlock.ts:3-9`. Old comment claimed schema mirrors vendor `@deepseek-ai/dsh-subagent` ContentBlock; corrected to clarify schema is an Anthropic-shaped mirror of zai `SubagentContentBlockSchema` (packages/zai/src/shared/subagentEvents.ts:23-44), and vendor uses different tag names — see spec §9.3 mapping layer for translation.
- Verification:
  ```
  pnpm install  → Done in 2.4s (lockfile refreshed, -3 stale packages)
  pnpm --filter @zn-ai/dsh-bridge typecheck  → PASS (tsc -b --noEmit)
  pnpm --filter @zn-ai/dsh-bridge test test/subagent/contentBlock.test.ts  → 8/8 PASS
  ```
