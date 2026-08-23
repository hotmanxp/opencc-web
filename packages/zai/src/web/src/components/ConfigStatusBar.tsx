import { useAppStore } from "../store/useAppStore";
import ModelStatusButton from "./ModelStatusButton";
import ModeStatusButton from "./ModeStatusButton";
import EffortStatusButton from "./EffortStatusButton";
import { TaskDock } from "./TaskDock";
import BranchSelector from "./BranchSelector";

type Props = {
  cwdName: string;
  /** Per-session cwd (overrides cwdName when provided; e.g., "/Users/me/proj/sub" → renders "sub"). */
  sessionCwd?: string;
  /**
   * 当前 Git 分支. **null** 表示当前 PWD 不是 Git 目录 (server /system
   * 端点在 git rev-parse --is-inside-work-tree 失败时返回 null). 此时整段
   * <BranchSelector> 加前后两个 `·` 分隔符都不渲染, 状态栏只保留
   * `dir · model · tasks` 三段 — 避免显示误导性的 'master' 兜底.
   * 字符串 (例如 'main') 则走 BranchSelector 渲染 trigger / 弹层.
   */
  branch: string | null;
  onTaskSelect: (taskId: string) => void;
  /**
   * 右侧分屏是否展开. 展开时按钮文本做精简(权限模式去掉 (shift+tab) 提示,
   * 后台任务只显示图标),给窄屏幕 / 分屏态腾出横向空间. 默认 false(收起).
   */
  splitPaneOpen?: boolean;
  /**
   * 工作目录绝对路径. 传入后分支名变 clickable, 点击弹出分支列表(本地 + 远程,
   * 最多 10 条), 点击可切换分支. 不传 (或与 branch=null 组合) 则分支名只读
   * (兼容老调用方 & 测试).
   * 分支切换走 gitApi (复用通用 /exec), 切完后通过 store 把 instanceContext.branch
   * 立刻刷成新值, 不必等 10s 的 startBranchChecker 轮询.
   */
  cwd?: string | null;
};

export default function ConfigStatusBar({
  cwdName,
  sessionCwd,
  branch,
  onTaskSelect,
  splitPaneOpen = false,
  cwd,
}: Props) {
  // When sessionCwd is provided, show its basename; otherwise fall back to the static cwdName.
  // Browser side has no node:path, so use string split. Empty parts (from leading "/") are filtered.
  const displayName = sessionCwd
    ? sessionCwd.split('/').filter(Boolean).pop() || sessionCwd
    : cwdName

  // 移动端走 /m 路由, 视口窄(< 768). 桌面 gap=8 让分隔符 `·` 周围留白舒服;
  // 移动端降到 gap=2 + padding 收紧, 避免 `opencc-web · main · MiniMax-M3`
  // 把整行撑爆, 分隔符贴在一起也不至于糊.
  const isMobile = useAppStore((s) => s.isMobile)
  const gap = isMobile ? 2 : 8
  const padding = isMobile ? "4px 8px" : "6px 10px"

  return (
    <div
      data-testid="config-status-bar"
      style={{
        background: "var(--bg-card-hover)",
        borderTop: "1px solid var(--border-subtle)",
        padding,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "var(--text-tertiary)",
        display: "flex",
        alignItems: "center",
        gap,
      }}
    >
      {/* ModeStatusButton 内部从 useAppStore.isMobile 自动判断移动端.
          splitPaneOpen 是分屏局部状态, 仍以 prop 形式传入. */}
      <ModeStatusButton compact={splitPaneOpen} />
      <span style={{ color: "#eab308" }}>{displayName}</span>
      {/*
        非 Git 目录: branch=null. 整段 [· <BranchSelector> ·] 都不渲染,
        状态栏从 `dir · main · model · tasks` 收缩为 `dir · model · tasks`.
        不显示 'master' 兜底 (会误导用户以为 PWD 是 repo); 也不渲染 trigger,
        避免点击后 listBranches 拉 `not a git repository` 错误行.
        Git 目录: branch 是字符串, 走 BranchSelector 渲染 trigger / 弹层.
        BranchSelector 内部从 useAppStore 读 instanceContext.branch 与 isMobile,
        自己处理 store 兜底 + 移动端 Popover placement. cwd 不传时它退化为只读 span,
        老调用方/测试无需改动.
      */}
      {branch !== null && (
        <>
          <span style={{ color: "var(--text-tertiary)" }}>·</span>
          <BranchSelector cwd={cwd} branch={branch} />
        </>
      )}
      <span style={{ color: "var(--text-tertiary)" }}>·</span>
      <span style={{ color: "var(--accent-start)" }}>
        <ModelStatusButton compact={splitPaneOpen} />
      </span>
      {/* EffortStatusButton 自己根据 selected model 是否有 reasoningLevels
          列表决定是否渲染 — non-reasoning model 自动 hide,避免 picker 干扰。 */}
      <EffortStatusButton compact={splitPaneOpen} />
      <span style={{ color: "var(--text-tertiary)" }}>·</span>
      <TaskDock onSelect={onTaskSelect} compact={splitPaneOpen} />
    </div>
  );
}