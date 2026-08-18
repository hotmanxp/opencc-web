// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FsSearchList, findMatchIndices } from './FsSearchList.js';
import type { FsSearchEntry } from '../../../../shared/fs.js';

const sampleEntries: FsSearchEntry[] = [
  { path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 },
  { path: 'src/FooRunner.tsx', name: 'FooRunner.tsx', type: 'file', score: 30 },
  { path: 'docs/runbook.md', name: 'runbook.md', type: 'file', score: 10 },
];

describe('findMatchIndices', () => {
  test('returns empty when query is empty', () => {
    expect(findMatchIndices('abc', '')).toEqual([]);
  });
  test('returns empty when no subsequence match', () => {
    expect(findMatchIndices('abc', 'xyz')).toEqual([]);
  });
  test('returns positions for case-insensitive subsequence', () => {
    expect(findMatchIndices('src/Foo.ts', 'foo')).toEqual([4, 5, 6]);
  });
});

describe('FsSearchList', () => {
  test('renders empty when query is empty', () => {
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query=""
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByTestId('fs-search-row')).toBeNull();
  });

  test('renders one row per entry with path', () => {
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('fs-search-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-path')).toBe('src/foo.ts');
  });

  test('clicking a row fires onSelect with that path', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getAllByTestId('fs-search-row')[0]);
    expect(onSelect).toHaveBeenCalledWith('src/foo.ts');
  });

  test('right-clicking a row fires onItemContextMenu with path and coords', () => {
    const onItemContextMenu = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={() => {}}
        onItemContextMenu={onItemContextMenu}
      />,
    );
    const rows = screen.getAllByTestId('fs-search-row');
    fireEvent.contextMenu(rows[1], { clientX: 120, clientY: 240 });
    expect(onItemContextMenu).toHaveBeenCalledWith('src/FooRunner.tsx', 120, 240);
  });

  test('renders plain path without per-character highlight', () => {
    render(
      <FsSearchList
        entries={[{ path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 }]}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={() => {}}
      />,
    );
    const row = screen.getAllByTestId('fs-search-row')[0];
    expect(row.querySelectorAll('mark').length).toBe(0);
    expect(row.textContent).toBe('src/foo.ts');
  });

  test('shows empty hint when entries=[]', () => {
    render(
      <FsSearchList
        entries={[]}
        loading={false}
        error={null}
        truncated={false}
        query="nope"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/无匹配/)).toBeTruthy();
  });

  test('shows error message when error is set', () => {
    render(
      <FsSearchList
        entries={[]}
        loading={false}
        error="boom"
        truncated={false}
        query="foo"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('boom')).toBeTruthy();
  });

  test('shows truncated tail when truncated=true', () => {
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated
        query="foo"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/结果已截断/)).toBeTruthy();
  });
});
