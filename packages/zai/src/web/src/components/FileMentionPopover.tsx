import { useCallback, useEffect, useRef } from "react";
import { FolderOutlined, FileOutlined, LoadingOutlined } from "@ant-design/icons";
import type { FsSearchEntry } from "../../../shared/fs.js";

/**
 * FileMentionPopover — `@` 触发后弹出的文件补全下拉。
 *
 * 设计参考:
 * - dsh `packages/client/ui-input-trigger/src/client/MenuView.tsx` 的 combobox
 *   模式:focus 留在 textarea,popup 只显示候选并响应键盘导航
 * - zai 现有 `/` slash dropdown 与 `QuickCommandPopover` 的视觉风格:
 *   bottom-anchored + 紫/橙高亮 + brand color 边线
 *
 * 与 QuickCommandPopover 的关键差异:
 * - **没有搜索框** —— 搜索是隐式的(用户在 textarea 敲字符 → 上层 hook 重新拉数据)
 * - **数据来源是 hook 的 snapshot** —— items / loading / error / truncated 透传
 * - **mousedown 而非 click** —— 防止 textarea 失焦抢在 onSelect 之前(combo 模式核心约束)
 * - **键盘:↑↓ 移高亮,Enter 选中,Esc 关闭** —— 与 `/` dropdown 行为一致
 *
 * 父组件负责:把 `useFsMentionSearch` 的输出传入、选中时调 grammar 替换 token、把
 * popover 挂载在 textarea 上方。
 */
export interface FileMentionPopoverProps {
  items: FsSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (entry: FsSearchEntry) => void;
  onDismiss: () => void;
  /** 可选:空状态文案(默认 "无匹配文件") */
  emptyText?: string;
}

// 显示上限:与 `/` dropdown 一致,避免超长列表拖慢滚动。
const MAX_VISIBLE = 30;

export default function FileMentionPopover({
  items,
  loading,
  error,
  truncated,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onDismiss,
  emptyText = "无匹配文件",
}: FileMentionPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const visible = items.slice(0, MAX_VISIBLE);

  // 外部点击关闭。container 内部点击不触发(包括 mousedown on rows,
  // 因为 onMouseDown 在 row 那一层就 e.preventDefault + onSelect)。
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onDismiss]);

  const handleSelect = useCallback(
    (entry: FsSearchEntry) => {
      onSelect(entry);
    },
    [onSelect],
  );

  // 容器键盘导航: textarea 拿到焦点时由父组件把 keydown 事件转发过来,
  // 这里只处理 popover 自己的滚动与高亮逻辑。父组件仍负责
  // 把"列表为空时 Esc/Enter 该如何"等边界条件翻译过来。
  // 注:键盘事件如果传到这里(例如 popover 拿到焦点时),照样响应。
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (visible.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault();
          onDismiss();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onActiveIndexChange((activeIndex + 1) % visible.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onActiveIndexChange(
          (activeIndex - 1 + visible.length) % visible.length,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = visible[activeIndex];
        if (it) handleSelect(it);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [visible, activeIndex, onActiveIndexChange, handleSelect, onDismiss],
  );

  // 滚动到 active 行 — Enter 选中时确保视口可见。
  useEffect(() => {
    const el = containerRef.current?.querySelector(
      '[data-active="true"]',
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      data-testid="file-mention-popover"
      role="listbox"
      aria-label="文件候选列表"
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        bottom: "calc(100% + 4px)",
        left: 0,
        right: 0,
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        boxShadow: "0 4px 24px var(--text-dim-50)",
        zIndex: 1100,
        overflow: "hidden",
        maxHeight: 320,
      }}
    >
      {/* 顶部条:状态行(loading / 截断 / 错误) */}
      <div
        style={{
          padding: "4px 10px",
          fontSize: 11,
          color: error ? "var(--danger, #ff4d4f)" : "var(--text-dim-45)",
          borderBottom: "1px solid var(--border-faint)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {error && <span data-testid="file-mention-error">{error}</span>}
        {!error && loading && (
          <>
            <LoadingOutlined />
            <span>搜索中…</span>
          </>
        )}
        {!error && !loading && truncated && (
          <span data-testid="file-mention-truncated">结果被截断,继续输入细化</span>
        )}
      </div>

      {/* 列表区:对齐 dsh MenuView .viewport,4px inset + rounded items */}
      <div
        data-testid="file-mention-list"
        style={{
          overflowY: "auto",
          maxHeight: 280,
          padding: "4px",
        }}
      >
        {visible.length === 0 && !loading && (
          <div
            data-testid="file-mention-empty"
            style={{
              padding: "16px 12px",
              fontSize: 12,
              color: "var(--text-dim-45)",
              textAlign: "center",
            }}
          >
            {error ? "" : emptyText}
          </div>
        )}
        {visible.map((entry, idx) => {
          const isActive = idx === activeIndex;
          const isDir = entry.type === "dir";
          return (
            <div
              key={entry.path}
              role="option"
              aria-selected={isActive}
              data-active={isActive}
              data-testid={`file-mention-row-${entry.path}`}
              data-entry-type={entry.type}
              onMouseEnter={() => onActiveIndexChange(idx)}
              onMouseDown={(e) => {
                // mousedown 而非 click: 防止 textarea 失焦抢在 onSelect 之前。
                // onSelect 同步执行:它会用 setState 重写 input + 设光标,
                // 这一帧内 textarea 仍持有焦点,onBlur 不会触发。
                e.preventDefault();
                handleSelect(entry);
              }}
              style={{
                padding: "8px 10px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                minHeight: 40,
                border: "none",
                borderRadius: 10,
                background: isActive
                  ? "rgba(255,102,0,0.15)"
                  : "transparent",
                transition: "background 0.1s",
              }}
            >
              <span
                aria-hidden
                style={{
                  color: isDir ? "#facc15" : "var(--text-dim-45)",
                  fontSize: 14,
                  flexShrink: 0,
                  width: 16,
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isDir ? <FolderOutlined /> : <FileOutlined />}
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: "22px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: "none",
                  maxWidth: "40%",
                  minWidth: 0,
                }}
              >
                {entry.name}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-dim-45)",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {entry.path}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}