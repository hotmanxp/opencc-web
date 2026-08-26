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
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

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
      style={{ background: 'rgba(255, 200, 0, 0.4)', borderRadius: 2 }}
    >
      {hit}
    </span>,
    <React.Fragment key="a">{after}</React.Fragment>,
  ];
}

const rowStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: MONO,
  fontSize: 12,
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  color: 'var(--text-dim-85)',
};

const pathStyle: React.CSSProperties = {
  color: 'var(--text-dim-55)',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

const previewStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
};

export function FsContentSearchList(props: FsContentSearchListProps): JSX.Element {
  const { entries, loading, error, truncated, query, onSelect, onItemContextMenu } = props;

  if (!query.trim()) {
    return <div data-testid="fs-content-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-content-loading" style={{ padding: 16, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-content-error" style={{ padding: 16 }}>
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-content-empty" style={{ padding: 16 }}>
        <Empty description={`无内容匹配: "${query.trim()}"`} />
      </div>
    );
  }

  return (
    <div
      data-testid="fs-content-list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
      }}
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
            style={rowStyle}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <span style={pathStyle}>
              {e.path}:{first.line}
              {extra}
            </span>
            <span style={previewStyle}>{highlightLine(first.text, first.submatch)}</span>
          </div>
        );
      })}
      {truncated && (
        <div
          data-testid="fs-content-truncated"
          style={{
            padding: '6px 10px',
            color: 'var(--text-dim-45)',
            fontSize: 11,
            fontStyle: 'italic',
          }}
        >
          {TRUNCATED_TAIL}
        </div>
      )}
    </div>
  );
}
