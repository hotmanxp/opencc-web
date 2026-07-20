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
  Modal,
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
import { linkifyText } from "../lib/linkify.js";
import { getRenderer } from "../components/toolRenderers/registry.js";
import { splitMarkdownOnIncomplete } from "../lib/splitMarkdown.js";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
import ConfigStatusBar from "../components/ConfigStatusBar";
import { SessionCwdBridge } from "../components/SessionCwdBridge";
import { TaskDrawer } from "../components/TaskDrawer";
import SettingsDrawer from "../components/SettingsDrawer";
import TodoZone from "../components/TodoZone.jsx";
import { readImageAsBase64, ImageReadError } from "../lib/imageReader";
import AgentInputBox from "../components/AgentInputBox";
import { MessageBubble } from "../components/transcript/MessageBubble.js";
import { MessageListView } from "../components/transcript/MessageListView.js";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;


export default function Agent() {
  const messages = useAgentStore((s) => s.messages);
  const status = useAgentStore((s) => s.status);
  const cwd = useAgentStore((s) => s.cwd);
  const sessions = useAgentStore((s) => s.sessions);
  const sessionId = useAgentStore((s) => s.sessionId);
  const todosBySession = useAgentStore((s) => s.todosBySession);
  const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession);
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
  // v2TasksBySession 仍订阅在 store, 但渲染层 Agent.tsx 不再使用 —
  // 任务摘要现在由 AgentInputBox 内部从 store 直接取 (避免 props 透传).
  void v2TasksBySession;
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode);
  const { instanceContext } = useAppStore()
  const cwdName = instanceContext?.cwdName || '~'
  const branch = instanceContext?.branch || 'master'
  const { token } = theme.useToken();

  // Slash autocomplete: 输入 / 时弹出, 同时包含 builtin commands + user commands + skills
  // (type moved to AgentInputBox — T6 migration)

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
  // question 卡片滚到视口用: pendingAsk 不在 messages[] 里, 单依赖 messages 的滚动 effect
  // 不会触发, 这里单独加一个 ref 让卡片出现时也能滚到底.
  const questionCardRef = useRef<HTMLDivElement>(null);

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
    // 优先级: question 卡片出现时滚卡片, 否则滚 messages 流末尾.
    // pendingAsk 是独立字段, 必须放进依赖里否则卡片首次出现不触发.
    const target = questionCardRef.current ?? messagesEndRef.current;
    target?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pendingAsk]);

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

  // N 按钮处理函数: 在新 tab 打开 /agent?sid=newID, store.loadSessions 会
  // 识别 newID 字面量 → 直接调 createNewSession 建一条新 transcript, 并把
  // URL 同步成 server 回的真实 sid. 当前 tab 的会话状态完全不动.
  const openNewSessionInNewTab = () => {
    window.open(
      `${window.location.origin}/agent?sid=newID`,
      "_blank",
      "noopener"
    );
  };

  // 中断逻辑: 已无 UI 按钮, 流式期间按 Esc (window 全局监听) 触发 stop()
  // 修复: v2 tasks 的初始拉取已迁移到 useAgentStore.loadTranscript 内部,
  // 切 session → loadTranscript → 自动拉 v2 tasks. 这里不再重复拉.

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
            // 用 absolute + transform 让三个图标按钮绝对居中于 40px 列宽,
            // 绕开 AntD Button 内部 icon 偏左导致的视觉不齐.
            // 第 2 个 N 按钮 = 新 tab 打开 /agent?sid=newID (不影响当前 tab).
            <div style={{ position: "relative", width: "100%", height: 92 }}>
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
              {/* N 按钮: 在新 tab 打开全新会话, 保留当前 tab 会话状态不变. */}
              <Button
                type="text"
                size="small"
                onClick={openNewSessionInNewTab}
                title="在新标签页打开新会话"
                data-testid="new-session-in-new-tab"
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
                  // 用等宽字体 + 粗体 + 紫色, 与 antd 图标按钮区分开,
                  // 让用户一眼能识别这是"新 tab"语义 (与 Plus 不一样).
                  color: "#722ed1",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                N
              </Button>
              <Button
                type="text"
                size="small"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setSessionsCollapsed(false)}
                title="展开会话历史"
                style={{
                  position: "absolute",
                  top: 64,
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
              <Space style={{ fontSize: 12 }}>
                <MessageOutlined />
                历史
              </Space>
              <Space size={4}>
                <Button
                  type="text"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={createNewSession}
                  title="创建新会话"
                />
                {/* N 按钮: 在新 tab 打开全新会话, 不影响当前 tab. */}
                <Button
                  type="text"
                  size="small"
                  onClick={openNewSessionInNewTab}
                  title="在新标签页打开新会话"
                  data-testid="new-session-in-new-tab"
                  style={{
                    color: "#722ed1",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  N
                </Button>
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
          <MessageListView messages={messages} streaming={status === "streaming"} />
          {pendingAsk && (
            <div ref={questionCardRef}>
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
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/*
          修复: BottomStatusBar 整行已移除. 任务摘要职责合并到
          AgentInputBox 的"● 就绪"状态行 (见 AgentInputBox.tsx 内部实现),
          让 UI 更紧凑, 不再有一条独立任务行 + 一条状态行.
        */}
        <div className="bottom-stack">
          <AgentInputBox />
          <ConfigStatusBar
            cwdName={cwdName}
            branch={branch}
            onTaskSelect={setSelectedTaskId}
          />
        </div>
      </div>
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <SettingsDrawer />
      <SessionCwdBridge />
    </div>
  );
}
