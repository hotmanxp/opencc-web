// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { Children, isValidElement } from 'react';
import { Text } from '../../ink.js';
type Props = {
  /** The items to join with a middot separator */
  children: React.ReactNode;
};

/**
 * Joins children with a middot separator (" · ") for inline metadata display.
 *
 * Named after the publishing term "byline" - the line of metadata typically
 * shown below a title (e.g., "John Doe · 5 min read · Mar 12").
 *
 * Automatically filters out null/undefined/false children and only renders
 * separators between valid elements.
 *
 * @example
 * // Basic usage: "Enter to confirm · Esc to cancel"
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 * @example
 * // With conditional children: "Esc to cancel" (only one item shown)
 * <Text dimColor>
 *   <Byline>
 *     {showEnter && <KeyboardShortcutHint shortcut="Enter" action="confirm" />}
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 */
export function Byline(t0) {
  return null;
}
function _temp(child, index) {
  return <React.Fragment key={isValidElement(child) ? child.key ?? index : index}>{index > 0 && <Text dimColor={true}> · </Text>}{child}</React.Fragment>;
}
