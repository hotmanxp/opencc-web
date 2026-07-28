# AGENTS.md — src/utils

## OVERVIEW
Catch-all utilities directory: bash parsing/security, plugin system, settings management, hooks, telemetry, and flat utility functions.

## WHERE TO LOOK

### Bash Parsing & Security
- `bash/commands.ts` — Main entry for command parsing and security checks
- `bash/ast.ts` — Tree-sitter-based AST analysis (replaces shell-quote approach)
- `bash/ParsedCommand.ts` — Command parsing result types
- `bash/bashParser.ts` — Parser implementation

### Settings
- `settings/settings.ts` — Core settings logic
- `settings/validation.ts` — Settings validation rules

### Hooks
- `hooks/sessionHooks.ts` — Session-level hooks
- `hooks/execPromptHook.ts` — Prompt execution hooks

### Plugins
- `plugins/pluginLoader.ts` — Plugin loading system
- `plugins/loadPluginHooks.ts` — Hook loading from plugins

### Permissions
- `permissions/shellRuleMatching.ts` — Shell permission rule matching

### Model
- `model/model.ts` — Model configuration

## CONVENTIONS

- No eslint/prettier — tsconfig strict mode is the only enforcement
- Tests as `*.test.ts` co-located with source files
- Many utilities flat in this directory (not further sub-divided)
- Import path extensions: use `.js` extensions even in `.ts` files (`from './foo.js'`)

## ANTI-PATTERNS

- **Deprecated bash functions**: Do not use `splitCommand_DEPRECATED` or `bashCommandIsSafe_DEPRECATED`. Use `splitCommandWithOperators` from `bash/commands.ts` and the AST-based analysis in `bash/ast.ts`
- **Deprecated settings**: `getSettings_DEPRECATED` — use React hooks `useSettings()` instead
- **Deprecated sync I/O**: `writeFileSync_DEPRECATED` and `execSync_DEPRECATED` — use async alternatives
- **Deprecated feature flags**: `getFeatureValue_DEPRECATED` — feature flags being migrated, check before using

## KEY FILES

| File | Purpose |
|------|---------|
| `bash/commands.ts` | Command parsing, argv extraction, security checks |
| `bash/ast.ts` | Tree-sitter AST analysis (fail-closed design) |
| `settings/settings.ts` | Settings management core |
| `hooks/sessionHooks.ts` | Session lifecycle hooks |
| `plugins/pluginLoader.ts` | Plugin loading and lifecycle |
| `file.ts` | File system operations |
| `log.ts` | Logging utilities |
| `env.ts` | Environment variable handling |
| `telemetry/` | Telemetry and event tracking subdir |
