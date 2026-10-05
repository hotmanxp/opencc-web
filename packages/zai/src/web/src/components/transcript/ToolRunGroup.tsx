import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ToolGroupEntry } from "./deriveTranscriptNodes.js";
import { getRenderer } from "../toolRenderers/registry.js";
import { ToolCallDetail } from "./MessageBubble.js";
import { BucketBadge, ToolRunRow } from "./ToolRunRow.js";
import { summarizeRun } from "./toolBuckets.js";

/**
 * 一段连续工具调用的呈现单位。
 *
 * 折叠态是一行分类计数摘要 ("已执行 2 条命令，已更新待办 ›"), 展开态是段内
 * 每条调用的单行明细。正在跑的段默认展开 —— 这样用户能实时看到当前命令,
 * 而已经跑完的历史段自动收成一行, 不再把对话流撑成几十张卡片。
 *
 * autoExpandRunning 由 transcriptCollapsed 控制: false (默认) 时运行中的
 * 段自动展开; true (compact 输出风格 / 右侧分屏) 时全程折叠, 优先省纵向空间。
 * 用户手动点过之后以手动值为准 (manual !== null), 否则运行中段的自动展开
 * 会让"手动收起"永远失效。
 */
export function ToolRunGroup({
  entries,
  autoExpandRunning = true,
}: {
  entries: ToolGroupEntry[];
  autoExpandRunning?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const summary = summarizeRun(entries);
  const expanded = manual ?? (autoExpandRunning && summary.active);

  return (
    <div data-testid="tool-run-group" className="my-1 mr-5">
      <button
        type="button"
        data-testid="tool-run-toggle"
        aria-expanded={expanded}
        onClick={() => setManual(!expanded)}
        className="w-full flex items-center gap-2 min-w-0 text-left text-[13px] py-[3px] px-1 -mx-1 rounded hover:bg-[var(--bg-card)] transition-colors"
      >
        {summary.buckets.length > 0 && <BucketBadge bucket={summary.buckets[0]!} />}
        <span className="text-[var(--text-primary)] truncate min-w-0">
          {summary.text}
        </span>
        {summary.errors > 0 && (
          <span className="text-[11px] text-[var(--accent-end)] flex-shrink-0">
            {summary.errors} 个失败
          </span>
        )}
        <span className="inline-flex items-center flex-shrink-0 text-[var(--text-tertiary)] ml-auto">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-0.5 pl-1">
          {entries.map((e) => {
            const evtId =
              ((e.message as { eventId?: string }).eventId as string) ??
              `tool-${e.index}`;
            return (
              <ToolRunRow
                key={evtId}
                entry={e}
                renderDetail={(entry) => {
                  const renderer = getRenderer(
                    ((entry.message as { name?: string }).name as string) ?? "",
                  );
                  // renderFull 自带完整呈现 (DiffBlock 头部 + diff + 错误),
                  // 再叠 ToolCallDetail 会把参数与结果重复渲染一遍。
                  if (renderer.renderFull) return <>{renderer.renderFull(entry.message)}</>;
                  return <ToolCallDetail msg={entry.message} />;
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}