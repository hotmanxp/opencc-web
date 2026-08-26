import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input, type InputRef } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import type { SlashItem } from "./quickCommandTypes.js";

/**
 * QuickCommandPopover — 桌面端「+ 按钮」唤出的命令/技能选择弹层。
 *
 * 参考 deepseek-harness `packages/client/ui-commands/src/client/PopupSelectView.tsx`:
 *   - 浮动卡片锚定在输入框上方
 *   - 内置搜索框(打开时自动 focus)
 *   - 键盘导航 ↑↓ / Enter / Esc
 *   - 外部点击 / Esc 关闭
 *   - 选中后回调 `onSelect`,由父组件(`AgentInputBox`)决定后续
 *     执行 / 插入文本的语义
 *
 * 与 `/` slash 自动补全下拉的关系:
 *   - 两条独立路径。`/` slash 是输入法的"实时补全",本组件是"按钮唤出 + 搜索"。
 *   - 共享 `SlashItem` 类型与 `selectSlashItem` 行为,选中后行为完全一致。
 *
 * 自身 only 管理: `search` 输入态 + `activeIndex` 高亮位 + 外部点击关闭。
 * 父组件传入 `items` (来自 `/api/slash`) 与 `onSelect` (调用 `selectSlashItem`)。
 */
export interface QuickCommandPopoverProps {
  items: SlashItem[];
  onClose: () => void;
  onSelect: (item: SlashItem) => void | Promise<void>;
}

// 模糊匹配: 字符按顺序在 target 中出现, 越连续分数越高.
// 与 AgentInputBox.filteredSlash 里的同名函数一致(同步复制, 避免跨文件依赖).
function fuzzyMatch(query: string, target: string): number {
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  const t = target.toLowerCase();
  for (let ti = 0; ti < t.length && qi < query.length; ti++) {
    if (t[ti] === query[qi]) {
      const gap = lastMatchIdx >= 0 ? ti - lastMatchIdx - 1 : ti;
      score += gap === 0 ? 10 : Math.max(1, 10 - gap);
      lastMatchIdx = ti;
      qi++;
    }
  }
  return qi === query.length ? score : 0;
}

/**
 * 上限 30 行, 与 `/` slash 下拉保持一致, 避免超长列表造成滚动卡顿.
 */
const MAX_VISIBLE = 30;

export default function QuickCommandPopover({
  items,
  onClose,
  onSelect,
}: QuickCommandPopoverProps) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // AntD 5 Input 的 ref 类型是 InputRef (rc-input), 它有 focus() 方法与
  // input 属性(实际 HTMLInputElement). 通过 forwardRef 拿到 InputRef 后直接
  // 调 focus().
  const searchRef = useRef<InputRef>(null);

  // 打开时 focus 搜索框 + 重置 activeIndex 与 search.
  // 直接在 effect 内 focus: ref 已挂载(effect 在 commit 后运行),
  // 避免 happy-dom 下 setTimeout(0) 不触发的问题.
  useEffect(() => {
    setActiveIndex(0);
    setSearch("");
    searchRef.current?.focus();
  }, []);

  // 外部点击关闭 — 容器内点击不触发.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // 过滤 + 排序: commands 在前, skills 在后, 各自按 fuzzy 分数降序.
  const filtered = useMemo<SlashItem[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      const cmds = items
        .filter((i) => i.kind === "command")
        .sort((a, b) => a.name.localeCompare(b.name));
      const sks = items
        .filter((i) => i.kind === "skill")
        .sort((a, b) => a.name.localeCompare(b.name));
      return [...cmds, ...sks].slice(0, MAX_VISIBLE);
    }
    const scoreItem = (it: SlashItem) => {
      const nameScore = fuzzyMatch(q, it.name);
      if (nameScore === 0) return 0;
      const descScore = fuzzyMatch(q, it.description);
      return nameScore + (descScore > 0 ? descScore * 0.3 : 0);
    };
    const cmds = items
      .filter((i) => i.kind === "command")
      .map((it) => ({ it, s: scoreItem(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
    const sks = items
      .filter((i) => i.kind === "skill")
      .map((it) => ({ it, s: scoreItem(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
    return [...cmds, ...sks].slice(0, MAX_VISIBLE);
  }, [items, search]);

  // 过滤结果变化时, activeIndex 归零, 避免越界.
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // 选中当前高亮项.
  const handleSelect = useCallback(
    (item: SlashItem) => {
      void onSelect(item);
    },
    [onSelect],
  );

  // 容器键盘: ↑↓ 移高亮, Enter 选中, Esc 关闭.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length === 0) return;
        setActiveIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length === 0) return;
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = filtered[activeIndex];
        if (it) handleSelect(it);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, activeIndex, handleSelect, onClose],
  );

  // 滚动到 active 行 — Enter 选中时确保视口可见.
  useEffect(() => {
    const el = containerRef.current?.querySelector(
      '[data-active="true"]',
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      data-testid="quick-command-popover"
      role="listbox"
      aria-label="命令/技能列表"
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        right: 0,
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        boxShadow: "0 4px 24px var(--text-dim-50)",
        zIndex: 1100,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        maxHeight: 360,
      }}
    >
      {/* 顶部条: 搜索框 + 关闭按钮 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <Input
          ref={searchRef}
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索命令/技能"
          data-testid="quick-command-search"
          style={{ flex: 1 }}
          allowClear
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          data-testid="quick-command-close"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-dim-45)",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CloseOutlined />
        </button>
      </div>

      {/* 列表区 */}
      <div
        style={{
          overflowY: "auto",
          maxHeight: 320,
          padding: "4px 0",
        }}
      >
        {filtered.length === 0 && (
          <div
            data-testid="quick-command-empty"
            style={{
              padding: "16px 12px",
              fontSize: 12,
              color: "var(--text-dim-45)",
              textAlign: "center",
            }}
          >
            {search.trim() ? "没有匹配的命令/技能" : "暂无可用命令/技能"}
          </div>
        )}
        {filtered.map((item, idx) => {
          const isActive = idx === activeIndex;
          return (
            <div
              key={item.kind + ":" + item.name}
              role="option"
              aria-selected={isActive}
              data-active={isActive}
              data-testid={`quick-command-row-${item.name}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onMouseDown={(e) => {
                // mousedown 而非 click: 防止 input 失焦抢在 onSelect 之前.
                e.preventDefault();
                handleSelect(item);
              }}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: isActive
                  ? "rgba(255,102,0,0.15)"
                  : "transparent",
                borderLeft: isActive
                  ? "3px solid #ff6600"
                  : "3px solid transparent",
                transition: "background 0.1s",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#a78bfa",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: "nowrap",
                  minWidth: 140,
                  flexShrink: 0,
                }}
              >
                /{item.displayName ?? item.name}
              </span>
              {item.description && (
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-dim-45)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {item.pluginName && (
                    <span style={{ color: "rgba(167,139,250,0.75)" }}>
                      ({item.pluginName}){" "}
                    </span>
                  )}
                  {item.description}
                  {item.argumentHint ? ` · ${item.argumentHint}` : ""}
                </span>
              )}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: 4,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color:
                    item.kind === "command" ? "#a78bfa" : "var(--text-dim-45)",
                  background:
                    item.kind === "command"
                      ? "rgba(167,139,250,0.18)"
                      : "var(--bg-faint-08)",
                  flexShrink: 0,
                }}
              >
                {item.kind}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
