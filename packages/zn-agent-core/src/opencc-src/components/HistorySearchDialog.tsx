// @ts-nocheck
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { type TimestampedHistoryEntry } from '../history.js'
import type { HistoryEntry } from '../utils/config.js';
type Props = {
  initialQuery?: string;
  onSelect: (entry: HistoryEntry) => void;
  onCancel: () => void;
};
const PREVIEW_ROWS = 6;
const AGE_WIDTH = 8;
type Item = {
  entry: TimestampedHistoryEntry;
  display: string;
  lower: string;
  firstLine: string;
  age: string;
};
export function HistorySearchDialog({
  initialQuery,
  onSelect,
  onCancel
}: Props): React.ReactNode | null {
  // @ts-ignore
  return null;
}
function isSubsequence(text: string, query: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++;
  }
  return j === query.length;
}
