import * as React from 'react';
import { useEffect, useState } from 'react';
type PickerAction<T> = {
  /** Hint label shown in the byline, e.g. "mention" → "Tab to mention". */
  action: string;
  handler: (item: T) => void;
};
type Props<T> = {
  title: string;
  placeholder?: string;
  initialQuery?: string;
  items: readonly T[];
  getKey: (item: T) => string;
  /** Keep to one line — preview handles overflow. */
  renderItem: (item: T, isFocused: boolean) => React.ReactNode;
  renderPreview?: (item: T) => React.ReactNode;
  /** 'right' keeps hints stable (no bounce), but needs width. */
  previewPosition?: 'bottom' | 'right';
  visibleCount?: number;
  /**
   * 'up' puts items[0] at the bottom next to the input (atuin-style). Arrows
   * always match screen direction — ↑ walks visually up regardless.
   */
  direction?: 'down' | 'up';
  /** Caller owns filtering: re-filter on each call and pass new items. */
  onQueryChange: (query: string) => void;
  /** Enter key. Primary action. */
  onSelect: (item: T) => void;
  /**
   * Tab key. If provided, Tab no longer aliases Enter — it gets its own
   * handler and hint. Shift+Tab falls through to this if onShiftTab is unset.
   */
  onTab?: PickerAction<T>;
  /** Shift+Tab key. Gets its own hint. */
  onShiftTab?: PickerAction<T>;
  /**
   * Fires when the focused item changes (via arrows or when items reset).
   * Useful for async preview loading — keeps I/O out of renderPreview.
   */
  onFocus?: (item: T | undefined) => void;
  onCancel: () => void;
  /** Shown when items is empty. Caller bakes loading/searching state into this. */
  emptyMessage?: string | ((query: string) => string);
  /**
   * Status line below the list, e.g. "500+ matches" or "42 matches…".
   * Caller decides when to show it — pass undefined to hide.
   */
  matchLabel?: string;
  selectAction?: string;
  extraHints?: React.ReactNode;
};
const DEFAULT_VISIBLE = 8;
// Pane (paddingTop + Divider) + title + 3 gaps + SearchBox (rounded border = 3
// rows) + hints. matchLabel adds +1 when present, accounted for separately.
const CHROME_ROWS = 10;
const MIN_VISIBLE = 2;
// Translation map for byline action hints
const ACTION_TRANSLATIONS: Record<string, string> = {
  navigate: '导航',
  nav: '导航',
  cancel: '取消',
  select: '选择',
  use: '使用',
  confirm: '确认',
};
export function FuzzyPicker<T>({
  title,
  placeholder = '输入搜索…',
  initialQuery,
  items,
  getKey,
  renderItem,
  renderPreview,
  previewPosition = 'bottom',
  visibleCount: requestedVisible = DEFAULT_VISIBLE,
  direction = 'down',
  onQueryChange,
  onSelect,
  onTab,
  onShiftTab,
  onFocus,
  onCancel,
  emptyMessage = '无结果',
  matchLabel,
  selectAction = 'select',
  extraHints
}: Props<T>): React.ReactNode | null {
  return null;
}
function List(t0) {
  return null;
}
function firstWord(s: string): string {
  const i = s.indexOf(' ');
  return i === -1 ? s : s.slice(0, i);
}
