# AGENTS.md — src/commands

## OVERVIEW

Commands are CLI subcommands exposed via Commander.js as slash commands or direct CLI arguments.

## WHERE TO LOOK

| Command | File | Type |
|---------|------|------|
| `/commit` | `src/commands/commit.ts` | prompt (allowedTools: git add/status/commit) |
| `/review` | `src/commands/review.ts` | prompt (local PR review) |
| `/init` | `src/commands/init.ts` | prompt |
| `/plan` | `src/commands/plan/index.ts` | local-jsx |
| `/config` | `src/commands/config/index.ts` | local-jsx (aliases: settings) |
| `/session` | `src/commands/session/index.ts` | local-jsx (remote mode only) |
| `/doctor` | `src/commands/doctor/index.ts` | local-jsx |
| `/diff` | `src/commands/diff/index.ts` | local-jsx |
| `/compact` | `src/commands/compact/index.ts` | local-jsx |
| `/mcp` | `src/commands/mcp/index.ts` | local-jsx |
| `/skills` | `src/commands/skills/index.ts` | local-jsx |
| `/model` | `src/commands/model/index.ts` | local-jsx |
| `/provider` | `src/commands/provider/index.ts` | local-jsx |

## STRUCTURE

```
src/commands/
  *.ts                 # Flat command files (commit.ts, review.ts, init.ts, etc.)
  [command]/index.ts   # Subcommand directories with lazy loading
    *.js               # Actual implementation (loaded on demand)
```

## CONVENTIONS

**Command Object Shape:**
```typescript
{
  name: string
  aliases?: string[]
  type: 'local-jsx' | 'prompt'
  description: string
  argumentHint?: string       // e.g., '[open|<description>]'
  isEnabled?: () => boolean  // guard function
  isHidden?: boolean         // computed property
  load?: () => Promise<...>  // lazy import for local-jsx
  getPromptForCommand?: (args, context) => Promise<ContentBlockParam[]>
  allowedTools?: string[]    // for prompt type with tool restrictions
  progressMessage?: string
  source?: 'builtin'
}
```

**Two Patterns:**
1. **Flat file** — exports default Command directly (commit.ts, review.ts)
2. **Subdirectory** — index.ts exports Command with `load: () => import('./command.js')` for lazy loading

**ES modules** — all imports use `.js` extensions

**Dynamic prompts** — prompt commands use `getPromptForCommand` to build context-aware prompts at runtime

## ANTI-PATTERNS

- Do not modify `isEnabled` or `isHidden` guards without understanding the feature flag implications
- Do not use `git commit --amend` in commit command logic
- Do not add tool permissions without careful consideration of security implications
- Do not skip git hooks via `--no-verify` in command implementations
