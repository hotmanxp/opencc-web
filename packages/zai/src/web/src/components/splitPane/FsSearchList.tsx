import React from 'react';
import { Empty, Spin } from 'antd';
import type { FsSearchEntry } from '../../../../shared/fs.js';

export interface FsSearchListProps {
  entries: FsSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (path: string) => void;
  /** 行右键回调(插入对话/复制/显示等)。path 为相对 cwd 的路径。 */
  onItemContextMenu?: (path: string, x: number, y: number, kind?: 'file' | 'dir') => void;
}

const TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)';

/**
 * Compute positions of `query` subsequence character matches in `text`.
 * Case-insensitive. Returns an empty array when query is empty or no match.
 */
export function findMatchIndices(text: string, query: string): number[] {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      out.push(i);
      qi++;
    }
  }
  return qi === q.length ? out : [];
}

function Highlighted({ text }: { text: string; indices: number[] }) {
  return <>{text}</>;
}

export function FsSearchList(props: FsSearchListProps): JSX.Element {
  const { entries, loading, error, truncated, query, onSelect, onItemContextMenu } = props;

  if (!query.trim()) {
    return <div data-testid="fs-search-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-search-loading" className="p-4 text-center">
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-search-error" className="p-4">
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-search-empty" className="p-4">
        <Empty description={`无匹配文件: "${query.trim()}"`} />
      </div>
    );
  }

  return (
    <div
      data-testid="fs-search-list"
      className="flex flex-col gap-0.5 py-1"
    >
      {entries.map((e) => {
        const idx = findMatchIndices(e.path, query.trim());
        return (
          <div
            key={e.path}
            data-testid="fs-search-row"
            data-path={e.path}
            onClick={() => onSelect(e.path)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              onItemContextMenu?.(e.path, ev.clientX, ev.clientY, e.type);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(e.path);
              }
            }}
            className="px-2.5 py-1.5 rounded cursor-pointer font-mono text-xs flex items-center gap-1.5 text-[color:var(--text-dim-85)]"
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <Highlighted text={e.path} indices={idx} />
          </div>
        );
      })}
      {truncated && (
        <div
          data-testid="fs-search-truncated"
          className="px-2.5 py-1.5 text-[color:var(--text-dim-45)] text-[11px] italic"
        >
          {TRUNCATED_TAIL}
        </div>
      )}
      {loading && (
        <div data-testid="fs-search-loading-more" className="px-2.5 py-1">
          <Spin size="small" />
        </div>
      )}
    </div>
  );
}
