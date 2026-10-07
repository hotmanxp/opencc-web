import { useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderIcon,
  ListTodoIcon,
  PlugIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ToolGroupEntry } from "./deriveTranscriptNodes.js";
import { bucketMeta, describeTool, type ToolBucket } from "./toolBuckets.js";

const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// 每类一个图标 —— 与摘要行共用, 让「展开后的明细」和「折叠后的摘要」
// 在视觉上是同一套语汇, 而不是两套系统。
const BUCKET_ICON: Record<ToolBucket, ReactNode> = {
  runCommand: <SquareTerminalIcon size={11} />,
  fileView: <FileTextIcon size={11} />,
  fileSearch: <FileSearchIcon size={11} />,
  fileEdit: <FilePenIcon size={11} />,
  fileCreate: <FilePlusIcon size={11} />,
  folderView: <FolderIcon size={11} />,
  taskManagement: <ListTodoIcon size={11} />,
  skill: <SparklesIcon size={11} />,
  mcpCall: <PlugIcon size={11} />,
  other: <WrenchIcon size={11} />,
};

/** 分类图标: 只留该分类的主题色, 不加底色方块 —— 底色在密集的工具流里过于抢眼。 */
export function BucketBadge({ bucket }: { bucket: ToolBucket }) {
  const tint = bucketMeta(bucket).tint;
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center flex-shrink-0"
      style={{ color: tint }}
    >
      {BUCKET_ICON[bucket]}
    </span>
  );
}

/**
 * 运行段里的单条工具调用行: [徽章] 文案 预览 ›。
 *
 * 折叠态就是一行 —— 命令 / 路径 / pattern 直接跟在文案后面, 不再各占一个
 * Collapse 卡片。展开态由 renderDetail 决定渲染什么 (ToolRunGroup 传
 * ToolCallDetail; 自包含工具传它自己的 renderFull 结果)。
 */
export function ToolRunRow({
  entry,
  renderDetail,
  defaultOpen = false,
}: {
  entry: ToolGroupEntry;
  renderDetail: (entry: ToolGroupEntry) => ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const row = describeTool(entry);

  return (
    <div data-testid="tool-run-row" className="min-w-0">
      <button
        type="button"
        data-testid="tool-row-toggle"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="w-full flex items-center gap-2 min-w-0 text-left text-[13px] py-[3px] px-1 -mx-1 rounded hover:bg-[var(--bg-card)] transition-colors"
      >
        <BucketBadge bucket={row.bucket} />
        <span
          className={
            row.failed
              ? "text-[var(--accent-end)] flex-shrink-0"
              : "text-[var(--text-primary)] flex-shrink-0"
          }
        >
          {row.label}
        </span>
        {row.failed && (
          <span className="text-[11px] text-[var(--accent-end)] flex-shrink-0">
            失败
          </span>
        )}
        {row.detail && (
          <span
            className="text-xs text-[var(--text-secondary)] truncate min-w-0 flex-1"
            style={{ fontFamily: CODE_FONT_FAMILY }}
            title={row.detail}
          >
            {row.detail}
          </span>
        )}
        <span className="inline-flex items-center flex-shrink-0 text-[var(--text-tertiary)] ml-auto">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {open && <div className="mt-1 mb-2">{renderDetail(entry)}</div>}
    </div>
  );
}