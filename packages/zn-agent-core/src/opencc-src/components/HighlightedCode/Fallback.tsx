// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { extname } from 'path';
import React, { Suspense, use, useMemo } from 'react';
import { Ansi, Text } from '../../ink.js';
import { getCliHighlightPromise } from '../../utils/cliHighlight.js';
import { logForDebugging } from '../../utils/debug.js';
import { convertLeadingTabsToSpaces } from '../../utils/file.js';
import { hashPair } from '../../utils/hash.js';
type Props = {
  code: string;
  filePath: string;
  dim?: boolean;
  skipColoring?: boolean;
};

// Module-level highlight cache — hl.highlight() is the hot cost on virtual-
// scroll remounts. useMemo doesn't survive unmount→remount. Keyed by hash
// of code+language to avoid retaining full source strings (#24180 RSS fix).
const HL_CACHE_MAX = 500;
const hlCache = new Map<string, string>();
function cachedHighlight(hl: NonNullable<Awaited<ReturnType<typeof getCliHighlightPromise>>>, code: string, language: string): string {
  const key = hashPair(language, code);
  const hit = hlCache.get(key);
  if (hit !== undefined) {
    hlCache.delete(key);
    hlCache.set(key, hit);
    return hit;
  }
  const out = hl.highlight(code, {
    language
  });
  if (hlCache.size >= HL_CACHE_MAX) {
    const first = hlCache.keys().next().value;
    if (first !== undefined) hlCache.delete(first);
  }
  hlCache.set(key, out);
  return out;
}
export function HighlightedCodeFallback(t0: Props): React.ReactNode | null {
  return null;
}
function Highlighted(t0: {
  codeWithSpaces: string;
  language: string;
}): React.ReactNode | null {
  return null;
}
