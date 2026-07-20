// MessageBubble.tsx
// Pure mechanical extraction of MessageBubble (formerly inlined at Agent.tsx)
// plus the small helpers (markdownComponents, MarkdownText, StreamingMarkdown,
// ThinkingBlock, ToolCallBlock, ToolStatus/ToolUsePill/TOOL_PILL_COLORS,
// PendingAttachment type, CODE_BG / CODE_FONT_FAMILY) that MessageBubble
// reaches via module-scope references in the original file.
//
// Task 3 of docs/superpowers/plans/2026-07-20-zai-transcript-collapse.md.
// NO LOGIC CHANGES: bodies are verbatim from Agent.tsx. Tasks 4 and 5 will
// import { MessageBubble } from this file. Inner helpers remain unexported
// (module-private) — extraction of those helpers is out of scope for Task 3.

import React, { useState, useEffect, useMemo } from "react";
import { Card, Collapse, Modal, Space, Tag, Typography } from "antd";
import {
  RobotFilled,
  UserOutlined,
  ToolOutlined,
  BulbOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { AgentMessage } from "../../store/useAgentStore.js";
import { AttachmentStrip } from "../AttachmentStrip.js";
import { linkifyText } from "../../lib/linkify.js";
import { splitMarkdownOnIncomplete } from "../../lib/splitMarkdown.js";
import { getRenderer } from "../toolRenderers/registry.js";

const { Text } = Typography;

// 代码块使用 oneDark 主题作为底色, 深灰(#282c34) 与浅色气泡形成稳定对比,
// 避免原来 rgba(0,0,0,0.35) 在浅气泡上对比度过低的问题.
const CODE_BG = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// 图片附件本地态: 用户在 handleSend 前挂在 Agent.tsx 内部的 pending list.
// thumbnailUrl 是 objectURL (用于立即在 AttachmentStrip 渲染);
// base64DataUrl 在 readImageAsBase64 完成后填入, 用于 handleSend 时拼
// ContentBlock 与 userMsg.attachments 的 thumbnailUrl 快照.
type PendingAttachment = {
  localId: string;
  mime: string;
  size: number;
  filename: string;
  thumbnailUrl: string;
  base64DataUrl: string;
  status: "reading" | "ready" | "error";
  error?: string;
};

const markdownComponents = {
  p: ({ children }: any) => <p style={{ margin: "0 0 8px 0" }}>{children}</p>,
  h1: ({ children }: any) => (
    <h1 style={{ fontSize: 20, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 style={{ fontSize: 16, fontWeight: 600, margin: "10px 0 6px 0" }}>
      {children}
    </h3>
  ),
  h4: ({ children }: any) => (
    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "8px 0 4px 0" }}>
      {children}
    </h4>
  ),
  ul: ({ children }: any) => (
    <ul style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }: any) => <li style={{ marginBottom: 4 }}>{children}</li>,
  code: ({ className, children }: any) => {
    // 围栏代码块 ```lang\n...\n``` 由 markdown 渲染时会给 code 加上 language-xxx className,
    // 行内 `code` 没有 className. 我们据此分发到 SyntaxHighlighter 或简单内联样式.
    const match = /language-(\w+)/.exec(className || "");
    if (!match) {
      // 行内 code: 柔和紫色文字 (#a78bfa violet-400 调性), 背景透明,
      // 仅靠文字色区分, 不增加视觉块面.
      return (
        <code
          style={{
            background: "transparent",
            color: "#a78bfa",
            padding: "1px 6px",
            borderRadius: 3,
            fontSize: "0.9em",
            fontFamily: CODE_FONT_FAMILY,
            fontWeight: 500,
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <SyntaxHighlighter
        language={match[1]}
        style={oneDark}
        customStyle={{
          margin: "6px 0 10px 0",
          padding: "12px 14px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.55,
          background: CODE_BG,
        }}
        codeTagProps={{
          style: { fontFamily: CODE_FONT_FAMILY },
        }}
        wrapLongLines={false}
        showLineNumbers={false}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  },
  // SyntaxHighlighter 自带 <pre>, 这里直接透传避免外层再包一个 pre
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <table
      style={{
        borderCollapse: "collapse",
        margin: "4px 0 8px 0",
        fontSize: 13,
        width: "100%",
      }}
    >
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead style={{ background: "rgba(255,255,255,0.05)" }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {children}
    </tr>
  ),
  th: ({ children }: any) => (
    <th
      style={{
        padding: "6px 10px",
        textAlign: "left",
        fontWeight: 600,
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      style={{
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        borderLeft: "3px solid rgba(255,255,255,0.2)",
        paddingLeft: 12,
        margin: "4px 0 8px 0",
        color: "rgba(255,255,255,0.7)",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#1677ff", textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        margin: "12px 0",
      }}
    />
  ),
};

const MarkdownText = React.memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: "inherit",
        wordBreak: "break-word",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Thinking 折叠块用紫罗兰 (#722ed1) 作为主色, 与正式对话的浅蓝/浅绿气泡区分.
// 折叠态: pill 形紫色 "思考" 标签 + 截断预览
// 展开态: 主题紫半透明叠加在深色页面背景上 + 紫罗兰左边条 + 浅色斜体等宽字体,
// 与正式对话 Card 风格脱钩. 用 rgba 透明度而非纯浅紫, 是因为页面背景是深色,
// 原 #f9f0ff 在深背景上跳眼; 改成主题紫 14% 透明度既保留紫色调又柔和融入暗背景.
const StreamingMarkdown = React.memo(function StreamingMarkdown({ text }: { text: string }) {
  const { complete, tail } = useMemo(
    () => splitMarkdownOnIncomplete(text),
    [text],
  );
  return (
    <>
      {complete && <MarkdownText text={complete} />}
      {tail && (
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "inherit",
          }}
        >
          {linkifyText(tail)}
          <span
            style={{
              display: "inline-block",
              width: 7,
              height: 14,
              verticalAlign: "-2px",
              marginLeft: 2,
              background: "#1677ff",
              animation: "zai-blink 1s steps(1) infinite",
            }}
          />
        </div>
      )}
    </>
  );
});

const THINKING_ACCENT = "#722ed1";
const THINKING_BG = "rgba(114, 45, 209, 0.14)";
const THINKING_PREVIEW_MAX = 80;

// 模块级计数器: 当前有几个 ThinkingBlock 处于 streaming 状态。
// 第一个进入 streaming=true 的实例挂 <style>, 最后一个退出的实例卸 <style>。
// 这样历史回放的 ThinkingBlock (streaming=undefined) 不会跑动画。
let thinkGlowRefcount = 0;

const ThinkingBlock = React.memo(function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!text) return null;

  // 折叠态预览: 取首个非空行, 超过阈值截断加省略号
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || "";
  const preview =
    firstLine.length > THINKING_PREVIEW_MAX
      ? `${firstLine.slice(0, THINKING_PREVIEW_MAX)}…`
      : firstLine;

  // Collapse 自带箭头只能挂在 label 之前/之后 (expandIconPosition), 不能
  // 插到 label 内部组件之间. 自己用受控 activeKey + 隐藏默认箭头, 把图标
  // (chevron) 渲染在 label 里、紧贴 "思考" pill 之后, 顺序就是
  //   [pill 灯泡 + 思考] [⌄/›] [预览文字]
  const [active, setActive] = useState(false);

  // 流式期间把 keyframe 注入 <head>: 不能用 inline <style>, 因为
  // Fragment 子项被父容器 (这里是 Collapse) 当 items 数组处理,
  // <style> 元素会被吃掉、不到 DOM. 通过 useEffect 注入更稳.
  // 用模块级 refcount: 第一个 streaming=true 挂载, 最后一个 streaming 消失
  // (含组件卸载) 才卸载 — 避免历史回放中也跟着跑动画.
  useEffect(() => {
    const id = "zai-think-glow-style";
    if (streaming) {
      thinkGlowRefcount += 1;
      if (thinkGlowRefcount === 1) {
        const style = document.createElement("style");
        style.id = id;
        style.textContent = `
          @keyframes zai-think-glow {
            0%, 100% { fill: #f7d774; }
            50%      { fill: #ffe999; }
          }
          .zai-thinking-bulb-active svg path {
            animation: zai-think-glow 1.4s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            @keyframes zai-think-glow { 0%, 100% { fill: #cacaca; } }
          }
        `;
        document.head.appendChild(style);
      }
      return () => {
        thinkGlowRefcount -= 1;
        if (thinkGlowRefcount === 0) {
          document.getElementById(id)?.remove();
        }
      };
    }
  }, [streaming]);

  return (
    // 思考块属于 LLM 正常回复节奏的一部分:
    // - 不缩进 (贴齐主对话流, 与正式文字回答同级宽度)
    // - 箭头紧贴 pill 后 (手动渲染, 不靠 expandIconPosition)
    <div style={{ marginBottom: 8, maxWidth: "100%" }}>
        <Collapse
        size="small"
        ghost
        bordered={false}
        activeKey={active ? ["thinking"] : []}
        onChange={(keys) =>
          setActive((Array.isArray(keys) ? keys : [keys]).includes("thinking"))
        }
        // 抹掉 Collapse 默认箭头, 用我们在 label 里手动渲染的那一个
        expandIcon={() => null}
        items={[
          {
            // 固定 key, 避免 Math.random 导致每次渲染重新挂载丢失展开态
            key: "thinking",
            label: (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                }}
              >
                {/* 紫色 pill: 仿 opencc userFacingNameBackgroundColor,
                    把 "思考" 标签用主色背景包裹, 视觉权重高于纯文字标签. */}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "1px 6px",
                    borderRadius: 10,
                    background: THINKING_ACCENT,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1.6,
                    flexShrink: 0,
                  }}
                >
                  <BulbOutlined
                    className={streaming ? "zai-thinking-bulb zai-thinking-bulb-active" : "zai-thinking-bulb"}
                    style={{ fontSize: 11 }}
                  />
                  思考
                </span>
                {/* 箭头: 折叠态 › (CaretRight), 展开态 ⌄ (CaretDown).
                    紧贴 pill 之后, 视觉顺序: pill → 箭头 → 预览文字.
                    注意: 颜色必须用浅色 — ThinkingBlock 直接挂在 #000000
                    消息容器下, 用 rgba(0,0,0,0.45) 会与背景同色不可见 */}
                <span
                  style={{
                    fontSize: 13,
                    color: "rgba(255,255,255,0.55)",
                    display: "inline-flex",
                    alignItems: "center",
                    flexShrink: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {active ? <CaretDownOutlined /> : <CaretRightOutlined />}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "rgba(0,0,0,0.45)",
                    fontStyle: "italic",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                  title={firstLine}
                >
                  {preview}
                </span>
              </div>
            ),
            children: (
              <div
                style={{
                  fontSize: 12,
                  padding: "10px 12px",
                  background: THINKING_BG,
                  borderLeft: `3px solid ${THINKING_ACCENT}`,
                  borderRadius: 4,
                  // THINKING_BG 是主题紫半透明叠加深色页面, 浅色文字才有足够对比度
                  color: "rgba(255,255,255,0.78)",
                  fontStyle: "italic",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.6,
                }}
              >
                {linkifyText(text)}
              </div>
            ),
          },
        ]}
      />
      </div>
  );
});

// Tool pill 调色板: 仿 opencc AssistantToolUseMessage 的 userFacingNameBackgroundColor
// 思路, 用 pill 背景色 + 反白文字 表达 "当前正在被调用的工具".
// - start: 紫色, 表示 LLM 刚发出指令
// - done:  绿色, 表示执行成功
// - error: 红色, 表示执行失败 / 拒绝 / schema 非法
type ToolStatus = "start" | "done" | "error";
const TOOL_PILL_COLORS: Record<
  ToolStatus,
  { bg: string; fg: string; tag: string; label: string }
> = {
  start: { bg: "#f9f0ff", fg: "#722ed1", tag: "purple", label: "调用中" },
  done: { bg: "#f6ffed", fg: "#389e0d", tag: "green", label: "已完成" },
  error: { bg: "#fff2f0", fg: "#cf1322", tag: "red", label: "错误" },
};

function ToolUsePill({ name, status }: { name: string; status: ToolStatus }) {
  const c = TOOL_PILL_COLORS[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 10,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.6,
        fontFamily: CODE_FONT_FAMILY,
        letterSpacing: 0.2,
      }}
    >
      {name}
    </span>
  );
}


// 工具调用块: 把 tool_use:start / done / error / invalid / denied
// 统一成单一可折叠面板. 由于 React key 按 toolUseId 锁定 (见调用处),
// 同一次调用的 start/done/error 事件会复用同一个 DOM 节点, 折叠态不丢.
const ToolCallBlock = React.memo(function ToolCallBlock({ msg }: { msg: AgentMessage }) {
  const rawName = (msg.name as string | undefined)?.trim() || ''
  const shortId = (msg.toolUseId as string | undefined)?.slice(-8) ?? '????????'
  // 兜底: 模型 SSE 流里有个别时刻 toolName 没带过来(已知 race condition,
  // tool_use:start 与 content_block_start 都在抢),显示 "未知工具 (id:xxxxxxxx)"
  // 比 "unknown" 强,user 至少能根据 id 复制去后端日志 grep.
  const name = rawName || `未知工具 (id:${shortId})`
  const input = (msg.input as Record<string, unknown>) || {}
  // Agent 工具的 pill 不显示泛化的 "Agent" — 展示实际派发的 subagent_type
  // (Explore / Plan / general-purpose / 用户自定义), 让用户一眼看出当前是
  // 哪种 subagent 在跑. 格式 `<type> (agent)` 与 opencc AssistantToolUseMessage
  // 的 userFacingName 风格一致. 缺省回退到 'general-purpose'(AgentTool 的 schema 默认值).
  const renderer = getRenderer(rawName)
  const displayName = renderer.displayName?.(input) ?? name
  // 整块接管: Edit/Write 等需要整段渲染 (DiffBlock 自带 header + diff + error)
  // 的工具, 跳过 ToolCallBlock 自己的折叠面板/参数/结果分块, 直接挂 mount.
  if (renderer.renderFull) {
    return <>{renderer.renderFull(msg)}</>
  }
  const output = msg.output
  const errorField = msg.error as string | { message?: string } | undefined;
  const reasonField = msg.reason as string | undefined;
  const toolUseId =
    (msg.toolUseId as string) || (msg.eventId as string) || "tool";

  const type = msg.type as string;
  let status: ToolStatus = "start";
  if (type === "tool_use:done") status = "done";
  else if (
    type === "tool_use:error" ||
    type === "tool_use:invalid" ||
    type === "tool_use:denied"
  )
    status = "error";

  // 折叠态预览: 直接展示第一个 input 字段的值, 不带 "key: " 前缀.
  // 工具名已通过 pill (Read/Edit/Glob…) 表达, 再写 file_path/pattern 等
  // 字段名属于冗余; 路径/pattern 本身就是用户最关心的辨识信息.
  // 每个工具的预览策略由对应 renderer.preview(input) 决定; Bash 优先
  // description, Agent 优先 description, 其余工具则回退到第一个字段的值.
  const inputKeys = Object.keys(input);
  const preview = renderer.preview(input);

  const errorText =
    typeof errorField === "string"
      ? errorField
      : errorField?.message || reasonField || "";

  // 同 ThinkingBlock: 受控 + 抹掉默认箭头 + 手动渲染, 让箭头紧贴 pill 之后.
  const [active, setActive] = useState(false);

  // 泛型输入/输出渲染: 当 renderer 没有自定义 renderInput/renderOutput
  // 时回退到这里. 风格刻意与 bash/error 等专用 renderer 保持一致
  // (字体/字号/背景圆角), 让用户在 "generic" 与 "specific" 之间的视觉
  // 跳跃最小.
  const renderGenericInput = () => (
    <pre
      style={{
        fontSize: 12, margin: "4px 0 0 0", padding: "8px 10px",
        background: "rgba(0,0,0,0.03)", borderRadius: 4,
        whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
        fontFamily: CODE_FONT_FAMILY,
      }}
    >
      {linkifyText(JSON.stringify(input, null, 2))}
    </pre>
  )

  const renderGenericOutput = () =>
    output === undefined || output === null ? null : (
      <pre
        style={{
          fontSize: 12, margin: "4px 0 0 0", padding: "8px 10px",
          background: "rgba(82,196,26,0.06)", borderLeft: "2px solid #52c41a",
          borderRadius: 4, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
          fontFamily: CODE_FONT_FAMILY, maxHeight: 360, overflow: "auto" as const,
        }}
      >
        {typeof output === "string"
          ? linkifyText(output)
          : linkifyText(JSON.stringify(output, null, 2))}
      </pre>
    )

  return (
    // 不缩进 (贴齐主对话流); 视觉上与 assistant.text 气泡同列.
    <div style={{ marginBottom: 8, maxWidth: "100%" }}>
      <Collapse
        size="small"
        ghost
        bordered={false}
        activeKey={active ? [`tool-${toolUseId}`] : []}
        onChange={(keys) =>
          setActive(
            (Array.isArray(keys) ? keys : [keys]).includes(`tool-${toolUseId}`),
          )
        }
        expandIcon={() => null}
        items={[
          {
            key: `tool-${toolUseId}`,
            label: (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                }}
              >
                <ToolUsePill name={displayName} status={status} />
                <Tag color={TOOL_PILL_COLORS[status].tag} style={{ margin: 0 }}>
                  {TOOL_PILL_COLORS[status].label}
                </Tag>
                {/* 箭头: 紧贴标签(pill + status tag), 之后接预览文字.
                    颜色用浅色以适配深色背景, 字号 13 与 ThinkingBlock 一致 */}
                <span
                  style={{
                    fontSize: 13,
                    color: "rgba(255,255,255,0.55)",
                    display: "inline-flex",
                    alignItems: "center",
                    flexShrink: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {active ? <CaretDownOutlined /> : <CaretRightOutlined />}
                </span>
                {preview && (
                  <Text
                    type="secondary"
                    style={{
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                    }}
                    title={preview}
                  >
                    {preview}
                  </Text>
                )}
              </div>
            ),
            children: (
              <div style={{ paddingLeft: 4 }}>
                {inputKeys.length > 0 && (
                  // 自定义 renderer 自带 FieldLabel (e.g. "命令"/"文件"), 不重复套 "参数" 标题;
                  // 仅 generic fallback 显示 "参数" 给 JSON 兜底一份上下文.
                  renderer.renderInput
                    ? renderer.renderInput(input)
                    : (
                      <div style={{ marginBottom: 8 }}>
                        <Text
                          type="secondary"
                          style={{
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                          }}
                        >
                          参数
                        </Text>
                        {renderGenericInput()}
                      </div>
                    )
                )}
                {output !== undefined && output !== null && (
                  <div style={{ marginBottom: 8 }}>
                    <Text
                      type="secondary"
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      结果
                    </Text>
                    {renderer.renderOutput
                      ? renderer.renderOutput(output, errorField != null)
                      : renderGenericOutput()}
                  </div>
                )}
                {errorText && (
                  <div>
                    <Text
                      type="secondary"
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      错误
                    </Text>
                    <pre
                      style={{
                        fontSize: 12,
                        margin: "4px 0 0 0",
                        padding: "8px 10px",
                        background: "rgba(255,77,79,0.06)",
                        borderLeft: "2px solid #ff4d4f",
                        borderRadius: 4,
                        color: "#cf1322",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: CODE_FONT_FAMILY,
                      }}
                    >
                      {linkifyText(errorText)}
                    </pre>
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
});

export const MessageBubble = React.memo(function MessageBubble({
  msg,
  streaming,
}: {
  msg: AgentMessage;
  streaming?: boolean;
}) {
  // 用户消息附件点击放大: 在气泡外层维护 previewingAttachment state.
  // 原因: MessageBubble 被 React.memo 包, 用内部 state 不会让兄弟气泡重渲;
  // 另外图片 src 在 bubble 内随手就能取到, 不必把 state 上提到 Agent 主组件.
  // 修复历史: 之前卡片只显示 80x80 cover 缩略图, 长截图 (聊天记录等) 大量细节
  // 被裁掉看不到 — 用户截图抱怨"识别对话内容"卡片显示不出来. 现在保留 cover
  // 缩略图 (与状态栏一致), 但加点击放大, 让原图完整可见.
  const [previewingAttachment, setPreviewingAttachment] = useState<
    | {
        url: string;
        filename: string;
      }
    | null
  >(null);

  // 来自 transcript 历史回放: 思考块作为独立条目, 与 assistant.text 配对出现
  if (msg.type === "assistant.thinking") {
    return (
      <ThinkingBlock
        text={(msg.thinking as string) || (msg.text as string) || ""}
        streaming={streaming}
      />
    );
  }

  if (msg.type === "user.text" || msg.type === "user.message") {
    const msgAttachments =
      (msg.attachments as PendingAttachment[] | undefined) ?? [];
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 16,
        }}
      >
        <Card
          size="small"
          style={{
            maxWidth: "70%",
            background: "#e6f4ff",
            borderRadius: 12,
          }}
        >
          {msgAttachments.length > 0 && (
            <AttachmentStrip
              attachments={msgAttachments}
              // previewHeight 模式: 高度固定 80px, 宽度按图片原始宽高比自适应.
              // 长截图 (聊天记录 / 长图) 整张可见不被裁切, 又不会像 240 方块
              // 那样挤占卡片高度. 默认 maxWidth 480 防止横屏截图撑爆卡片.
              // 仍可点击触发 onPreview 看更清晰原图.
              previewHeight={80}
              onPreview={(a) =>
                setPreviewingAttachment({
                  url: a.thumbnailUrl,
                  filename: a.filename,
                })
              }
            />
          )}
          <Space>
            <UserOutlined />
            <Text>
              {linkifyText(
                (msg.text as string) || (msg.prompt as string) || "",
              )}
            </Text>
          </Space>
        </Card>
        {/* 附件大图预览: 跟气泡同级, 不影响 maxWidth:70% 气泡本身宽度.
            footer 为 null 干净版, mask 半透明黑让用户聚焦图片, body 用 0 padding
            让图片填满. zoom-out cursor 暗示可关闭. */}
        <Modal
          open={previewingAttachment !== null}
          onCancel={() => setPreviewingAttachment(null)}
          footer={null}
          width="auto"
          centered
          destroyOnClose
          title={previewingAttachment?.filename}
          styles={{
            body: {
              padding: 0,
              background: "transparent",
            },
          }}
        >
          {previewingAttachment && (
            <img
              src={previewingAttachment.url}
              alt={previewingAttachment.filename}
              style={{
                display: "block",
                maxWidth: "90vw",
                maxHeight: "85vh",
                width: "auto",
                height: "auto",
                cursor: "zoom-out",
                borderRadius: 4,
              }}
              onClick={() => setPreviewingAttachment(null)}
            />
          )}
        </Modal>
      </div>
    );
  }

  if (msg.type === "assistant.text") {
    const text = (msg.text as string) || "";
    // 跳过完全空的 assistant.text 气泡: 模型在工具调用前偶尔会吐一两个空字符,
    // 不挡就让用户看到一张空 robot 卡片. 历史回放里若某条 assistant.text
    // 真的是空白, 也一并隐藏.
    if (!text.trim()) return null;
    // 流式期间跳过 ReactMarkdown 重解析 (每次 delta 都跑一次 unified pipeline 太重),
    // 用 pre-wrap 渲染纯文本; 状态切回 idle 后才解析 markdown, 利用 React 自动重渲.
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
          marginBottom: 16,
        }}
      >
        <Card
          size="small"
          style={{
            width: "100%",
            maxWidth: "100%",
            marginRight: 20,
            background: "#f6ffed",
            borderRadius: 12,
          }}
        >
          <Space align="start" size={8} style={{ width: "100%" }}>
            <RobotFilled style={{ color: "#ff6600", fontSize: 18 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {streaming ? (
                <StreamingMarkdown text={text} />
              ) : (
                <MarkdownText text={text} />
              )}
            </div>
          </Space>
        </Card>
      </div>
    );
  }

  // zai-agent-core 实时事件: tool_use:start / done / error / invalid / denied
  // 全部走 ToolCallBlock 渲染. store 已按 toolUseId upsert 合并, 同一工具
  // 全程只对应一条消息 + 一个 ToolCallBlock, 这里不需要再做 key 去重.
  // modelCaller 的 content_block_start(tool_use) 也由 store 归一化,
  // 所以前端只会见到 type === 'tool_use:start', 不会再有 content_block_start.
  if (
    msg.type === "tool_use:start" ||
    msg.type === "tool_use:done" ||
    msg.type === "tool_use:error" ||
    msg.type === "tool_use:invalid" ||
    msg.type === "tool_use:denied"
  ) {
    // Edit / Write 走 registry 派发到 DiffBlock (renderFull 路径, ToolCallBlock 内部识别);
    // 其余工具走 ToolCallBlock 的标准折叠/pill 渲染.
    return <ToolCallBlock msg={msg} />;
  }

  // Legacy / transcript 历史回放路径: tool.call 与 tool.result 是成对的
  // 两条独立消息, 这里保留旧渲染 (tool.result 在 tool.call 下方缩进显示).
  if (msg.type === "tool.call") {
    const toolName =
      (msg.toolName as string) || (msg.name as string) || "unknown";
    const args =
      (msg.args as Record<string, unknown>) ||
      (msg.arguments as Record<string, unknown>) ||
      {};
    return (
      <div style={{ marginBottom: 8 }}>
        <Collapse
          size="small"
          items={[
            {
              key: "tool-call",
              label: (
                <Space>
                  <ToolOutlined />
                  <Text code>{toolName}</Text>
                  <Tag color="blue">调用</Tag>
                </Space>
              ),
              children: (
                <pre
                  style={{ fontSize: 12, margin: 0, whiteSpace: "pre-wrap" }}
                >
                  {linkifyText(JSON.stringify(args, null, 2))}
                </pre>
              ),
            },
          ]}
        />
      </div>
    );
  }

  if (msg.type === "tool.result") {
    const toolName = (msg.toolName as string) || (msg.name as string) || "tool";
    const result = msg.result || msg.output || msg.error || "";
    const isError = Boolean(msg.isError || msg.error);
    return (
      <div style={{ marginBottom: 8 }}>
        <Collapse
          size="small"
          items={[
            {
              key: "tool-result",
              label: (
                <Space>
                  <ToolOutlined />
                  <Text code>{toolName}</Text>
                  <Tag color={isError ? "red" : "green"}>
                    {isError ? "错误" : "结果"}
                  </Tag>
                </Space>
              ),
              children: (
                <pre
                  style={{
                    fontSize: 12,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    color: isError ? "#ff4d4f" : undefined,
                  }}
                >
                  {typeof result === "string"
                    ? linkifyText(result)
                    : linkifyText(JSON.stringify(result, null, 2))}
                </pre>
              ),
            },
          ]}
        />
      </div>
    );
  }

  if (msg.type === "runtime.error") {
    const error = msg.error as
      | { category?: string; message?: string }
      | undefined;
    return (
      <div style={{ marginBottom: 8 }}>
        <Card
          size="small"
          style={{ background: "#fff2f0", borderColor: "#ff4d4f" }}
        >
          <Text type="danger">
            {error?.message || "发生未知错误"}
            {error?.category ? ` (${error.category})` : ""}
          </Text>
        </Card>
      </div>
    );
  }

  // Anthropic-style stream events emitted by zai-agent-core
  // (message_start / content_block_start / content_block_delta / content_block_stop / message_stop / runtime.done)
  // 我们只在 delta 阶段累积可见文本,其它生命周期事件不渲染.
  if (msg.type === "content_block_delta") {
    const delta = msg.delta as
      | { type?: string; text?: string; thinking?: string }
      | undefined;
    // thinking_delta: 模型内部推理, 折叠成灰色面板
    if (delta?.type === "thinking_delta") {
      return <ThinkingBlock text={delta.thinking || ""} streaming={streaming} />;
    }
    // text_delta: 可见回复正文
    const text = delta?.text || "";
    if (!text) return null;
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
          marginBottom: 16,
        }}
      >
        <Card
          size="small"
          style={{
            width: "100%",
            maxWidth: "100%",
            marginRight: 20,
            background: "#f6ffed",
            borderRadius: 12,
          }}
        >
          <Space align="start" size={8}>
            <RobotFilled style={{ color: "#ff6600", fontSize: 18 }} />
            <MarkdownText text={text} />
          </Space>
        </Card>
      </div>
    );
  }

  // message_start 不再单独渲染: 它的 content 已经被 content_block_delta
  // 流式合并进同一个 assistant.text 气泡, 这里再渲一张会造成重复卡片.
  // 标准 Anthropic 流式 message_start.content 为空, 这里跳过不影响完整性.

  // 其它事件 (message_stop / runtime.done) 不渲染
  return null;
});
