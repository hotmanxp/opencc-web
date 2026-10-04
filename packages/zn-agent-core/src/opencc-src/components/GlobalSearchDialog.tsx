// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { resolve as resolvePath } from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Text } from '../ink.js';
import { logEvent } from '../services/analytics/index.js';
import { getCwd } from '../utils/cwd.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js';
import { highlightMatch } from '../utils/highlightMatch.js';
import { relativePath } from '../utils/permissions/filesystem.js';
import { readFileInRange } from '../utils/readFileInRange.js';
import { ripGrepStream } from '../utils/ripgrep.js';
import { FuzzyPicker } from './design-system/FuzzyPicker.js';
import { LoadingState } from './design-system/LoadingState.js';
type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};
type Match = {
  file: string;
  line: number;
  text: string;
};
type Preview = {
  file: string;
  line: number;
  content: string;
};
const VISIBLE_RESULTS = 12;
const DEBOUNCE_MS = 100;
const PREVIEW_CONTEXT_LINES = 4;
// rg -m is per-file; we also cap the parsed array to keep memory bounded.
const MAX_MATCHES_PER_FILE = 10;
const MAX_TOTAL_MATCHES = 500;

/**
 * Global Search dialog (ctrl+shift+f / cmd+shift+f).
 * Debounced ripgrep search across the workspace.
 */
export function GlobalSearchDialog(t0: Props) {
  return null;
}
function _temp4(
  query_0: string,
  controller_1: AbortController,
  setMatches_0: React.Dispatch<React.SetStateAction<Match[]>>,
  setTruncated_0: React.Dispatch<React.SetStateAction<boolean>>,
  setIsSearching_0: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const cwd = getCwd();
  let collected = 0;
  ripGrepStream(["-n", "--no-heading", "-i", "-m", String(MAX_MATCHES_PER_FILE), "-F", "-e", query_0], cwd, controller_1.signal, lines => {
    if (controller_1.signal.aborted) {
      return;
    }
    const parsed: Match[] = [];
    for (const line of lines) {
      const m_1 = parseRipgrepLine(line);
      if (!m_1) {
        continue;
      }
      const rel = relativePath(cwd, m_1.file);
      parsed.push({
        ...m_1,
        file: rel.startsWith("..") ? m_1.file : rel
      });
    }
    if (!parsed.length) {
      return;
    }
    collected = collected + parsed.length;
    collected;
    setMatches_0(prev => {
      const seen = new Set(prev.map(matchKey));
      const fresh = parsed.filter(p => !seen.has(matchKey(p)));
      if (!fresh.length) {
        return prev;
      }
      const next = prev.concat(fresh);
      return next.length > MAX_TOTAL_MATCHES ? next.slice(0, MAX_TOTAL_MATCHES) : next;
    });
    if (collected >= MAX_TOTAL_MATCHES) {
      controller_1.abort();
      setTruncated_0(true);
      setIsSearching_0(false);
    }
  }).catch(_temp2).finally(() => {
    if (controller_1.signal.aborted) {
      return;
    }
    if (collected === 0) {
      setMatches_0(_temp3);
    }
    setIsSearching_0(false);
  });
}
function _temp3(m_2: Match[]): Match[] {
  return m_2.length ? [] : m_2;
}
function _temp2(): void {}
function _temp(m: Match[]): Match[] {
  return m.length ? [] : m;
}
function matchKey(m: Match): string {
  return `${m.file}:${m.line}`;
}

/**
 * Parse a ripgrep -n --no-heading output line: "path:line:text".
 * Windows paths may contain a drive letter ("C:\..."), so a simple split on
 * the first colon would mangle the path — use a regex that captures up to
 * the first :<digits>: instead.
 * @internal exported for testing
 */
export function parseRipgrepLine(line: string): Match | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  const [, file, lineStr, text] = m;
  const lineNum = Number(lineStr);
  if (!file || !Number.isFinite(lineNum)) return null;
  return {
    file,
    line: lineNum,
    text: text ?? ''
  };
}
