/**
 * MentionChip — 已选中的 @-mention 在输入框里以 chip 形式展示。
 *
 * 设计要点(参考 deepseek-harness `InputBar.tsx` chip 渲染):
 * - 视觉:icon + basename(用户原意:不在输入框里把全路径放出来);
 *   chip 背景染色块占满整段,后续文本自然接续,无 "two layers" 视觉。
 * - 语义:给 LLM 发的仍然是 textarea 里的 `@<full-path>` 字符串(本组件
 *   只做展示,不动 input 状态)。
 * - 对齐:hidden placeholder 占据 `@<full-path>` 字符串的宽度,absolute
 *   chip 叠加在 placeholder 左上角且 stretch 到 100% 宽度 → chip 背景
 *   完整覆盖整段;textarea 字符宽度与 chip 宽度保持一致,光标位置 + 文本
 *   换行不漂移。
 * - 配合 AgentInputBox 让 textarea 在 chip 出现时 text-fill-color 透明,
 *   backdrop 接管渲染,避免 textarea 文本透过来造成双层。
 *
 * 大小:跟随 textarea 字体(`lineHeight: inherit`),`height: 100%` 让
 * chip 占据整行高度,`align-items: center` 把 icon + basename 居中。
 */
import { FolderOutlined, FileOutlined } from "@ant-design/icons";

export interface MentionChipData {
  /** Mention 在 input 中的起始 offset(inclusive) */
  start: number;
  /** Mention 在 input 中的结束 offset(exclusive) */
  end: number;
  /** 完整路径(不含 `@` 前缀,可能含末尾 `/` 表示 dir) */
  path: string;
  /** 是否带引号(由 `@"..."` 触发的 token) */
  quoted: boolean;
  /** 类型:从 selectedEntries 查,查不到默认 'file' */
  type: "file" | "dir";
}

export interface MentionChipProps {
  data: MentionChipData;
}

export default function MentionChip({ data }: MentionChipProps) {
  const { path, quoted, type } = data;
  const isDir = type === "dir";
  // basename 展示:去掉末尾 / (dir 会被 formatFileMention 加 /) 再取最后一段
  const displayPath = path.endsWith("/") ? path.slice(0, -1) : path;
  const basename =
    displayPath.split("/").filter(Boolean).pop() || displayPath || path;
  // placeholder 文本 = input 中实际存在的 token 字符串,宽度对齐 textarea
  const placeholderText = quoted ? `@"${path}"` : `@${path}`;

  return (
    <span
      data-testid="mention-chip"
      data-mention-path={path}
      data-mention-type={type}
      style={{
        position: "relative",
        display: "inline-block",
        // 关键:整个 chip span 走 nowrap,placeholder 的字符宽度严格匹配
        // textarea 里的对应字符
        whiteSpace: "nowrap",
      }}
    >
      {/* Hidden placeholder — 占据 textarea 里 @<full-path> 的宽度,保持
          光标位置 + 文本换行不漂移;可见 chip 用 absolute 浮在
          placeholder 左上角覆盖,且拉伸到 100% 宽度让背景色填满整个
          mention 段(否则 chip 看起来只有 basename 宽,后续文本会贴上 chip
          右沿,视觉上跟普通文本无异)。 */}
      <span aria-hidden style={{ visibility: "hidden" }}>
        {placeholderText}
      </span>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          // 拉伸到 placeholder 全宽,这样背景色铺满整个 @-mention 段,
          // 视觉上跟普通文本明确区分,后续文本自然接续。
          width: "100%",
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "0 4px",
          borderRadius: 4,
          background: "rgba(255,102,0,0.18)",
          color: "var(--text-primary)",
          whiteSpace: "nowrap",
          lineHeight: "inherit",
          fontWeight: 500,
          verticalAlign: "baseline",
          overflow: "hidden",
        }}
      >
        {isDir ? (
          <FolderOutlined
            style={{ fontSize: 12, color: "#facc15", flexShrink: 0 }}
          />
        ) : (
          <FileOutlined
            style={{ fontSize: 12, color: "var(--text-dim-45)", flexShrink: 0 }}
          />
        )}
        <span
          style={{
            // 只显示 basename(用户原意:不在输入框里把全路径放出来);
            // 长路径的 chip 背景依然占满 placeholder 宽度,视觉上是一块
            // "染色块",后续文本自然接续。如 basename 超出 chip 宽度
            // (极少见,因为 chip 宽度 = placeholder 宽度 >= basename 宽度),
            // 用 ellipsis 兜底截断。
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {basename}
        </span>
      </span>
    </span>
  );
}