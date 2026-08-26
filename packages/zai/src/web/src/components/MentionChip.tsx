/**
 * MentionChip — 输入框里的文件引用 chip。
 *
 * 设计要点(追齐 deepseek-harness `InputBar.tsx` 的 chip 渲染):
 * - draft 中该引用只占一个 U+FFFC 占位符(机器 occurrence),本组件只负责
 *   backdrop 层的可视渲染 —— 不再需要旧的 hidden-placeholder 宽度对位,
 *   单元的宽度由 DshChipCell 字体在 textarea 与 backdrop 两层天然一致。
 * - 视觉:小胶囊 + icon + basename(超出省略),title 显示完整路径;
 *   dir 以尾部 `/` 识别(引用插入时 ref 保留 dir 尾部斜杠)。
 * - 纯展示组件(仅展示不交互):onMouseDown 仅用于防止焦点离开 textarea。
 */
import { FolderOutlined, FileOutlined } from "@ant-design/icons";

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
   * mousedown 拦截:组合框(combobox)模式下点击 chip 不能让焦点离开
   * textarea。由父组件传入 null 时仅展示。
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
      {/* icon + label 都放进 absolute 覆盖层:chip 的流内宽度只由 ::before
          (U+FFFC 单元)决定,图标不会把 chip 撑宽 → 与 textarea 占位符严格
          一致,不漂移。 */}
      <span className="agent-input-ref-chip-label">
        {isDir ? (
          <FolderOutlined
            className="agent-input-ref-chip-icon"
            style={{ color: "#facc15" }}
          />
        ) : (
          <FileOutlined
            className="agent-input-ref-chip-icon"
            style={{ color: "var(--text-dim-45)" }}
          />
        )}
        <span>{label}</span>
      </span>
    </span>
  );
}