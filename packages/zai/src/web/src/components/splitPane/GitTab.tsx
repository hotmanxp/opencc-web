import { useEffect, useState } from 'react';
import { Button, Empty, Modal, Spin, Tag, message } from 'antd';
import { ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { DiffView } from './DiffView.js';
import { gitApi } from '../../lib/gitApi.js';
import { STATUS_COLORS, STATUS_LABELS } from './shared.js';
import type { GitStatusChar } from '../../../../shared/git.js';

function getFileName(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(separatorIndex + 1);
}

export function GitTab({ cwd }: { cwd: string | null }) {
  const status = useGitStatus(cwd);
  const [selected, setSelected] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const diff = useGitDiff(cwd, selected);

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
      <div className="p-4">
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
      <div className="p-3 flex flex-col gap-2 h-full">
        <div className="flex justify-between items-center">
          <span className="text-xs" style={{ color: 'var(--text-dim-55)' }}>Git</span>
          {refreshBtn}
        </div>
        <Empty description={status.error} />
      </div>
    );
  }

  const files = status.data?.files ?? [];
  const branch = status.data?.branch ?? null;

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex justify-between items-center py-1.5 px-3"
        style={{ borderBottom: '1px solid var(--border-light)' }}
      >
        <span className="text-xs" style={{ color: 'var(--text-dim-55)' }}>
          Git {branch ? <Tag color="orange" style={{ marginLeft: 6 }}>{branch}</Tag> : null}
          <span className="ml-2" style={{ color: 'var(--text-dim-35)' }}>{files.length} 项变更</span>
        </span>
        {refreshBtn}
      </div>
      <div className="flex flex-1 min-h-0">
        {/* Left list */}
        <div
          data-testid="git-list"
          className="overflow-y-auto py-1"
          style={{
            flex: '0 0 40%',
            height: "calc(100vh - 140px)",
            borderRight: '1px solid var(--border-light)',
          }}
        >
          {status.loading && files.length === 0 ? (
            <div className="p-4 text-center">
              <Spin />
            </div>
          ) : files.length === 0 ? (
            <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
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
                  className="py-1.5 px-3 cursor-pointer flex items-center gap-2 font-mono text-xs"
                  style={{
                    background: isSel ? 'rgba(255,102,0,0.12)' : 'transparent',
                  }}
                >
                  <span
                    className="inline-block w-5 text-center font-bold"
                    style={{ color: STATUS_COLORS[f.status as GitStatusChar] }}
                  >
                    {f.status === '??' ? '?' : f.status}
                  </span>
                  <span
                    className="flex-1 min-w-0 flex flex-col gap-px"
                    title={f.path}
                  >
                    <span className="font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                      {fileName}
                    </span>
                    {dir && dir !== '.' ? (
                      <span
                        className="text-[10px] overflow-hidden text-ellipsis whitespace-nowrap"
                        style={{ color: 'var(--ui-text-dim)' }}
                      >
                        {dir}
                      </span>
                    ) : null}
                  </span>
                  {f.staged && (
                    <span
                      className="text-[10px] rounded-sm px-1"
                      style={{
                        color: 'rgba(167,139,250,0.85)',
                        border: '1px solid rgba(167,139,250,0.35)',
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
          className="flex flex-col p-3"
          style={{
            flex: '1 1 60%',
            minWidth: 0,
            minHeight: 0,
            height: "calc(100vh - 140px)",
          }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看 diff" />
          ) : diff.loading ? (
            <div className="text-center p-6">
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