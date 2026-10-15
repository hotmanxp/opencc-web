/**
 * MentionChip — 输入框里的文件引用 chip。
 *
 * 现在它挂在 Lexical 装饰节点上(见 `input/editor/chip-node.tsx`):chip 是
 * 真实的行内元素,宽度随 label 自然撑开,不再是旧方案里被 U+FFFC 占位单元
 * 锁死宽度的 `scale(0.72)` 覆盖层 —— 那是长文件名必然被截断的根因。
 *
 * 视觉对齐 deepseek-harness `input/editor/ReferenceChip.tsx`:透明底 +
 * 强调色文字 + 图标 + 超出省略,hover 才出底色,失效态置灰加删除线;
 * 配色用 zai 品牌橙(`--accent-start`)。
 */
import { FolderIcon, FileIcon } from "lucide-react";

export interface MentionChipData {
  /** 引用目标完整路径(dir 以 `/` 结尾) */
  path: string;
  /** chip 展示 label(basename) */
  label: string;
  /** 引用失效标记(文件已删除 → 置灰) */
  invalid?: boolean;
}

export interface MentionChipProps {
  data: MentionChipData;
  /**
   * mousedown 拦截:chip 宿主是 contenteditable=false 的不可编辑节点,
   * 点它不能让焦点离开输入框(combo 模式约束)。
   */
  onMouseDown?: (e: React.MouseEvent) => void;
}

export default function MentionChip({ data, onMouseDown }: MentionChipProps) {
  const { path, label, invalid } = data;
  const isDir = path.endsWith("/");
  return (
    <span
      className="agent-input-ref-chip"
      data-testid="mention-chip"
      data-mention-path={path}
      data-mention-type={isDir ? "dir" : "file"}
      data-invalid={invalid || undefined}
      title={path}
      onMouseDown={onMouseDown}
    >
      {isDir ? (
        <FolderIcon className="agent-input-ref-chip-icon" />
      ) : (
        <FileIcon className="agent-input-ref-chip-icon" />
      )}
      <span className="agent-input-ref-chip-label">{label}</span>
    </span>
  );
}