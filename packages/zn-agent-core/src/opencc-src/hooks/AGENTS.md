# AGENTS.md — src/hooks/

## OVERVIEW
Custom React hooks for CLI state management, side effects, and integrations with voice, IDE, notifications, and task systems.

## WHERE TO LOOK

### Core State Hooks
- **useSettings** — Reactive settings from AppState (auto-updates on file change)
- **useTasksV2** — Task list with singleton TasksV2Store (useSyncExternalStore, shared file watcher)
- **useAppState / useSetAppState** — Global state access from `../state/AppState.js`

### Notifications (notifs/)
- **useStartupNotification** — Fires once-per-session notification on mount
- **useRateLimitWarningNotification** — Rate limit warning notifications
- **useSettingsErrors** — Settings error notifications
- **useInstallMessages** — Installation-related notifications

### IDE & Voice Integration
- **useIDEIntegration** — IDE extension auto-connect and MCP configuration
- **useVoice** — Hold-to-talk voice input with Anthropic voice_stream STT
- **useVoiceEnabled / useVoiceIntegration** — Voice feature flags and state
- **useIdeConnectionStatus / useIdeSelection / useIdeAtMentioned** — IDE state queries

### Input & Terminal
- **useTextInput / useSearchInput / useTypeahead** — Text input handling
- **useVimInput** — Vim mode input handling
- **useTerminalSize** — Terminal dimensions
- **useGlobalKeybindings / useCommandKeybindings** — Keyboard shortcuts
- **useExitOnCtrlCD** — Ctrl+C handling

### Background & Polling
- **useInboxPoller** — Inbox polling
- **useSwarmPermissionPoller** — Permission polling
- **useTaskListWatcher** — Task file watching
- **useScheduledTasks** — Scheduled task execution

### Merged/Bridge Hooks
- **useMergedCommands / useMergedTools / useMergedClients** — Merged state from multiple sources
- **useReplBridge / useMailboxBridge** — Bridge state management
- **useDirectConnect** — Direct connection handling

## CONVENTIONS

### Hook Structure
- Export named function: `export function useX()`
- Return object for multiple values: `{ state, handler }`
- Use refs for values that must not trigger re-renders (timers, connections)

### State Management
- Prefer `useAppState(selector)` over direct state imports
- Singleton stores for shared resources (file watchers, connections) — see `TasksV2Store`
- `useSyncExternalStore` for external subscriptions (fs, WebSocket)

### React Compiler
- Some hooks (useIDEIntegration) use `react-compiler-runtime` — generated/compiled, do not edit manually

### File Extensions
- `.ts` for pure hooks, `.tsx` for hooks returning JSX or using react-compiler

### Cleanup
- Always clean up timers, watchers, and connections in useEffect cleanup
- Use `unref()` on timers to avoid keeping process alive
