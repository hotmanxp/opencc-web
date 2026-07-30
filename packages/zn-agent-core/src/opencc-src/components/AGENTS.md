# Components Directory

## OVERVIEW

Ink (React for CLI) component library for terminal UI with virtualized message rendering, themed design system, and keyboard-driven interactions.

## WHERE TO LOOK

- **design-system/** — Foundation: `Dialog`, `Pane`, `ThemedBox`, `ThemedText`, `ThemeProvider`, `Tabs`, `ProgressBar`, `LoadingState`, `FuzzyPicker`, `ListItem`
- **PromptInput/** — Command input with history, suggestions, vim mode, and footer pills (`PromptInput.tsx`, `PromptInputFooter.tsx`, `ShimmeredInput.tsx`, `HistorySearchInput.tsx`)
- **Messages.tsx** — Virtualized message list with grouping, collapsing, and streaming support; uses `VirtualMessageList` for performance
- **MessageRow.tsx** — Individual message rendering with tool use chrome
- **LogoV2/** — Welcome screen, branding, feed, and upsell components
- **hooks/** — Hook-mode selectors (`SelectHookMode.tsx`, `SelectMatcherMode.tsx`)
- **permissions/** — Permission request dialogs
- **CustomSelect/** — `Select`, `SelectMulti`, `select-option` for terminal-native dropdowns

## CONVENTIONS

### React Compiler
New components should use the `_c` pattern from `react-compiler-runtime`:
```tsx
import { c as _c } from "react-compiler-runtime";
export function MyComponent(t0) {
  const $ = _c(N);
  const { propA, propB } = t0;
  // Cache computations across renders
  let t1;
  if ($[0] !== dep1 || $[1] !== dep2) { t1 = compute(); $[0] = dep1; $[1] = dep2; $[2] = t1; }
  else { t1 = $[2]; }
  return t1;
}
```

### State Management
- Global state: `useAppState(s => s.field)` and `useAppStateStore()` from `src/state/AppState.js`
- Local state: standard `useState`, `useCallback`, `useMemo`, `useRef`
- Avoid recreating objects in render — memoize derived values

### Component Patterns
- Named exports (not default): `export function ComponentName`
- Props as TypeScript interface defined in same file
- `React.memo` with custom comparator for expensive components (see `Messages.tsx`)
- Ink components: `Box`, `Text`, `useInput` from `../../ink.js`

### Theming
- Use `ThemeProvider` context with `useTheme()` hook
- Theme colors via `keyof Theme` (e.g., `color="permission"`)
- `ThemedBox`, `ThemedText` for automatic theme-aware styling

## ANTI-PATTERNS

- **No default React.memo comparison** — custom comparator required for components with complex prop objects; default shallow compare causes unnecessary re-renders
- **No inline object creation in render** — `useMemo` derived values, never `{ field: value }` in JSX props
- **No expensive computation in render body** — move to `useMemo` or `useCallback`
- **No synchronous side effects in components** — use `useEffect` for I/O, config writes, notifications
- **No terminal-specific assumptions** — components must work in both fullscreen and headless modes
