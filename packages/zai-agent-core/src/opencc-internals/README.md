# opencc-internals — OpenCC Source Mirror

This directory is a **reference mirror** of selected modules from
[`@zn-ai/opencc`](https://github.com/opencc/opencc) (Open Claude Code). It is
populated by [`scripts/sync-from-opencc.ts`](../../scripts/sync-from-opencc.ts)
and is **NOT** part of the zai-agent-core runtime.

## What it is

- A reading-only snapshot of upstream OpenCC source for the modules zai may
  decide to lift into its own runtime in the future. Treat it as documentation
  that happens to be importable, not as a library.
- Excluded from `tsc -b` via the package's `tsconfig.json`. Any code that
  references paths under `src/opencc-internals/` will fail typecheck.
- Mirrors carry **Bun-only** runtime dependencies (`bun:bundle`,
  `@anthropic-ai/sdk`) and `src/*-prefixed import paths` that don't apply to
  zai's Node + tsx build. Editing files here is generally the wrong fix —
  modify the sync script instead.

## How to refresh

```bash
# Show what would change without writing anything.
pnpm --filter @zn-ai/zai-agent-core sync-from-opencc --dry-run

# Apply changes.
pnpm --filter @zn-ai/zai-agent-core sync-from-opencc --apply
```

The sync script reads an explicit `WHITELIST_PATTERNS` set; if a file is
missing from the mirror, add it there rather than copying it in by hand.

## What gets marked

- Files matching `STUB_FILES` in the sync script are prepended with
  `// ZAI_STUB:`. These are deferred modules — zai intentionally has no
  implementation yet.
- Removed `import React from 'react'` / `from 'ink'` lines become
  `// ZAI_REMOVED: ...` comments so the upstream diff is still readable.

## What's *not* here

TUI/UI/REPL/desktop modules from OpenCC are intentionally excluded. The
`isHardExcluded()` whitelist in the sync script controls this. TUI bits that
do remain (e.g. `setToolJSX` noop in `QueryEngine.ts`) are preserved with a
`// ZAI_REMOVED:` marker so the upstream shape is intact for future diffing.

## zai-specific surface

`tools.ts` adds `getZaiBaseTools()` next to the upstream `getAllBaseTools()`.
Use the zai variant when wiring the runtime — it only returns the 8 tools that
have a working zai implementation today.
