import { useEffect, useState } from 'react';
import { Button, Empty, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { DiffView } from './DiffView.js';
import { STATUS_COLORS, STATUS_LABELS } from './shared.js';
import type { GitStatusChar } from '../../../../shared/git.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

function getFileName(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(separatorIndex + 1);
}

export function GitTab({ cwd }: { cwd: string | null }) {
  const status = useGitStatus(cwd);
  const [selected, setSelected] = useState<string | null>(null);
  const diff = useGitDiff(cwd, selected);

  // When cwd changes, drop the selection — old paths no longer apply.
  useEffect(() => {
    setSelected(null);
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
      onClick={() => status.refetch()}
      title="刷新 git 状态"
    >
      刷新
    </Button>
  );

  if (status.error && !status.data?.ok) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>Git</span>
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
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          Git {branch ? <Tag color="orange" style={{ marginLeft: 6 }}>{branch}</Tag> : null}
          <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.35)' }}>{files.length} 项变更</span>
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
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 0',
          }}
        >
          {status.loading && files.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : files.length === 0 ? (
            <div style={{ padding: 16, color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
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
                        color: 'rgba(255,255,255,0.92)',
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
                          color: 'rgba(255,255,255,0.45)',
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
            maxHeight: "calc(100vh - 140px)",
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