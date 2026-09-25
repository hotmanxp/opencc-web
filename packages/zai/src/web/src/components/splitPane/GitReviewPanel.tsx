import { useMemo, useState } from 'react';
import {
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Segmented,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  CheckIcon,
  GitBranchIcon,
  GitCommitIcon,
  LayersIcon,
  RotateCwIcon,
  Undo2Icon,
} from 'lucide-react';
import { useGitReview } from './useGitReview.js';
import { DiffViewByFile } from './DiffView.js';
import { STATUS_COLORS, STATUS_LABELS } from './shared.js';
import type {
  GitLogEntry,
  GitMode,
  GitStatusChar,
  GitStatusEntry,
} from '../../../../shared/git.js';

/**
 * Full Git review panel — replaces the legacy `GitTab` (single-file list +
 * diff) with a 4-mode surface: Worktrees, Changes, Commits, Branches.
 * Right pane adapts per mode: file diff (Changes), commit diff (Commits),
 * or empty (Worktrees/Branches — those modes are list-only on the left).
 *
 * Theme: uses zai's CSS variables (`--bg-faint-*` / `--text-dim-*`) so
 * the dark/light theme toggle in `useThemeToggle` re-skins the panel for
 * free. No MutationObserver against `data-ds-dark-theme` needed.
 */
export function GitReviewPanel({ cwd }: { cwd: string | null }) {
  const [mode, setMode] = useState<GitMode>('changes');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null);

  const review = useGitReview({
    cwd,
    mode,
    selectedPath,
    selectedCommit,
    selectedWorktree,
  });

  // Show the worktree selector only when the repo has more than one checkout
  // (otherwise the dropdown adds noise).
  const showWorktreeSelector = review.worktrees.length > 1;

  const onModeChange = (next: GitMode): void => {
    setMode(next);
    setSelectedPath(null);
    setSelectedCommit(null);
  };

  if (!cwd) {
    return (
      <div className="p-4">
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="git-review-panel">
      {/* ── Top bar: worktree selector + mode tabs + refresh ─────────── */}
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: '1px solid var(--border-light)' }}
      >
        {showWorktreeSelector && (
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={selectedWorktree ?? review.worktrees.find((w) => w.current)?.path}
            onChange={(value) => {
              setSelectedWorktree(value);
              void review
                .selectWorktree(value)
                .catch((err) => message.error(err instanceof Error ? err.message : String(err)));
            }}
            data-testid="git-worktree-select"
            options={review.worktrees.map((wt) => ({
              label: `${wt.branch}${wt.current ? ' (当前)' : ''}`,
              value: wt.path,
            }))}
          />
        )}
        <Segmented
          size="small"
          value={mode}
          onChange={(value) => onModeChange(value as GitMode)}
          data-testid="git-mode-tabs"
          options={[
            { label: '变更', value: 'changes', icon: <LayersIcon size={12} /> },
            { label: '提交', value: 'commits', icon: <GitCommitIcon size={12} /> },
            { label: '分支', value: 'branches', icon: <GitBranchIcon size={12} /> },
            ...(showWorktreeSelector
              ? [{ label: 'Worktree', value: 'worktrees' as GitMode }]
              : []),
          ]}
        />
        <span className="text-xs ml-1" style={{ color: 'var(--text-dim-55)' }}>
          {review.branch ? (
            <Tag color="orange" style={{ marginLeft: 4 }}>
              {review.branch}
            </Tag>
          ) : null}
        </span>
        <Button
          size="small"
          icon={<RotateCwIcon />}
          loading={review.loading}
          onClick={review.refetch}
          title="刷新"
          className="ml-auto"
        />
      </div>

      {/* ── Body: left list + right diff ──────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        <div
          className="overflow-y-auto py-1 flex flex-col"
          style={{ flex: '0 0 40%', borderRight: '1px solid var(--border-light)' }}
          data-testid="git-list"
        >
          {mode === 'changes' && (
            <ChangesList
              entries={review.entries}
              truncated={false /* TODO thread truncated flag */}
              selectedPath={selectedPath}
              onSelect={(p) => {
                setSelectedPath(p);
                setSelectedCommit(null);
              }}
              onStage={async (p) => {
                try {
                  await review.stage(p);
                  message.success('已暂存');
                } catch (err) {
                  message.error(err instanceof Error ? err.message : String(err));
                }
              }}
              onUnstage={async (p) => {
                try {
                  await review.unstage(p);
                  message.success('已取消暂存');
                } catch (err) {
                  message.error(err instanceof Error ? err.message : String(err));
                }
              }}
              onRevert={async (p) => {
                Modal.confirm({
                  title: '确认撤销',
                  content: `确定要撤销对 ${p} 的更改吗？此操作不可恢复。`,
                  okText: '确认撤销',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: async () => {
                    try {
                      await review.revert(p);
                      message.success('已撤销');
                      setSelectedPath(null);
                    } catch (err) {
                      message.error(err instanceof Error ? err.message : String(err));
                    }
                  },
                });
              }}
            />
          )}

          {mode === 'commits' && (
            <CommitsList
              commits={review.commits}
              selectedHash={selectedCommit}
              onSelect={(hash) => {
                setSelectedCommit(hash);
                setSelectedPath(null);
              }}
            />
          )}

          {mode === 'branches' && (
            <BranchesList
              branches={review.branches}
              currentBranch={review.branch}
              onCheckout={async (name) => {
                try {
                  await review.checkout(name);
                  message.success(`已切换到 ${name}`);
                } catch (err) {
                  message.error(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          )}

          {mode === 'worktrees' && (
            <WorktreesList
              worktrees={review.worktrees}
              selectedPath={selectedWorktree}
              onSelect={(path) => {
                setSelectedWorktree(path);
                void review
                  .selectWorktree(path)
                  .catch((err) => message.error(err instanceof Error ? err.message : String(err)));
              }}
            />
          )}
        </div>

        <div
          className="flex flex-col p-3 min-h-0 min-w-0 flex-1 overflow-hidden"
          style={{ flex: '1 1 60%' }}
          data-testid="git-detail"
        >
          {review.error ? (
            <Empty description={review.error} />
          ) : review.diff.loading ? (
            <div className="text-center p-6 text-xs" style={{ color: 'var(--text-dim-45)' }}>
              加载中…
            </div>
          ) : review.diff.error ? (
            <Empty description={review.diff.error} />
          ) : review.diff.text ? (
            <DiffViewByFile diff={review.diff.text} />
          ) : (
            <Empty
              description={
                mode === 'changes'
                  ? '选择左侧文件查看 diff'
                  : mode === 'commits'
                    ? '选择左侧提交查看 diff'
                    : '此模式无 diff 预览'
              }
            />
          )}

          {mode === 'changes' && (
            <div
              className="mt-3 pt-3 flex items-center gap-2"
              style={{ borderTop: '1px solid var(--border-light)' }}
            >
              <CommitBox cwd={cwd} onCommit={review.commit} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Changes list
// ─────────────────────────────────────────────────────────────────────────

interface ChangesListProps {
  entries: GitStatusEntry[];
  truncated: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onStage: (path: string) => Promise<void>;
  onUnstage: (path: string) => Promise<void>;
  onRevert: (path: string) => Promise<void>;
}

function ChangesList(props: ChangesListProps) {
  const { entries, truncated, selectedPath, onSelect, onStage, onUnstage, onRevert } = props;

  const grouped = useMemo(() => {
    const staged: GitStatusEntry[] = [];
    const unstaged: GitStatusEntry[] = [];
    for (const entry of entries) {
      if (entry.staged) staged.push(entry);
      else unstaged.push(entry);
    }
    return { staged, unstaged };
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
        没有变更
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {truncated && (
        <div
          className="px-3 py-1 text-[10px]"
          style={{ color: 'var(--text-dim-55)' }}
          data-testid="git-status-truncated"
        >
          ⚠ 结果超过 2000 行,已截断
        </div>
      )}
      {grouped.staged.length > 0 && (
        <Section title="已暂存" count={grouped.staged.length}>
          {grouped.staged.map((entry) => (
            <Row
              key={entry.path}
              entry={entry}
              selected={selectedPath === entry.path}
              onClick={() => onSelect(entry.path)}
              actions={
                <>
                  <Tooltip title="取消暂存">
                    <Button
                      size="small"
                      type="text"
                      icon={<Undo2Icon size={12} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onUnstage(entry.path);
                      }}
                      data-testid={`git-unstage-${entry.path}`}
                    />
                  </Tooltip>
                </>
              }
              onRevert={() => onRevert(entry.path)}
            />
          ))}
        </Section>
      )}
      {grouped.unstaged.length > 0 && (
        <Section title="未暂存" count={grouped.unstaged.length}>
          {grouped.unstaged.map((entry) => (
            <Row
              key={entry.path}
              entry={entry}
              selected={selectedPath === entry.path}
              onClick={() => onSelect(entry.path)}
              actions={
                entry.xy === '??' ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<CheckIcon size={12} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onStage(entry.path);
                    }}
                    data-testid={`git-stage-${entry.path}`}
                  />
                ) : (
                  <>
                    <Button
                      size="small"
                      type="text"
                      icon={<CheckIcon size={12} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onStage(entry.path);
                      }}
                      data-testid={`git-stage-${entry.path}`}
                    />
                  </>
                )
              }
              onRevert={() => onRevert(entry.path)}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div
        className="px-3 py-1 text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-dim-45)' }}
        data-testid={`git-section-${title}`}
      >
        {title} ({count})
      </div>
      {children}
    </div>
  );
}

interface RowProps {
  entry: GitStatusEntry;
  selected: boolean;
  onClick: () => void;
  actions: React.ReactNode;
  onRevert: () => void;
}

function Row({ entry, selected, onClick, actions, onRevert }: RowProps) {
  // Collapse the two-letter `xy` to a single char for the badge color.
  // Prefer unstaged column (matches `git status` UX).
  const statusChar = xyToStatusChar(entry.xy);
  const fileName = entry.path.split(/[\\/]/).pop() ?? entry.path;
  const dir = entry.path.slice(0, entry.path.length - fileName.length);
  return (
    <div
      role="button"
      onClick={onClick}
      className="py-1.5 px-3 cursor-pointer flex items-center gap-2 font-mono text-xs"
      style={{ background: selected ? 'rgba(255,102,0,0.12)' : 'transparent' }}
      data-testid={`git-row-${entry.path}`}
    >
      <span
        className="inline-block w-5 text-center font-bold"
        style={{ color: STATUS_COLORS[statusChar as GitStatusChar] }}
      >
        {statusChar === '??' ? '?' : statusChar}
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-px" title={entry.path}>
        <span className="font-medium overflow-hidden text-ellipsis whitespace-nowrap">{fileName}</span>
        {dir && dir !== '.' ? (
          <span
            className="text-[10px] overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ color: 'var(--ui-text-dim)' }}
          >
            {dir}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1">
        {actions}
        <Tooltip title="撤销更改">
          <Button
            type="text"
            size="small"
            icon={<Undo2Icon size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              onRevert();
            }}
          />
        </Tooltip>
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Commits / branches / worktrees — flat list rows
// ─────────────────────────────────────────────────────────────────────────

interface CommitsListProps {
  commits: GitLogEntry[];
  selectedHash: string | null;
  onSelect: (hash: string) => void;
}

function CommitsList({ commits, selectedHash, onSelect }: CommitsListProps) {
  if (commits.length === 0) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
        没有提交记录
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {commits.map((commit) => (
        <div
          key={commit.hashFull}
          role="button"
          onClick={() => onSelect(commit.hashFull)}
          className="py-1.5 px-3 cursor-pointer font-mono text-xs flex flex-col gap-px"
          style={{ background: selectedHash === commit.hashFull ? 'rgba(255,102,0,0.12)' : 'transparent' }}
          data-testid={`git-commit-${commit.hash}`}
        >
          <span className="flex items-center gap-2">
            <span style={{ color: 'var(--text-dim-55)' }}>{commit.hash}</span>
            <span className="font-medium truncate" title={commit.subject}>
              {commit.subject}
            </span>
          </span>
          <span className="text-[10px]" style={{ color: 'var(--text-dim-45)' }}>
            {commit.author} · {commit.date}
            {commit.refs ? ` · ${commit.refs}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

interface BranchesListProps {
  branches: import('../../../../shared/git').GitBranchEntry[];
  currentBranch: string | null;
  onCheckout: (name: string) => Promise<void>;
}

function BranchesList({ branches, currentBranch, onCheckout }: BranchesListProps) {
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);
  if (branches.length === 0) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
        没有分支
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <Section title="本地" count={local.length}>
        {local.map((branch) => (
          <div
            key={branch.name}
            className="py-1.5 px-3 flex items-center gap-2 font-mono text-xs"
            data-testid={`git-branch-${branch.name}`}
          >
            <span className="flex-1 min-w-0 truncate" title={branch.name}>
              {branch.current ? '● ' : '○ '}
              {branch.name}
              {branch.name === currentBranch ? (
                <Tag color="orange" style={{ marginLeft: 6 }}>
                  当前
                </Tag>
              ) : null}
            </span>
            {typeof branch.ahead === 'number' && branch.ahead > 0 ? (
              <span style={{ color: 'var(--text-dim-45)' }}>↑{branch.ahead}</span>
            ) : null}
            {typeof branch.behind === 'number' && branch.behind > 0 ? (
              <span style={{ color: 'var(--text-dim-45)' }}>↓{branch.behind}</span>
            ) : null}
            {!branch.current && (
              <Button
                size="small"
                type="text"
                onClick={() => {
                  void onCheckout(branch.name);
                }}
              >
                切换
              </Button>
            )}
          </div>
        ))}
      </Section>
      {remote.length > 0 && (
        <Section title="远程" count={remote.length}>
          {remote.map((branch) => (
            <div
              key={branch.name}
              className="py-1.5 px-3 font-mono text-xs"
              style={{ color: 'var(--text-dim-55)' }}
              data-testid={`git-branch-remote-${branch.name}`}
            >
              {branch.name}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

interface WorktreesListProps {
  worktrees: import('../../../../shared/git').GitWorktree[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function WorktreesList({ worktrees, selectedPath, onSelect }: WorktreesListProps) {
  if (worktrees.length === 0) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-dim-45)' }}>
        仓库没有 worktree 记录
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {worktrees.map((wt) => (
        <div
          key={wt.path}
          role="button"
          onClick={() => onSelect(wt.path)}
          className="py-1.5 px-3 cursor-pointer font-mono text-xs flex items-center gap-2"
          style={{ background: selectedPath === wt.path ? 'rgba(255,102,0,0.12)' : 'transparent' }}
          data-testid={`git-worktree-${wt.path}`}
        >
          <span className="flex-1 min-w-0">
            <span className="font-medium">{wt.branch}</span>
            {wt.current ? (
              <Tag color="orange" style={{ marginLeft: 6 }}>
                当前
              </Tag>
            ) : null}
            <div className="text-[10px] truncate" style={{ color: 'var(--text-dim-45)' }}>
              {wt.path}
            </div>
          </span>
          {wt.changes > 0 ? (
            <Tag color="blue">{wt.changes} 项变更</Tag>
          ) : (
            <Tag>clean</Tag>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Commit message composer
// ─────────────────────────────────────────────────────────────────────────

function CommitBox({
  cwd,
  onCommit,
}: {
  cwd: string;
  onCommit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Input.TextArea
        size="small"
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message (提交信息)"
        disabled={busy}
        data-testid="git-commit-message"
      />
      <Button
        size="small"
        type="primary"
        loading={busy}
        disabled={message.trim() === ''}
        onClick={async () => {
          setBusy(true);
          try {
            await onCommit(message);
            setMessage('');
            // eslint-disable-next-line no-console
            void import('antd').then(({ message: msg }) => msg.success('已提交'));
          } catch (err) {
            // eslint-disable-next-line no-console
            void import('antd').then(({ message: msg }) =>
              msg.error(err instanceof Error ? err.message : String(err)),
            );
          } finally {
            setBusy(false);
          }
        }}
        data-testid="git-commit-submit"
      >
        Commit
      </Button>
    </>
  );
}

/** Collapse `XY` to a single `GitStatusChar`. */
function xyToStatusChar(xy: string): GitStatusChar {
  const unstaged = xy[1] ?? ' ';
  const staged = xy[0] ?? ' ';
  if (unstaged === '?') return '??';
  if (unstaged !== ' ') {
    if (unstaged === 'M') return 'M';
    if (unstaged === 'A') return 'A';
    if (unstaged === 'D') return 'D';
    return 'M';
  }
  if (staged === 'M') return 'M';
  if (staged === 'A') return 'A';
  if (staged === 'D') return 'D';
  return 'M';
}