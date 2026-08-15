import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Popover, Spin, Tooltip, message } from "antd";
import { CheckOutlined, BranchesOutlined } from "@ant-design/icons";
import { gitApi } from "../lib/gitApi.js";
import { useAppStore } from "../store/useAppStore.js";
import type { GitBranch } from "../../../shared/git.js";

const MAX_BRANCHES = 10;

type Props = {
  /** 工作目录绝对路径. 不传则分支名只读(返回纯 span),与 ConfigStatusBar 老调用方行为一致. */
  cwd: string | null;
  /** 当前分支名(Prop 兜底,store 已有值时优先用 store). */
  branch: string;
  /**
   * 触发器样式覆盖. 默认是 ConfigStatusBar 风格的紧凑绿字带分支图标;
   * MobileQuickDrawer Git tab 可传 marginLeft 等微调.
   */
  triggerStyle?: React.CSSProperties;
  /**
   * testid 前缀. 默认 'branch-' 兼容 ConfigStatusBar 现有测试;
   * MobileQuickDrawer Git tab 用 'mobile-branch-' 避免与底部状态栏的 trigger 冲突.
   * 拼出 trigger / list / list-item-{name} / list-error 四个 testid.
   */
  testIdPrefix?: string;
};

/**
 * 分支选择器: 触发器 (分支名) 点击弹 Popover, 列出本地优先 + 远程分支 (最多 MAX_BRANCHES),
 * 点击切换. 切换成功后通过 useAppStore.setInstanceContext 把新分支立刻写回 store,
 * 不必等 10s 的 SSE branch.changed 轮询.
 *
 * 移动端 (isMobile=true) Popover placement 切到 'bottom' — 393px 窄屏 + 底部触发器场景
 * 'topRight' 容易溢出, 参考 ModelStatusButton.tsx:302.
 */
export default function BranchSelector({
  cwd,
  branch,
  triggerStyle,
  testIdPrefix = "branch-",
}: Props) {
  const isMobile = useAppStore((s) => s.isMobile);
  const storeBranch = useAppStore((s) => s.instanceContext?.branch ?? null);
  const setInstanceContext = useAppStore((s) => s.setInstanceContext);
  const displayedBranch = storeBranch ?? branch;

  // Popover 状态: 打开时 fetch, 关闭后保留数据但清除选中态.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // 记录切换中的目标分支名, 用于那一行的 loading 标记(避免整列表转圈).
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const cwdKey = cwd ?? "";
  useEffect(() => {
    if (!popoverOpen || !cwd) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    gitApi
      .listBranches(cwd)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.branches) {
          setBranches(res.branches);
        } else {
          setBranches([]);
          setErrorText(res.error ?? "无法获取分支列表");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setBranches([]);
        setErrorText(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [popoverOpen, cwdKey, cwd]);

  // 本地分支优先 + 截断到 MAX_BRANCHES 条; 远程分支展开放后面(折叠到 N 条以内).
  // 排序: 当前 HEAD 始终在最前; 其余按本地优先 + 字典序.
  // 这里只排序不截断 — 截断/过滤交由 BranchList(搜索时取消 MAX_BRANCHES 限制).
  const sortedBranches = useMemo(() => {
    return [...branches].sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [branches]);

  const handleSwitch = async (name: string) => {
    if (!cwd || switchingTo) return;
    setSwitchingTo(name);
    try {
      const res = await gitApi.switchBranch(cwd, name);
      if (res.ok) {
        message.success(`已切换到 ${res.branch ?? name}`);
        // 立刻把 instanceContext.branch 推到新值, 不必等 SSE branch.changed 轮询
        // (startBranchChecker 默认 10s 才查一次, 体感会卡顿). store 已有值时
        // 直接合并; instanceContext 为 null (e.g. 还没 hydrate) 时跳过, 下次
        // SSE 推送会自然对齐.
        const ctx = useAppStore.getState().instanceContext;
        if (ctx) {
          setInstanceContext({ ...ctx, branch: res.branch ?? name });
        }
        // 同步本地缓存: 把切中的分支标 isCurrent, 关掉弹层.
        setBranches((prev) =>
          prev.map((b) => ({
            ...b,
            isCurrent: b.name === (res.branch ?? name),
          })),
        );
        setPopoverOpen(false);
      } else {
        message.error(res.error ?? "切换失败");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitchingTo(null);
    }
  };

  // 不传 cwd 时分支名只读 — 兼容老调用方 & 测试.
  if (!cwd) {
    return <span style={{ color: "var(--success)" }}>{displayedBranch}</span>;
  }

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(v) => setPopoverOpen(v)}
      trigger="click"
      placement={isMobile ? "bottom" : "topRight"}
      arrow={false}
      destroyTooltipOnHide
      content={
        <BranchList
          branches={sortedBranches}
          loading={loading}
          error={errorText}
          switchingTo={switchingTo}
          onSelect={handleSwitch}
          testIdPrefix={testIdPrefix}
        />
      }
    >
      <Tooltip
        title="点击查看/切换分支(可搜索过滤)"
        placement="top"
        destroyOnHidden
      >
        <span
          role="button"
          tabIndex={0}
          aria-label={`当前分支 ${displayedBranch},点击切换`}
          data-testid={`${testIdPrefix}trigger`}
          style={{
            color: "var(--success)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "0 4px",
            borderRadius: 3,
            userSelect: "none",
            ...triggerStyle,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPopoverOpen(true);
            }
          }}
        >
          <BranchesOutlined style={{ fontSize: 11, opacity: 0.85 }} />
          {displayedBranch}
        </span>
      </Tooltip>
    </Popover>
  );
}

function BranchList({
  branches,
  loading,
  error,
  switchingTo,
  onSelect,
  testIdPrefix,
}: {
  branches: GitBranch[];
  loading: boolean;
  error: string | null;
  switchingTo: string | null;
  onSelect: (name: string) => void;
  testIdPrefix: string;
}) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 弹层挂载时自动 focus 搜索框, 减少一次点击.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // 查询非空 → 在全集(branches)里按 name.includes 过滤, 取消 MAX_BRANCHES 截断,
  // 让用户真正能找到被截断掉的分支; 查询为空 → 保留原 MAX_BRANCHES 截断行为.
  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return branches.slice(0, MAX_BRANCHES);
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const isSearching = query.trim().length > 0;
  const headerCountLabel = isSearching
    ? `${filteredBranches.length}/${branches.length} 个匹配`
    : branches.length > MAX_BRANCHES
      ? `显示前 ${MAX_BRANCHES}/${branches.length}`
      : `${branches.length} 个`;

  const styles: Record<string, React.CSSProperties> = {
    wrap: {
      width: "min(280px, calc(100vw - 84px))",
      background: "var(--bg-popup)",
      borderRadius: 6,
      padding: 10,
      maxHeight: 320,
      overflowY: "auto",
      color: "#fff",
      fontSize: 12,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    },
    header: {
      fontSize: 11,
      fontWeight: 600,
      color: "var(--text-dim-55)",
      marginBottom: 8,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    },
    search: { marginBottom: 8 },
    list: { listStyle: "none", padding: 0, margin: 0 },
    item: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "5px 6px",
      borderRadius: 4,
      cursor: "pointer",
    },
    empty: {
      fontSize: 12,
      color: "var(--text-dim-40)",
      padding: "16px 8px",
      textAlign: "center",
    },
  };
  return (
    <div style={styles.wrap} data-testid={`${testIdPrefix}list`}>
      <div style={styles.header}>
        <span>分支</span>
        <span style={{ fontWeight: 400, color: "var(--text-dim-45)" }}>
          {headerCountLabel}
        </span>
      </div>
      <Input
        ref={searchInputRef}
        size="small"
        allowClear
        placeholder="搜索分支"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid={`${testIdPrefix}list-search`}
        style={styles.search}
      />
      {loading && branches.length === 0 ? (
        <div style={{ ...styles.empty, display: "flex", justifyContent: "center" }}>
          <Spin size="small" />
        </div>
      ) : error ? (
        <div style={styles.empty} data-testid={`${testIdPrefix}list-error`}>
          {error}
        </div>
      ) : filteredBranches.length === 0 ? (
        <div style={styles.empty}>
          {isSearching ? `无匹配 “${query.trim()}” 的分支` : "暂无分支"}
        </div>
      ) : (
        <ul style={styles.list}>
          {filteredBranches.map((b) => {
            const switching = switchingTo === b.name;
            return (
              <li
                key={b.name}
                role="button"
                tabIndex={0}
                aria-current={b.isCurrent ? "true" : undefined}
                aria-label={`分支 ${b.name}${b.isCurrent ? " (当前)" : ""}`}
                data-testid={`${testIdPrefix}list-item-${b.name}`}
                style={{
                  ...styles.item,
                  background: b.isCurrent
                    ? "rgba(82, 196, 26, 0.12)"
                    : "transparent",
                  opacity: switchingTo && !switching ? 0.5 : 1,
                  pointerEvents:
                    switchingTo && !switching ? "none" : "auto",
                }}
                onClick={() => {
                  if (b.isCurrent || switchingTo) return;
                  onSelect(b.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (b.isCurrent || switchingTo) return;
                    onSelect(b.name);
                  }
                }}
              >
                <span
                  style={{
                    width: 14,
                    color: b.isCurrent ? "#52c41a" : "var(--text-dim-25)",
                    fontSize: 11,
                    textAlign: "center",
                    flexShrink: 0,
                  }}
                >
                  {switching ? <Spin size="small" /> : b.isCurrent ? <CheckOutlined /> : "·"}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: b.isCurrent
                      ? "#52c41a"
                      : b.isRemote
                        ? "var(--text-dim-55)"
                        : "var(--text-dim-85)",
                  }}
                  title={b.name}
                >
                  {b.name}
                </span>
                {b.isRemote && (
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim-45)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 3,
                      padding: "0 4px",
                      flexShrink: 0,
                    }}
                  >
                    remote
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}