import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Modal, Spin, Tag, message } from 'antd';
import { ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { DiffView } from './DiffView.js';
import { gitApi } from '../../lib/gitApi.js';
import { STATUS_COLORS, STATUS_LABELS } from './shared.js';
import type { GitStatusChar } from '../../../../shared/git.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

function getFileName(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(separatorIndex + 1);
}

/**
 * Derive a content-based refresh key from `status.data`. We do NOT pass the
 * object reference itself: useGitStatus polls every 5s and always returns a
 * fresh reference even when content is identical, so using the reference as
 * a refresh key would force useGitDiff to refetch on every poll — which
 * flashes the loading spinner, unmounts <DiffView/>, and resets the user's
 * scroll position. Only refetch when something actually changed (branch or
 * file list). For "same file edited multiple times" cases (status doesn't
 * change), the user can hit the manual refresh button to bump the counter.
 */
function buildStatusKey(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as { ok?: boolean; branch?: string | null; files?: { path: string; status: string; staged: boolean }[] };
  if (!d.ok || !d.files) return '';
  const branch = d.branch ?? '';
  // Use \0 as inner delimiter so file paths containing "|" don't collide.
  const fileKey = d.files
    .map((f) => `${f.path}\0${f.status}\0${f.staged ? '1' : '0'}`)
    .join('\n');
  return `${branch}\n${fileKey}`;
}

export function GitTab({ cwd }: { cwd: string | null }) {
  const status = useGitStatus(cwd);
  const [selected, setSelected] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  // Bump on manual "刷新" click so the diff refreshes even when status didn't
  // change (e.g. user re-edited an already-modified file — git status still
  // reports the same "M" entry, so the status-derived key wouldn't bump).
  const [manualRefresh, setManualRefresh] = useState(0);
  const statusKey = useMemo(() => buildStatusKey(status.data), [status.data]);
  const refreshKey = useMemo(
    () => `${statusKey}\nm:${manualRefresh}`,
    [statusKey, manualRefresh],
  );
  const diff = useGitDiff(cwd, selected, refreshKey);

  const handleRevert = async (path: string) => {
    setReverting(path);
    try {
      const res = await gitApi.revertFile(path);
      if (res.ok) {
        message.success('已撤销更改');
        status.refetch();
        if (selected === path) setSelected(null);
      } else {
        message.error(res.error ?? '撤销失败');
      }
    } catch {
      message.error('撤销失败');
    } finally {
      setReverting(null);
    }
  };

  // When cwd truly changes, drop the selection — old paths no longer apply.
  // Compare by string value, not reference: Agent.tsx derives cwd from
  // useMemo([instanceContext?.cwd, cwdBySessionForSid]) — a `branch.changed`
  // SSE event re-spreads instanceContext even when cwd itself is unchanged,
  // which would otherwise wipe the user's selection on every branch update.
  const prevCwdRef = useRef<string | null>(cwd);
  useEffect(() => {
    if (prevCwdRef.current !== cwd) {
      prevCwdRef.current = cwd;
      setSelected(null);
    }
  }, [cwd]);

  // When the status refreshes and the previously-selected file is no longer in
  // the list (e.g. the change was reverted or committed), clear the selection so
  // the diff panel resets back to the empty hint.
  const filePaths = status.data?.ok ? status.data.files.map((f) => f.path) : null;
  useEffect(() => {
    if (!selected) return;
    if (filePaths && !filePaths.includes(selected)) {
      setSelected(null);
    }
  }, [filePaths, selected]);

  if (!cwd) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  const refreshBtn = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={status.loading}
      onClick={() => {
        status.refetch();
        setManualRefresh((c) => c + 1);
      }}
      title="刷新 git 状态与 diff"
    >
      刷新
    </Button>
  );

  if (status.error && !status.data?.ok) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-dim-55)', fontSize: 12 }}>Git</span>
          {refreshBtn}
        </div>
        <Empty description={status.error} />
      </div>
    );
  }

  const files = status.data?.files ?? [];
  const branch = status.data?.branch ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          borderBottom: '1px solid var(--border-light)',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-dim-55)' }}>
          Git {branch ? <Tag color="orange" style={{ marginLeft: 6 }}>{branch}</Tag> : null}
          <span style={{ marginLeft: 8, color: 'var(--text-dim-35)' }}>{files.length} 项变更</span>
        </span>
        {refreshBtn}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left list */}
        <div
          data-testid="git-list"
          style={{
            flex: '0 0 40%',
            overflowY: 'auto',
            height: "calc(100vh - 140px)",
            borderRight: '1px solid var(--border-light)',
            padding: '4px 0',
          }}
        >
          {status.loading && files.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : files.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-dim-45)', fontSize: 12 }}>
              没有变更
            </div>
          ) : (
            files.map((f) => {
              const isSel = selected === f.path;
              const fileName = getFileName(f.path);
              const dir = f.path.slice(0, f.path.length - fileName.length - 1);
              return (
                <div
                  key={f.path}
                  role="button"
                  onClick={() => setSelected(f.path)}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: isSel ? 'rgba(255,102,0,0.12)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: MONO,
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 20,
                      textAlign: 'center',
                      color: STATUS_COLORS[f.status as GitStatusChar],
                      fontWeight: 700,
                    }}
                  >
                    {f.status === '??' ? '?' : f.status}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                    }}
                    title={f.path}
                  >
                    <span
                      style={{
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fileName}
                    </span>
                    {dir && dir !== '.' ? (
                      <span
                        style={{
                          color: 'var(--ui-text-dim)',
                          fontSize: 10,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {dir}
                      </span>
                    ) : null}
                  </span>
                  {f.staged && (
                    <span
                      style={{
                        fontSize: 10,
                        color: 'rgba(167,139,250,0.85)',
                        border: '1px solid rgba(167,139,250,0.35)',
                        borderRadius: 3,
                        padding: '0 4px',
                      }}
                      title={STATUS_LABELS[f.status as GitStatusChar]}
                    >
                      staged
                    </span>
                  )}
                  <Button
                    type="text"
                    size="small"
                    icon={<UndoOutlined />}
                    aria-label={f.status === '??' ? '删除新文件' : '撤销文件修改'}
                    loading={reverting === f.path}
                    onClick={(e) => {
                      e.stopPropagation();
                      const isNew = f.status === '??';
                      Modal.confirm({
                        title: isNew ? '确认删除' : '确认撤销',
                        content: isNew
                          ? `确定要删除新文件 ${f.path} 吗？此操作不可恢复。`
                          : `确定要撤销对 ${f.path} 的更改吗？此操作不可恢复。`,
                        okText: isNew ? '确认删除' : '确认撤销',
                        cancelText: '取消',
                        okButtonProps: { danger: true },
                        onOk: () => handleRevert(f.path),
                      });
                    }}
                    title={f.status === '??' ? '删除此新文件' : '撤销此文件的更改'}
                    style={{ color: 'var(--text-dim-45)', padding: '0 4px' }}
                  />
                </div>
              );
            })
          )}
        </div>
        {/* Right detail */}
        <div
          data-testid="git-detail"
          style={{
            flex: '1 1 60%',
            minWidth: 0,
            minHeight: 0,
            height: "calc(100vh - 140px)",
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看 diff" />
          ) : diff.loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : diff.error ? (
            <Empty description={diff.error} />
          ) : diff.data?.diff !== undefined ? (
            <DiffView diff={diff.data.diff} />
          ) : (
            <Empty description="没有差异" />
          )}
        </div>
      </div>
    </div>
  );
}