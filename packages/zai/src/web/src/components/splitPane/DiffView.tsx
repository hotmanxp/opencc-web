import { Empty } from 'antd';
import { useMemo, useState } from 'react';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const ADD_BG = 'rgba(46,160,67,0.18)';
const ADD_FG = '#3fb950';
const DEL_BG = 'rgba(248,81,73,0.18)';
const DEL_FG = '#f85149';
const CTX_FG = 'var(--text-dim-72)';
const GUTTER_FG = 'var(--text-dim-30)';
const HUNK_FG = 'rgba(167,139,250,0.85)';
const META_FG = 'var(--text-dim-35)';

type Row =
  | { kind: 'add'; text: string; oldNumber?: number; newNumber: number }
  | { kind: 'del'; text: string; oldNumber: number; newNumber?: number }
  | { kind: 'ctx'; text: string; oldNumber: number; newNumber: number }
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string };

/** One unified-diff file section. `meta` lines are the file headers and
 *  "index ..." etc. that appear before the first hunk. */
interface FileSection {
  /** Path printed by `diff --git a/X b/Y`; falls back to "(unknown)" on
   *  pathological output. */
  path: string;
  /** +/- counts (pre-computed once for the summary badge). */
  additions: number;
  deletions: number;
  /** Lines after the first hunk header, with line numbers tracked. */
  rows: Row[];
}

/** Parse a unified diff into per-file sections. Tolerant of malformed input:
 *  any block that doesn't look like `diff --git a/X b/Y` is folded into the
 *  previous section as `meta` rows so the user still sees the content. */
function parseUnifiedDiff(diff: string): FileSection[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  const sections: FileSection[] = [];
  let current: FileSection | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Per-section counters; reset when a new file begins.
  const push = (row: Row): void => {
    if (current === null) return;
    current.rows.push(row);
    if (row.kind === 'add') current.additions += 1;
    else if (row.kind === 'del') current.deletions += 1;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const path = line.match(/ b\/(.*)$/)?.[1] ?? '(unknown)';
      current = { path, additions: 0, deletions: 0, rows: [] };
      sections.push(current);
      oldLine = 0;
      newLine = 0;
      continue;
    }
    if (current === null) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      push({ kind: 'hunk', text: line });
      continue;
    }
    // `--- a/...` and `+++ b/...` are file-header markers, not real
    // add/del lines — render as meta so they don't poison the counters.
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      push({ kind: 'add', text: line.slice(1), newNumber: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      push({ kind: 'del', text: line.slice(1), oldNumber: oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      push({ kind: 'ctx', text: line.slice(1), oldNumber: oldLine, newNumber: newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // `index ...`, `similarity ...`, `rename ...`, etc.
    push({ kind: 'meta', text: line });
  }
  return sections;
}

function rowStyle(kind: Row['kind']): React.CSSProperties {
  switch (kind) {
    case 'add':
      return { background: ADD_BG, color: ADD_FG };
    case 'del':
      return { background: DEL_BG, color: DEL_FG };
    case 'hunk':
      return { color: HUNK_FG, fontWeight: 600 };
    case 'meta':
      return { color: META_FG };
    default:
      return { color: CTX_FG };
  }
}

function formatNumber(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return <Empty description="没有差异" />;
  }
  const lines = diff.split('\n');
  return (
    <div
      data-testid="diff-view"
      style={{
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.55,
        border: '1px solid var(--border-light)',
        borderRadius: 6,
        padding: '6px 0',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
        background: 'var(--bg-faint-02)',
      }}
    >
      {lines.map((line, idx) => {
        const row = classifyFlat(line);
        return (
          <div
            key={idx}
            style={{ display: 'flex', minWidth: 'max-content', ...rowStyle(row.kind) }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 16,
                textAlign: 'center',
                color: GUTTER_FG,
                userSelect: 'none',
              }}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
            <span style={{ whiteSpace: 'pre', paddingRight: 12 }}>
              {row.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Flat single-line classifier used by the legacy `DiffView` component —
 *  no line numbers, no per-row type union. Kept around because the existing
 *  tests pin against this exact shape. */
type FlatRow =
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ctx'; text: string }
  | { kind: 'hunk'; text: string };

function classifyFlat(line: string): FlatRow {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
  return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
}

/**
 * Grouped diff renderer — splits a unified diff by `diff --git` blocks and
 * renders each file as a collapsible `<details>`. Used by `GitReviewPanel`
 * when the right pane shows either a working-tree diff or a commit diff.
 *
 * Default state: collapsed (header summary only). The user clicks the
 * filename or the +/- badge to expand. Line numbers tracked per hunk so
 * the gutter reads sensibly for both `git diff` and `git show` output.
 */
export function DiffViewByFile({ diff }: { diff: string }) {
  const sections = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (sections.length === 0) {
    return <Empty description="没有差异" />;
  }
  return (
    <div
      data-testid="diff-view-by-file"
      // flex-1 + min-h-0 — claim the parent (`git-detail`) so a long diff
      // scrolls inside the panel instead of pushing the layout out. The
      // parent gives us `overflow-hidden` + a definite height via flex, and
      // we own the vertical scroll here. Horizontal scrolling on each
      // file card stays independent so very long lines still wrap-free.
      className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
    >
      {sections.map((section, idx) => (
        <FileCard
          key={`${section.path}-${idx}`}
          section={section}
          defaultOpen={sections.length === 1}
        />
      ))}
    </div>
  );
}

function FileCard({ section, defaultOpen }: { section: FileSection; defaultOpen: boolean }) {
  // `<details>` is uncontrolled by default; we use it as-is and let the
  // browser's disclosure triangle do the heavy lifting. No AntD Collapse —
  // the simple semantic matches the rest of the split-pane style. The
  // body has its own `overflow-x-auto` so very long lines scroll sideways
  // inside the card without expanding the outer scroll container;
  // `flex-shrink-0` keeps each card at its natural height so the outer
  // container's vertical scroll can step through them.
  return (
    <details
      className="flex-shrink-0 border border-[var(--border-light)] rounded-md overflow-hidden bg-[var(--bg-faint-02)]"
      data-testid="diff-file-card"
      data-path={section.path}
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary
        className="cursor-pointer select-none px-3 py-2 flex items-center gap-3 font-mono text-xs hover:bg-[var(--bg-faint-04)]"
        style={{ color: 'var(--text-dim-85)' }}
      >
        <span className="font-semibold truncate flex-1" title={section.path}>
          {section.path}
        </span>
        <span
          className="text-[10px] font-bold"
          style={{ color: ADD_FG }}
          data-testid="diff-additions"
        >
          +{section.additions}
        </span>
        <span
          className="text-[10px] font-bold"
          style={{ color: DEL_FG }}
          data-testid="diff-deletions"
        >
          -{section.deletions}
        </span>
      </summary>
      <div className="font-mono text-[12px] leading-[1.55] overflow-x-auto">
        {section.rows.map((row, idx) => (
          <div
            key={idx}
            className="flex min-w-max"
            style={rowStyle(row.kind)}
            data-testid={`diff-row-${row.kind}`}
          >
            <span
              className="flex-shrink-0 w-12 text-right pr-2 select-none"
              style={{ color: GUTTER_FG }}
            >
              {formatNumber('oldNumber' in row ? row.oldNumber : undefined)}
            </span>
            <span
              className="flex-shrink-0 w-12 text-right pr-2 select-none border-r border-[var(--border-light)]"
              style={{ color: GUTTER_FG }}
            >
              {formatNumber('newNumber' in row ? row.newNumber : undefined)}
            </span>
            <span className="whitespace-pre px-3 flex-1">
              {row.text || '\u00a0'}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}