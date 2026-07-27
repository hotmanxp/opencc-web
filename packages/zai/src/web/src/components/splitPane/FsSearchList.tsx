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
}

const TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

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
  const { entries, loading, error, truncated, query, onSelect } = props;

  if (!query.trim()) {
    return <div data-testid="fs-search-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-search-loading" style={{ padding: 16, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-search-error" style={{ padding: 16 }}>
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-search-empty" style={{ padding: 16 }}>
        <Empty description={`无匹配文件: "${query.trim()}"`} />
      </div>
    );
  }

  return (
    <div
      data-testid="fs-search-list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
      }}
    >
      {entries.map((e) => {
        const idx = findMatchIndices(e.path, query.trim());
        return (
          <div
            key={e.path}
            data-testid="fs-search-row"
            data-path={e.path}
            onClick={() => onSelect(e.path)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(e.path);
              }
            }}
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: MONO,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--text-dim-85)',
            }}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)';
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
      {loading && (
        <div data-testid="fs-search-loading-more" style={{ padding: '4px 10px' }}>
          <Spin size="small" />
        </div>
      )}
    </div>
  );
}
