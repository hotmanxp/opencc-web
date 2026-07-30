# Ink (CLI React) Agent Guide

## OVERVIEW
Ink is a React renderer for CLI terminals — same component patterns as web React but renders to terminal output using ANSI escape codes and Yoga layout.

## WHERE TO LOOK

### Entry Points
- `ink.tsx` — Main renderer orchestrator, React reconciler setup, frame loop
- `ink.tsx:42-50` — ALT_SCREEN_ANCHOR_CURSOR constant for TTY handling

### Core Components (in `components/`)
- `Box.tsx` — Flexbox container (`display: flex` equivalent), supports `flexDirection`, `gap`, `alignItems`, event handlers
- `Text.tsx` — Text rendering with styling props (`bold`, `dim`, `italic`, `underline`)
- `Button.tsx` — Interactive button with focus/click handling
- `Spacer.tsx` — Flex spacer for layout (like `flex: 1`)
- `Newline.tsx` — Explicit line break
- `ScrollBox.tsx` — Scrollable container for overflow content
- `Link.tsx` — Hyperlink with ANSI underline styling
- `RawAnsi.tsx` — Raw ANSI escape sequence passthrough

### Layout Engine (`layout/`)
- `layout/yoga.ts` — Yoga layout engine bindings (Facebook's flexbox impl)
- `layout/node.ts` — LayoutNode type definitions
- `layout/engine.ts` — Layout calculation entry point

### Terminal I/O (`termio/`)
- `termio/ansi.ts` — ANSI escape code constants and parsing
- `termio/csi.ts` — Control Sequence Introducer codes (cursor movement, erasure)
- `termio/osc.ts` — Operating System Command codes (clipboard, tab title)
- `termio/dec.ts` — DEC private sequences (mouse tracking, alt screen)

### Events (`events/`)
- `events/keyboard-event.ts` — Keypress handling (onKeyDown prop)
- `events/click-event.ts` — Mouse click (only in AlternateScreen)
- `events/focus-event.ts` — Focus/blur handling

### Hooks (`hooks/`)
- `hooks/use-app.ts` — Access app exit method
- `hooks/use-input.ts` — Raw input handling
- `hooks/use-stdin.ts` — Stdin stream access
- `hooks/use-selection.ts` — Text selection state
- `hooks/use-terminal-focus.ts` — Terminal focus tracking

## CONVENTIONS

### Styling
- Props like `flexDirection`, `gap`, `alignItems`, `justifyContent` mirror CSS flexbox
- Colors use raw ANSI values: `'ansi:red'`, `'ansi:greenBright'`, `rgb(255,0,0)`, `#ff0000`
- No CSS — styles are passed as props directly to components
- `textWrap` prop: `'wrap' | 'wrap-trim' | 'end' | 'middle'`

### JSX
- File extension: `.tsx` for all React components
- React imported from `react` (not `preact` or other)
- Uses `react-compiler-runtime` for automatic memoization (`import { c as _c } from "react-compiler-runtime"`)

### Components
- Components return `DOMElement` (Ink's terminal DOM type)
- Props typed with `PropsWithChildren<...>` from React
- Event handlers: `onClick`, `onKeyDown`, `onFocus`, `onBlur`, `onMouseEnter`, `onMouseLeave`
- Mouse events only work inside `<AlternateScreen>`

### Rendering
- Frame loop at ~60fps (16ms FRAME_INTERVAL_MS)
- Reconciler uses `react-reconciler` with custom `commitRoot` and `prepareFreshRoot`
- Screen buffer managed in `screen.ts` with CellWidth and CharPool
- Output written via terminal's writeDiffToTerminal (batch diffs, not full redraws)

### Module System
- Uses ESM with `.js` extensions in imports
- Path aliases via `src/` prefix (e.g., `import { ... } from 'src/utils/...'`)
- Auto-bind pattern: `auto-bind` for method binding
