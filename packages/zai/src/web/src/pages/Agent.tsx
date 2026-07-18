import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Input,
  Button,
  Card,
  Collapse,
  Tag,
  Typography,
  Space,
  Popconfirm,
  theme,
  message,
} from "antd";
import {
  RobotOutlined,
  RobotFilled,
  UserOutlined,
  ToolOutlined,
  MessageOutlined,
  PlusOutlined,
  BulbOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  PictureOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  useAgentStore,
  type AgentMessage,
  type AgentStatus,
  type TodoItem,
} from "../store/useAgentStore";
import { useAppStore } from "../store/useAppStore";
import QuestionCard from "../components/QuestionCard.jsx";
import DiffBlock from "../components/DiffBlock.js";
import { linkifyText } from "../lib/linkify.js";
import { splitMarkdownOnIncomplete } from "../lib/splitMarkdown.js";
import { AttachmentStrip } from "../components/AttachmentStrip";
import ModelStatusButton from "../components/ModelStatusButton";
import ModeStatusButton, { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
import { TaskDock } from "../components/TaskDock";
import { TaskDrawer } from "../components/TaskDrawer";
import TodoZone from "../components/TodoZone.jsx";
import { readImageAsBase64, ImageReadError } from "../lib/imageReader";
import AgentInputBox from "../components/AgentInputBox";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

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

const MAX_ATTACHMENTS_PER_TURN = 10;

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
  const name = (msg.name as string) || 'unknown'
  const input = (msg.input as Record<string, unknown>) || {}
  // Agent 工具的 pill 不显示泛化的 "Agent" — 展示实际派发的 subagent_type
  // (Explore / Plan / general-purpose / 用户自定义), 让用户一眼看出当前是
  // 哪种 subagent 在跑. 格式 `<type> (agent)` 与 opencc AssistantToolUseMessage
  // 的 userFacingName 风格一致. 缺省回退到 'general-purpose'(AgentTool 的 schema 默认值).
  const displayName = name === "Agent"
    ? `${(typeof input.subagent_type === "string" && input.subagent_type.trim()) || "general-purpose"} (agent)`
    : name
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
  const inputKeys = Object.keys(input);
  const truncate = (s: string) => (s.length > 80 ? s.slice(0, 80) + "…" : s);
  // Bash 工具特殊: 模型通常会同时给出 description (意图说明) + command (实际命令).
  // 折叠态优先展示 description — 用户一眼看出"这条 Bash 是在做什么", 真正命令
  // 留到展开后的参数区查看. 没有 description 时回退到 command, 再退化到通用逻辑.
  // Agent 工具 (sub-agent 调用) 同理: description 说明意图, prompt 是发给子代理的
  // 具体指令. 优先 description, 缺失时回退到 prompt 的开头几行.
  let preview = "";
  if (name === "Bash") {
    const desc = input.description;
    const cmd = input.command;
    if (typeof desc === "string" && desc.trim()) {
      preview = truncate(desc);
    } else if (typeof cmd === "string" && cmd.trim()) {
      preview = truncate(cmd);
    }
  } else if (name === "Agent") {
    const desc = input.description;
    const prompt = input.prompt;
    if (typeof desc === "string" && desc.trim()) {
      preview = truncate(desc);
    } else if (typeof prompt === "string" && prompt.trim()) {
      preview = truncate(prompt);
    }
  } else {
    const firstKey = inputKeys[0];
    const firstVal = firstKey ? input[firstKey] : undefined;
    const firstPreview =
      firstVal == null
        ? ""
        : typeof firstVal === "string"
          ? firstVal
          : JSON.stringify(firstVal);
    preview = firstPreview ? truncate(firstPreview) : "";
  }

  const errorText =
    typeof errorField === "string"
      ? errorField
      : errorField?.message || reasonField || "";

  // 同 ThinkingBlock: 受控 + 抹掉默认箭头 + 手动渲染, 让箭头紧贴 pill 之后.
  const [active, setActive] = useState(false);

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
                    <pre
                      style={{
                        fontSize: 12,
                        margin: "4px 0 0 0",
                        padding: "8px 10px",
                        background: "rgba(0,0,0,0.03)",
                        borderRadius: 4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: CODE_FONT_FAMILY,
                      }}
                    >
                      {linkifyText(JSON.stringify(input, null, 2))}
                    </pre>
                  </div>
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
                    <pre
                      style={{
                        fontSize: 12,
                        margin: "4px 0 0 0",
                        padding: "8px 10px",
                        background: "rgba(82,196,26,0.06)",
                        borderLeft: "2px solid #52c41a",
                        borderRadius: 4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: CODE_FONT_FAMILY,
                        maxHeight: 360,
                        overflow: "auto",
                      }}
                    >
                      {typeof output === "string"
                        ? linkifyText(output)
                        : linkifyText(JSON.stringify(output, null, 2))}
                    </pre>
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

const MessageBubble = React.memo(function MessageBubble({
  msg,
  streaming,
}: {
  msg: AgentMessage;
  streaming: boolean;
}) {
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
            <AttachmentStrip attachments={msgAttachments} />
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
    // Edit / Write 走专门的 diff 展示 (行号 + 增删底色), 其余工具用通用折叠块.
    const toolName = (msg.name as string) || "";
    if (toolName === "Edit" || toolName === "Write") {
      return <DiffBlock msg={msg} />;
    }
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

export default function Agent() {
  const messages = useAgentStore((s) => s.messages);
  const status = useAgentStore((s) => s.status);
  const cwd = useAgentStore((s) => s.cwd);
  const sessions = useAgentStore((s) => s.sessions);
  const sessionId = useAgentStore((s) => s.sessionId);
  const todosBySession = useAgentStore((s) => s.todosBySession);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const stop = useAgentStore((s) => s.stop);
  const clearMessages = useAgentStore((s) => s.clearMessages);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession);
  const loadTranscript = useAgentStore((s) => s.loadTranscript);
  const createNewSession = useAgentStore((s) => s.createNewSession);
  const deleteSession = useAgentStore((s) => s.deleteSession);
  const pendingAsk = useAgentStore((s) => s.pendingAsk);
  const setAskAnswer = useAgentStore((s) => s.setAskAnswer);
  const setAskNotes = useAgentStore((s) => s.setAskNotes);
  const submitAsk = useAgentStore((s) => s.submitAsk);
  const rejectAsk = useAgentStore((s) => s.rejectAsk);
  const todosForCurrentSession: TodoItem[] =
    sessionId != null ? (todosBySession[sessionId] ?? []) : [];
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode);
  const { instanceContext } = useAppStore()
  const cwdName = instanceContext?.cwdName || '~'
  const branch = instanceContext?.branch || 'master'
  const { token } = theme.useToken();
  // Slash autocomplete: 输入 / 时弹出, 同时包含 builtin commands + user commands + skills
  type SlashItem = {
    kind: 'command' | 'skill'
    name: string
    description: string
    argumentHint?: string
    whenToUse?: string
    isBuiltIn?: boolean
    isConflict?: boolean
    type?: 'local' | 'prompt'
    /** plugin skill 的展示名（去掉 `plugin:pluginName:` 前缀） */
    displayName?: string
    /** plugin skill 所属的 plugin 名，用于在描述前渲染 `(pluginName)` */
    pluginName?: string
  }
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  // 会话列表默认展示条数: 按侧栏可视高度估算, 每项约 50px (padding + 两行文字 + gap).
  const sessionListRef = useRef<HTMLDivElement>(null);
  const [sessionPageSize, setSessionPageSize] = useState(10);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  // 会话历史侧栏是否收起. 收起时宽度缩到 40px 只显示图标, 腾出空间给对话区.
  // 默认收起, 让对话区首屏占满主视图, 用户按需点开.
  const [sessionsCollapsed, setSessionsCollapsed] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 流式计时: 仅在 streaming 期间累加秒数, 状态切回 idle/aborted/error 时归零
  const [elapsed, setElapsed] = useState(0);
  const streamStartRef = useRef<number | null>(null);
  // 流式动画: 仿 OpenCC 状态栏的 ✶✷✸✹✺✻✼✽ 字符循环, 每 100ms 切一帧
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const SPINNER = ["✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

  // 根据侧栏实际高度估算默认展示条数, 窗口/容器尺寸变化时自动重算.
  useEffect(() => {
    const el = sessionListRef.current;
    if (!el) return;
    const ITEM_HEIGHT = 50;
    const recompute = () => {
      const count = Math.max(1, Math.floor(el.clientHeight / ITEM_HEIGHT));
      setSessionPageSize(count);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessionsCollapsed]);

  useEffect(() => {
    if (status === "streaming") {
      if (streamStartRef.current == null) {
        streamStartRef.current = Date.now();
        setElapsed(0);
      }
      const timer = setInterval(() => {
        if (streamStartRef.current != null) {
          setElapsed(Math.floor((Date.now() - streamStartRef.current) / 1000));
        }
      }, 250);
      const spinTimer = setInterval(() => {
        setSpinnerIdx((i) => (i + 1) % SPINNER.length);
      }, 100);
      return () => {
        clearInterval(timer);
        clearInterval(spinTimer);
      };
    }
    streamStartRef.current = null;
    setElapsed(0);
    setSpinnerIdx(0);
    return undefined;
  }, [status]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 全局 Esc 拦截: 流式期间按 Esc 终止生成 (仿 OpenCC 状态栏 "esc to interrupt").
  // textarea 在 streaming 时被禁用, 这里挂 window 监听确保 Esc 仍生效.
  useEffect(() => {
    if (status !== "streaming") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, stop]);

  // 新 pwd 下首次打开 Agent 页面时, server 端 /api/agent/sessions 会返回
  // 空数组 — loadSessions 当前对空列表不做任何处理, UI 会停在空白态.
  // 在这里补一刀: 等 loadSessions 完成后如果 sessions 仍是空, 就调用
  // createNewSession() (复用了 PlusOutlined 按钮的 onClick 逻辑 — POST
  // /api/agent/sessions 建一条空 transcript, 立即在 sidebar 占位).
  useEffect(() => {
    (async () => {
      await loadSessions();
      if (useAgentStore.getState().sessions.length === 0) {
        await useAgentStore.getState().createNewSession();
      }
    })();
  }, []);

  // 中断逻辑: 已无 UI 按钮, 流式期间按 Esc (window 全局监听) 触发 stop()

  const visibleSessions = showAllSessions
    ? sessions
    : sessions.slice(0, sessionPageSize);
  const hasMoreSessions = sessions.length > sessionPageSize;

  // messages 直接按 store 顺序渲染. store 已经通过 textSegmentRev 在工具调用
  // 起点 bump, 把"工具前后的文字段"切到不同 entry, 因此工具与文字在
  // messages[] 中天然交错, 不需要前端再二次重排. 早期这里曾用 useMemo
  // 把同一轮内所有 tool_use:* 强制提到 assistant.text 之前 — 副作用是
  // 多工具调用与多段文字回答会被堆在一起, 失去时间顺序感, 移除后即恢复
  // 用户期望的"按时间发生顺序展示".

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "row",
        gap: 16
      }}
    >
      <div
        style={{
          width: sessionsCollapsed ? 40 : 140,
          flexShrink: 0,
          borderRight: "1px solid #f0f0f0",
          // paddingRight: sessionsCollapsed ? 0 : 12,
          display: "flex",
          flexDirection: "column",
          transition: "width 0.18s ease",
        }}
      >
        <div
          style={{
            fontWeight: 500,
            marginBottom: 8,
            color: "#666",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {sessionsCollapsed ? (
            // 收起时也要暴露创建入口, 否则收起后用户没法开新会话.
            // 用 absolute + transform 让两个图标按钮绝对居中于 40px 列宽,
            // 绕开 AntD Button 内部 icon 偏左导致的视觉不齐.
            <div style={{ position: "relative", width: "100%", height: 60 }}>
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={createNewSession}
                title="创建新会话"
                style={{
                  position: "absolute",
                  top: 0,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              />
              <Button
                type="text"
                size="small"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setSessionsCollapsed(false)}
                title="展开会话历史"
                style={{
                  position: "absolute",
                  top: 32,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              />
            </div>
          ) : (
            <>
              <Space>
                <MessageOutlined />
                会话历史
              </Space>
              <Space size={4}>
                <Button
                  type="text"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={createNewSession}
                  title="创建新会话"
                />
                <Button
                  type="text"
                  size="small"
                  icon={<MenuFoldOutlined />}
                  onClick={() => setSessionsCollapsed(true)}
                  title="收起会话历史"
                />
              </Space>
            </>
          )}
        </div>
        {!sessionsCollapsed && (
          <div ref={sessionListRef} style={{ flex: 1, overflowY: "auto" }}>
            {sessions.length === 0 ? (
              <div style={{ fontSize: 12, color: "#999", padding: "8px 4px" }}>
                暂无历史会话
              </div>
            ) : (
              <>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 2 }}
                >
                  {visibleSessions.map((s) => {
                    const active = s.transcriptId === sessionId;
                    const hovered = s.transcriptId === hoveredSessionId;
                    return (
                      <div
                        key={s.transcriptId}
                        style={{
                          position: "relative",
                          cursor: "pointer",
                          padding: "6px 8px",
                          borderRadius: 6,
                          background: active
                            ? token.colorPrimaryBg
                            : "transparent",
                        }}
                        onMouseEnter={() => setHoveredSessionId(s.transcriptId)}
                        onMouseLeave={() =>
                          setHoveredSessionId((cur) =>
                            cur === s.transcriptId ? null : cur,
                          )
                        }
                        onClick={() => {
                          setCurrentSession(s.transcriptId);
                          loadTranscript(s.transcriptId);
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            // 悬停时给删除按钮留出空间, 避免标题被图标压住.
                            paddingRight: hovered ? 20 : 0,
                            color: active ? token.colorPrimary : undefined,
                          }}
                        >
                          {s.title || "新会话"}
                        </div>
                        <div style={{ fontSize: 11, color: "#999" }}>
                          {new Date(s.updatedAt).toLocaleString()}
                        </div>
                        <Popconfirm
                          title="删除该会话?"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void deleteSession(s.transcriptId)}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                            title="删除会话"
                            style={{
                              position: "absolute",
                              top: 4,
                              right: 4,
                              width: 24,
                              height: 24,
                              padding: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              // 始终挂载, 仅用透明度控制显隐. 若用 hovered 条件卸载,
                              // 鼠标移向 Popconfirm 弹层会离开会话项触发 unmount,
                              // 弹层随之消失.
                              opacity: hovered ? 1 : 0,
                              pointerEvents: hovered ? "auto" : "none",
                              transition: "opacity 0.15s",
                            }}
                          />
                        </Popconfirm>
                      </div>
                    );
                  })}
                </div>
                {hasMoreSessions && (
                  <Button
                    type="link"
                    size="small"
                    style={{
                      padding: 0,
                      marginTop: 4,
                      color: token.colorPrimary,
                    }}
                    onClick={() => setShowAllSessions((v) => !v)}
                  >
                    {showAllSessions
                      ? "收起"
                      : `更多 (${sessions.length - sessionPageSize})`}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "0 8px",
            marginBottom: 16,
            background: "#000000",
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                marginTop: 80,
                color: "#999",
              }}
            >
              <RobotFilled
                style={{ fontSize: 48, marginBottom: 16, color: "#ff6600" }}
              />
              <Paragraph type="secondary">
                发送消息开始与 AI Agent 对话
              </Paragraph>
              <Paragraph type="secondary" style={{ fontSize: 12 }}>
                支持文件搜索、读写文件和 Bash 执行
              </Paragraph>
            </div>
          )}
          <TodoZone todos={todosForCurrentSession} />
          {messages.map((msg: AgentMessage, idx: number) => {
            // 工具相位按 toolUseId 锁定 key, 让 store 的 upsert 合并后 React 复用
            // 同一个 DOM 节点. 其它事件沿用 eventId / 数组下标.
            const t = msg.type as string;
            const toolUseId = t.startsWith("tool_use:")
              ? (msg.toolUseId as string)
              : undefined;
            const reactKey =
              (toolUseId ? `tool-${toolUseId}` : (msg.eventId as string)) ||
              String(idx);
            return (
              <MessageBubble
                key={reactKey}
                msg={msg}
                // 流式态只对末尾那条消息生效: 否则历史 assistant.text 也会跟着闪光标
                streaming={
                  status === "streaming" && idx === messages.length - 1
                }
              />
            );
          })}
          <div ref={messagesEndRef} />
          {pendingAsk && (
            <QuestionCard
              questions={pendingAsk.questions}
              answers={pendingAsk.answers}
              annotations={pendingAsk.annotations}
              status={pendingAsk.status}
              errorMessage={pendingAsk.errorMessage}
              onAnswer={setAskAnswer}
              onNotesChange={setAskNotes}
              onSubmit={() => void submitAsk()}
              onReject={() => void rejectAsk()}
            />
          )}
        </div>

        <div className="bottom-stack">
          <AgentInputBox />
          {/* 输入框下方的模式栏: 仿 OpenCC 底栏 */}
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.10)",
              padding: "6px 10px",
              fontSize: 12,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              color: "rgba(255,255,255,0.45)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <ModeStatusButton />
            <span style={{ color: "#eab308" }}>{cwdName}</span>
            <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
            <span style={{ color: "#22c55e" }}>{branch}</span>
            <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
            <span style={{ color: "#f97316" }}>
              <ModelStatusButton />
            </span>
            <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
            <TaskDock onSelect={setSelectedTaskId} />
          </div>
        </div>
      </div>
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  );
}
