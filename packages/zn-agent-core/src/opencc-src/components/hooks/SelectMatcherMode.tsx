// @ts-nocheck
/**
 * SelectMatcherMode shows the configured matchers for a selected hook event.
 *
 * The /hooks menu is read-only: this view no longer offers "add new matcher"
 * and simply lets the user drill into each matcher to see its hooks.
 */
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { Text } from '../../ink.js'
import { type HookSource, hookSourceInlineDisplayString, type IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { plural } from '../../utils/stringUtils.js';
type MatcherWithSource = {
  matcher: string;
  sources: HookSource[];
  hookCount: number;
};
type Props = {
  selectedEvent: HookEvent;
  matchersForSelectedEvent: string[];
  hooksByEventAndMatcher: Record<HookEvent, Record<string, IndividualHookConfig[]>>;
  eventDescription: string;
  onSelect: (matcher: string) => void;
  onCancel: () => void;
};
export function SelectMatcherMode(t0) {
  return null;
}
function _temp3(item) {
  const sourceText = item.sources.map(hookSourceInlineDisplayString).join(", ");
  const matcherLabel = item.matcher || "(all)";
  return {
    label: `[${sourceText}] ${matcherLabel}`,
    value: item.matcher,
    description: `${item.hookCount} ${plural(item.hookCount, "hook")}`
  };
}
function _temp2() {
  return <Text>Esc to go back</Text>;
}
function _temp(h) {
  return h.source;
}
