import React from 'react';
import { Empty, Spin } from 'antd';
import type {
  FsContentSearchEntry,
  FsContentSearchMatch,
} from '../../../../shared/fs.js';

export interface FsContentSearchListProps {
  entries: FsContentSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (path: string, line: number) => void;
  /** 行右键回调(插入对话/复制/显示等)。path 为相对 cwd 的路径。 */
  onItemContextMenu?: (path: string, x: number, y: number, kind?: 'file' | 'dir') => void;
}

const TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)';

/**
 * Split `text` into [before, highlighted, after] JSX nodes around the
 * submatch byte-offset range. Returns a single string node when the
 * range is empty or out of bounds (defensive — should not happen for
 * well-formed server output).
 */
export function highlightLine(
  text: string,
  submatch: { start: number; end: number },
): JSX.Element[] {
  const { start, end } = submatch;
  if (end <= start || start < 0 || end > text.length) {
    return [<React.Fragment key="full">{text}</React.Fragment>];
  }
  const before = text.slice(0, start);
  const hit = text.slice(start, end);
  const after = text.slice(end);
  return [
    <React.Fragment key="b">{before}</React.Fragment>,
    <span
      key="hit"
      data-testid="fs-content-hit"
      className="rounded-sm"
      style={{ background: 'rgba(255, 200, 0, 0.4)' }}
    >
      {hit}
    </span>,
    <React.Fragment key="a">{after}</React.Fragment>,
  ];
}

const ROW_CLASS = 'px-2.5 py-1.5 rounded cursor-pointer font-mono text-xs flex items-baseline gap-2 text-[color:var(--text-dim-85)]';

export function FsContentSearchList(props: FsContentSearchListProps): JSX.Element {
  const { entries, loading, error, truncated, query, onSelect, onItemContextMenu } = props;

  if (!query.trim()) {
    return <div data-testid="fs-content-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-content-loading" className="p-4 text-center">
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-content-error" className="p-4">
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-content-empty" className="p-4">
        <Empty description={`无内容匹配: "${query.trim()}"`} />
      </div>
    );
  }

  return (
    <div
      data-testid="fs-content-list"
      className="flex flex-col gap-0.5 py-1"
    >
      {entries.map((e) => {
        // Display only the first match per file (per spec). The remaining
        // matches are still on the result object so callers can show counts
        // or expand later.
        const first: FsContentSearchMatch = e.matches[0];
        const extra = e.matches.length > 1 ? ` (+${e.matches.length - 1} more)` : '';
        return (
          <div
            key={e.path}
            data-testid="fs-content-row"
            data-path={e.path}
            data-line={first.line}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(e.path, first.line)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              // 内容搜索只回文件,按 file 处理
              onItemContextMenu?.(e.path, ev.clientX, ev.clientY, 'file');
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(e.path, first.line);
              }
            }}
            className={ROW_CLASS}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <span className="text-[color:var(--text-dim-55)] text-[11px] whitespace-nowrap">
              {e.path}:{first.line}
              {extra}
            </span>
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-pre">
              {highlightLine(first.text, first.submatch)}
            </span>
          </div>
        );
      })}
      {truncated && (
        <div
          data-testid="fs-content-truncated"
          className="px-2.5 py-1.5 text-[color:var(--text-dim-45)] text-[11px] italic"
        >
          {TRUNCATED_TAIL}
        </div>
      )}
    </div>
  );
}
