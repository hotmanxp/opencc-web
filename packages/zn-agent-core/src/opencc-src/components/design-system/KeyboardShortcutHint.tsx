// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import Text from '../../ink/components/Text.js';
type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string;
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string;
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean;
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean;
  /** Preposition between shortcut and action. Default: "to" */
  preposition?: string;
};

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 *
 * @example
 * // Simple hint wrapped in dim Text
 * <Text dimColor><KeyboardShortcutHint shortcut="esc" action="cancel" /></Text>
 *
 * // With parentheses: "(ctrl+o to expand)"
 * <Text dimColor><KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens /></Text>
 *
 * // With bold shortcut: "Enter to confirm" (Enter is bold)
 * <Text dimColor><KeyboardShortcutHint shortcut="Enter" action="confirm" bold /></Text>
 *
 * // Multiple hints with middot separator - use Byline
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 */
export function KeyboardShortcutHint(t0) {
  const $ = _c(10);
  const {
    shortcut,
    action,
    parens: t1,
    bold: t2,
    preposition: t3
  } = t0;
  const parens = t1 === undefined ? false : t1;
  const bold = t2 === undefined ? false : t2;
  const preposition = t3 === undefined ? 'to' : t3;
  let t4;
  if ($[0] !== bold || $[1] !== shortcut) {
    t4 = bold ? <Text bold={true}>{shortcut}</Text> : shortcut;
    $[0] = bold;
    $[1] = shortcut;
    $[2] = t4;
  } else {
    t4 = $[2];
  }
  const shortcutText = t4;
  if (parens) {
    let t5;
    if ($[3] !== action || $[4] !== shortcutText || $[5] !== preposition) {
      t5 = <Text>({shortcutText}{preposition ? ' ' + preposition + ' ' : ' '}{action})</Text>;
      $[3] = action;
      $[4] = shortcutText;
      $[5] = preposition;
      $[6] = t5;
    } else {
      t5 = $[6];
    }
    return t5;
  }
  let t5;
  if ($[6] !== action || $[7] !== shortcutText || $[8] !== preposition) {
    t5 = <Text>{shortcutText}{preposition ? ' ' + preposition + ' ' : ' '}{action}</Text>;
    $[6] = action;
    $[7] = shortcutText;
    $[8] = preposition;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
