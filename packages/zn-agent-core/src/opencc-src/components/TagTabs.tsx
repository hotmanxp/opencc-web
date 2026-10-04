import React from 'react';
import { stringWidth } from '../ink/stringWidth.js';
import { Box, Text } from '../ink.js';
import { truncateToWidth } from '../utils/format.js';

// Constants for width calculations - derived from actual rendered strings
const ALL_TAB_LABEL = 'All';
const TAB_PADDING = 2; // Space before and after tab text: " {tab} "
const HASH_PREFIX_LENGTH = 1; // "#" prefix for non-All tabs
const LEFT_ARROW_PREFIX = '← ';
const RIGHT_HINT_WITH_COUNT_PREFIX = '→';
const RIGHT_HINT_SUFFIX = ' (tab to cycle)';
const RIGHT_HINT_NO_COUNT = '(tab to cycle)';
const MAX_OVERFLOW_DIGITS = 2; // Assume max 99 hidden tabs for width calculation

// Computed widths
const LEFT_ARROW_WIDTH = LEFT_ARROW_PREFIX.length + MAX_OVERFLOW_DIGITS + 1; // "← NN " with gap
const RIGHT_HINT_WIDTH_WITH_COUNT = RIGHT_HINT_WITH_COUNT_PREFIX.length + MAX_OVERFLOW_DIGITS + RIGHT_HINT_SUFFIX.length; // "→NN (tab to cycle)"
const RIGHT_HINT_WIDTH_NO_COUNT = RIGHT_HINT_NO_COUNT.length;
type Props = {
  tabs: string[];
  selectedIndex: number;
  availableWidth: number;
  showAllProjects?: boolean;
};

/**
 * Calculate the display width of a tab
 */
function getTabWidth(tab: string, maxWidth?: number): number {
  if (tab === ALL_TAB_LABEL) {
    return ALL_TAB_LABEL.length + TAB_PADDING;
  }
  // For non-All tabs: " #{tag} " but truncate tag if needed
  const tagWidth = stringWidth(tab);
  const effectiveTagWidth = maxWidth ? Math.min(tagWidth, maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH) : tagWidth;
  return Math.max(0, effectiveTagWidth) + TAB_PADDING + HASH_PREFIX_LENGTH;
}

/**
 * Truncate a tag to fit within maxWidth, accounting for padding and hash prefix
 */
function truncateTag(tag: string, maxWidth: number): string {
  // Available space for the tag text itself: maxWidth - " #" - " "
  const availableForTag = maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH;
  if (stringWidth(tag) <= availableForTag) {
    return tag;
  }
  if (availableForTag <= 1) {
    return tag.charAt(0);
  }
  return truncateToWidth(tag, availableForTag);
}
export function TagTabs({
  tabs,
  selectedIndex,
  availableWidth,
  showAllProjects = false
}: Props): React.ReactNode | null {
  return null;
}
