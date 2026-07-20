import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input, Button, message, Popover, Tooltip } from "antd";
import { PictureOutlined, ToolOutlined, CompressOutlined, ExpandOutlined } from "@ant-design/icons";
import { useAgentStore, type AgentMessage } from "../store/useAgentStore";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";
import { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
import { api } from "../lib/api";
import { AttachmentStrip } from "../components/AttachmentStrip";
import ConversationInfoButton from "../components/ConversationInfoButton";
import TodoDropdown from "./TodoDropdown.js";
import { readImageAsBase64, ImageReadError } from "../lib/imageReader";

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

const { TextArea } = Input;

const MAX_ATTACHMENTS_PER_TURN = 4;

const TITLE_MAX_LEN = 50;
function deriveLocalTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return "";
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine;
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + "…";
}

type SlashItem = {
  kind: "command" | "skill";
  name: string;
  description: string;
  argumentHint?: string;
  whenToUse?: string;
  isBuiltIn?: boolean;
  isConflict?: boolean;
  type?: "local" | "prompt";
  displayName?: string;
  pluginName?: string;
};

export default React.memo(function AgentInputBox() {
  const status = useAgentStore((s) => s.status);
  const sessionId = useAgentStore((s) => s.sessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const pendingAsk = useAgentStore((s) => s.pendingAsk);
  // 任务摘要: 从 store 取当前 session 的 todos + v2 tasks, 合并统计 N/M 任务.
  // 修复: 任务摘要从独立 BottomStatusBar 行合并到状态行, 让 UI 更紧凑.
  // 取 store 字段而非 props — AgentInputBox 是叶子组件, 让 store selector
  // 自动追踪 sid 变化, 避免父组件多传一组 props.
  const todos: TodoItem[] = useAgentStore((s) =>
    s.sessionId ? s.todosBySession[s.sessionId] ?? [] : []
  );
  const v2Tasks: V2TaskItem[] = useAgentStore((s) =>
    s.sessionId ? s.v2TasksBySession[s.sessionId] ?? [] : []
  );
  const todoTotal = todos.length;
  const transcriptCollapsed = useAgentStore((s) => s.transcriptCollapsed);
  const toggleTranscriptCollapsed = useAgentStore(
    (s) => s.toggleTranscriptCollapsed,
  );
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const todoInProgress = todos.filter((t) => t.status === "in_progress").length;
  const v2Total = v2Tasks.length;
  const v2Done = v2Tasks.filter((t) => t.status === "completed").length;
  const v2InProgress = v2Tasks.filter((t) => t.status === "in_progress").length;
  const totalTasks = todoTotal + v2Total;
  const doneTasks = todoDone + v2Done;
  const inProgressTasks = todoInProgress + v2InProgress;
  const openTasks =
    totalTasks - doneTasks - inProgressTasks;

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevStatusRef = useRef<typeof status>("idle");

  // 流式计时: 仅在 streaming 期间累加秒数, 状态切回 idle/aborted/error 时归零
  const [elapsed, setElapsed] = useState(0);
  const streamStartRef = useRef<number | null>(null);
  // 流式动画: 仿 OpenCC 状态栏的 ✶✷✸✹✺✻✼✽ 字符循环, 每 100ms 切一帧
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const SPINNER = ["✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

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

  // unmount 时清理 objectURL
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 流式结束 + 无 pendingAsk 时 refocus 输入框
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === "streaming" && status !== "streaming" && !pendingAsk) {
      textareaRef.current?.focus();
    }
  }, [status, pendingAsk]);

  // slash items: 初次挂载 fetch
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  useEffect(() => {
    fetch("/api/slash")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.items)) setSlashItems(data.items);
      })
      .catch(() => {});
  }, []);

  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillMenuIdx, setSkillMenuIdx] = useState(0);
  // transcript 修复按钮 loading 态: 与 status === "streaming" 互斥(避免
  // 在对话进行中触发对当前文件的写操作;否则 concurrent append 会跟 repair 的
  // fileLock 撞车, 报 EAGAIN)。
  const [repairing, setRepairing] = useState(false);

  // 模糊匹配: 检查 query 的字符是否按顺序出现在 target 中（可不连续）
  const fuzzyMatch = (query: string, target: string): number => {
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
  };

  const filteredSlash = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const q = input.slice(1).toLowerCase();
    if (!q) {
      const cmds = slashItems
        .filter((i) => i.kind === "command" && i.isBuiltIn)
        .sort((a, b) => a.name.localeCompare(b.name));
      const sks = slashItems
        .filter((i) => i.kind === "skill")
        .sort((a, b) => a.name.localeCompare(b.name));
      return [...cmds, ...sks].slice(0, 30);
    }
    const scoreItem = (it: SlashItem) => {
      const nameScore = fuzzyMatch(q, it.name);
      if (nameScore === 0) return 0;
      const descScore = fuzzyMatch(q, it.description);
      return nameScore + (descScore > 0 ? descScore * 0.3 : 0);
    };
    const cmds = slashItems
      .filter((i) => i.kind === "command")
      .map((it) => ({ it, s: scoreItem(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
    const sks = slashItems
      .filter((i) => i.kind === "skill")
      .map((it) => ({ it, s: scoreItem(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
    return [...cmds, ...sks].slice(0, 30);
  }, [input, slashItems]);

  useEffect(() => {
    setSkillMenuIdx(0);
    setShowSkillMenu(filteredSlash.length > 0);
  }, [filteredSlash.length]);

  useEffect(() => {
    if (!showSkillMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        skillMenuRef.current &&
        !skillMenuRef.current.contains(e.target as Node)
      ) {
        setShowSkillMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSkillMenu]);

  const selectSlashItem = useCallback(async (item: SlashItem) => {
    setShowSkillMenu(false);
    if (item.kind === "command" && item.type === "local") {
      const sid = sessionId || activeSessionId || undefined;
      try {
        // 走与 handleSend 一致的 /agent/command (旧 /api/command 不存在,
        // 会触发 404 HTML 错误页 → Unexpected token '<').
        const data = await api.post<{ type: string; payload?: any }>(
          "/agent/command",
          { name: item.name, args: "", ...(sid ? { sessionId: sid } : {}) },
        );
        switch (data.type) {
          case "cleared":
            useAgentStore.getState().clearMessages();
            message.success(`已清空对话: /${item.name}`);
            break;
          case "compacted":
            message.success(
              `已压缩 ${data.payload?.removedMessages ?? 0} 条历史`,
            );
            break;
          case "status":
            message.info(`状态: ${JSON.stringify(data.payload)}`);
            break;
          case "message":
            message.info(data.payload?.text ?? "");
            break;
          case "error":
            message.error(data.payload?.message ?? "命令执行失败");
            break;
          case "unknown":
            message.warning(`未知命令: ${data.payload?.input ?? item.name}`);
            break;
          default:
            message.info(`/${item.name} 已执行`);
        }
      } catch (err) {
        message.error(
          `执行失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    setInput("/" + item.name + " ");
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [sessionId, activeSessionId]);

  const addAttachments = async (files: File[]) => {
    const accepted = files.slice(0, MAX_ATTACHMENTS_PER_TURN);
    const placeholders: PendingAttachment[] = accepted.map((file) => ({
      localId: crypto.randomUUID(),
      mime: file.type,
      size: file.size,
      filename: file.name || "image",
      thumbnailUrl: URL.createObjectURL(file),
      base64DataUrl: "",
      status: "reading",
    }));
    setAttachments((prev) => [...prev, ...placeholders]);
    await Promise.all(
      placeholders.map(async (p, i) => {
        try {
          const r = await readImageAsBase64(accepted[i]!);
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, base64DataUrl: r.dataUrl, status: "ready" }
                : a,
            ),
          );
        } catch (e) {
          const msg =
            e instanceof ImageReadError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e);
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, status: "error", error: msg }
                : a,
            ),
          );
        }
      }),
    );
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.localId === localId);
      if (att) URL.revokeObjectURL(att.thumbnailUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    void addAttachments(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (status === "streaming") {
      e.preventDefault();
      message.warning("请等待当前回复结束");
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    e.preventDefault();
    void addAttachments(files);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    void addAttachments(files);
    e.target.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSkillMenu && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillMenuIdx((i) => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillMenuIdx(
          (i) => (i - 1 + filteredSlash.length) % filteredSlash.length,
        );
        return;
      }
      // Tab: 补全到输入框 (像 shell/IDE 的补全体感)
      // Enter: 选中并执行 (与 Tab 分工, 避免误触发执行)
      if (e.key === "Tab") {
        e.preventDefault();
        const it = filteredSlash[skillMenuIdx];
        if (it) {
          setInput("/" + it.name + " ");
          setShowSkillMenu(false);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const it = filteredSlash[skillMenuIdx];
        if (it) void selectSlashItem(it);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkillMenu(false);
        return;
      }
    }
    // shift+tab: cycle permission mode (only when idle, not while streaming)
    if (e.key === "Tab" && e.shiftKey && status === "idle" && sessionId) {
      e.preventDefault();
      const currentMode =
        useAgentStore.getState().sessions.find(
          (s) => s.transcriptId === sessionId,
        )?.permissionMode ?? "default";
      const idx = MODE_CYCLE_ORDER.indexOf(currentMode);
      const next = MODE_CYCLE_ORDER[(idx + 1) % MODE_CYCLE_ORDER.length]!;
      void useAgentStore.getState().patchSessionMode(sessionId, next);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const postPromptToLLM = useCallback(
    async (
      text: string,
      blocks: Array<{
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }>,
    ) => {
      const { sessionId: returnedSessionId } = await api.post<{
        sessionId: string;
      }>("/agent/prompt", {
        prompt: text || undefined,
        contentBlocks: blocks.length > 0 ? blocks : undefined,
        sessionId: sessionId || activeSessionId || undefined,
      }, {
        // X-Session-Id 与 body.sessionId 同步: server 现在用 body.sessionId
        // 决定是续传还是新会话, header 是冗余校验 + 日志/审计用, 让 server
        // 能在多 tab 串号场景里发现并拒绝.
        headers: (sessionId || activeSessionId) ? { 'X-Session-Id': sessionId || activeSessionId || '' } : undefined,
      });
      useAgentStore.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      });
      const localTitle = deriveLocalTitle(text);
      if (localTitle) {
        useAgentStore.getState().applySessionEvent({
          type: "session.renamed",
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        });
      }
    },
    [sessionId, activeSessionId],
  );

  const pushUserMsg = useCallback(
    (text: string, isRenderedPrompt = false) => {
      const ready = attachments.filter((a) => a.status === "ready")
      useAgentStore.setState((s) => ({
        status: "streaming",
        messages: [
          ...s.messages,
          {
            eventId: `user-${Date.now()}-${isRenderedPrompt ? "r" : "o"}`,
            sessionId: "",
            ts: Date.now(),
            turnIndex: 0,
            type: "user.text",
            text,
            isRenderedPrompt,
            attachments: ready.map((a) => ({
              localId: a.localId,
              mime: a.mime,
              filename: a.filename,
              thumbnailUrl: a.base64DataUrl,
              status: a.status,
            })),
          },
        ],
        sendSeq: s.sendSeq + 1,
      }))
      ready.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
      setAttachments((prev) => prev.filter((a) => a.status !== "ready"))
    },
    [attachments],
  )

  const handleSend = async () => {
    const text = input.trim();
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    const blocks = readyAttachments.map((a) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: a.mime,
        data: a.base64DataUrl.replace(/^data:[^;]+;base64,/, ""),
      },
    }));
    if (text.startsWith("/")) {
      setInput("");
      const sp = text.indexOf(" ");
      const name = sp === -1 ? text.slice(1) : text.slice(1, sp);
      const args = sp === -1 ? "" : text.slice(sp + 1);
      const sid = sessionId || activeSessionId || undefined;
      try {
        const result = await api.post<{ type: string; payload: any }>(
          "/agent/command",
          { name, args, ...(sid ? { sessionId: sid } : {}) },
        );
        switch (result.type) {
          case "cleared":
            useAgentStore.getState().clearMessages();
            message.success("对话已清空");
            return;
          case "compacted":
            message.success(
              `压缩完成,移除 ${result.payload.removedMessages} 条`,
            );
            await useAgentStore.getState().loadSessions();
            return;
          case "status":
            message.info(
              `cwd: ${result.payload.cwd}\nmodel: ${result.payload.model}\nsession: ${result.payload.sessionId ?? "-"}`,
              5,
            );
            return;
          case "prompt":
            pushUserMsg(text, false);
            if (result.payload?.rendered) {
              pushUserMsg(result.payload.rendered, true);
            }
            await postPromptToLLM(result.payload?.rendered ?? "", blocks);
            return;
          case "message":
            message.info(result.payload.text, 3);
            return;
          case "unknown":
            pushUserMsg(text, false);
            await postPromptToLLM(text, blocks);
            return;
          case "error":
            message.error(result.payload.message);
            return;
        }
      } catch (err) {
        message.error(`命令执行失败: ${(err as Error).message}`);
        return;
      }
    }
    if (!text && blocks.length === 0) return;
    if (status === "streaming") return;
    setInput("");

    const userMsg: AgentMessage = {
      eventId: `user-${Date.now()}`,
      sessionId: "",
      ts: Date.now(),
      turnIndex: 0,
      type: "user.text",
      text,
      attachments: readyAttachments.map((a) => ({
        localId: a.localId,
        mime: a.mime,
        filename: a.filename,
        thumbnailUrl: a.base64DataUrl,
        status: a.status,
      })),
    };
    useAgentStore.setState((s) => ({
      status: "streaming",
      messages: [...s.messages, userMsg],
      sendSeq: s.sendSeq + 1,
    }));

    attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl));
    setAttachments([]);

    await postPromptToLLM(text, blocks);
  };

  return (
    <div>
      {/* 状态栏: 仿 OpenCC 的 "✽ Pollinating… (Ns · ↓ tokens)" 行.
          现在内嵌附件缩略图: 单行横向 flex, spacer 把缩略图与按钮推到右侧;
          缩略图本身 align="end" 多张时仍右对齐, 多张会自动换行撑高状态栏.
          修复: 同时承担"任务摘要"职责 — 当会话有未完成任务时, 在状态文字后
          追加 `· 1/3 任务 · 1 进行中`, 让任务行合并到此处, 减少一行高度. */}
      <div
        data-testid="agent-input-status-row"
        style={{
          borderTop: "1px solid rgba(255,255,255,0.10)",
          borderBottom: "1px solid rgba(255,255,255,0.10)",
          padding: "6px 10px",
          fontSize: 12,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          color: "rgba(255,255,255,0.45)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            color:
              status === "idle"
                ? "#22c55e"
                : status === "streaming"
                  ? "#ff6600"
                  : "inherit",
          }}
        >
          {status === "streaming"
            ? SPINNER[spinnerIdx]
            : status === "error"
              ? "✗"
              : status === "aborted"
                ? "◼"
                : "●"}
        </span>
        <span>
          {status === "idle" && "就绪"}
          {status === "streaming" && `对话中… (${elapsed}s)`}
          {status === "aborted" && "已中止"}
          {status === "error" && "错误"}
        </span>
        {/* 任务摘要: 始终展示, 避免对话进行中被"遮挡"造成用户找不到任务进度.
            修复历史: 早期版本 streaming 时整段不渲染, 用户反馈"被遮"; 改为始终
            渲染 + 流式期间降透明, 视觉上不与 spinner 抢眼, 又不丢信息.
            flex 保护: flexShrink:0 + whiteSpace:nowrap + overflow:hidden/textOverflow:
            ellipsis 防止右端按钮(PictureOutlined + InfoCircleOutlined)通过
            flex spacer 把任务摘要挤到 0 宽 — 之前症状: 窄屏/长任务文本时
            "X/Y 任务 · K 待开始" 整段被挤不可见. */}
        {totalTasks > 0 && (
          <Popover
            content={<TodoDropdown todos={todos} v2Tasks={v2Tasks} />}
            trigger="click"
            placement="topLeft"
            arrow={false}
            destroyTooltipOnHide
          >
            <Tooltip title="点击查看任务详情" placement="top">
              <span
                data-testid="agent-input-task-summary"
                style={{
                  color: "rgba(255,255,255,0.65)",
                  cursor: "pointer",
                  // 关键 flex 保护: 不让右端 spacer + 按钮把这段挤没.
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  // 流式期间降透明, 让 spinner 成为视觉焦点, 任务信息仍可读.
                  opacity: status === "streaming" ? 0.65 : 1,
                  transition: "opacity 0.2s",
                }}
              >
                <span style={{ color: "rgba(255,255,255,0.25)", marginRight: 4 }}>·</span>
                <span style={{ color: doneTasks === totalTasks ? "#52c41a" : "rgba(255,255,255,0.85)" }}>
                  {doneTasks}/{totalTasks} 任务
                </span>
                {inProgressTasks > 0 && (
                  <span style={{ color: "#a78bfa", marginLeft: 8 }}>
                    · {inProgressTasks} 进行中
                  </span>
                )}
                {openTasks > 0 && (
                  <span style={{ color: "rgba(255,255,255,0.55)", marginLeft: 8 }}>
                    · {openTasks} 待开始
                  </span>
                )}
              </span>
            </Tooltip>
          </Popover>
        )}
        {status === "streaming" && (
          <span style={{ color: "rgba(255,255,255,0.45)" }}>· esc 中断</span>
        )}
        {attachments.length > 0 && (
          <AttachmentStrip
            attachments={attachments}
            onRemove={removeAttachment}
            align="start"
            size={40}
            compact
          />
        )}
        {/* spacer: flex:1 把右端按钮推到底部右边.
            minWidth:0 关键 — 不加时 flex item 默认 min-width:auto (= content 尺寸),
            在窄屏下 spacer 会反向挤压任务摘要到 0 宽, 表现为"被遮挡". */}
        <span style={{ flex: 1, minWidth: 0 }} />
        {/* 折叠/展开 transcript 按钮: 与 transcript repair 按钮相邻, 都是 transcript 相关.
            图标在 collapsed=false 时显示 ExpandOutlined (可折叠), true 时显示
            CompressOutlined (可展开), hover Tooltip 给完整文案, 与同行其他图标按钮
            视觉风格保持一致 (icon-only + flexShrink:0). */}
        <Tooltip
          title={transcriptCollapsed ? "展开 transcript" : "折叠 transcript"}
          placement="top"
        >
          <Button
            icon={transcriptCollapsed ? <CompressOutlined /> : <ExpandOutlined />}
            data-testid="transcript-collapse-button"
            onClick={() => toggleTranscriptCollapsed()}
            style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}
          />
        </Tooltip>
        {/* 修复 transcript 按钮:
            对当前 session 触发 POST /api/transcript/:sessionId/repair,把历史上
            漏写的 tool_result 补成"tool execution did not complete" 占位,
            解决 transcript 里 tool_use 没配对的 warning。按钮放在 spacer 后、
            上传图片前 — 不抢主操作, 但用户能直接找到。点击后即时 toast 结果,
            失败不打断会话。 */}
        <Tooltip
          title={
            sessionId
              ? "修复 transcript:补齐漏写的 tool_result,然后才能正常恢复会话"
              : "当前没有会话"
          }
          placement="top"
        >
          <Button
            icon={<ToolOutlined />}
            data-testid="transcript-repair-button"
            disabled={!sessionId || status === "streaming"}
            loading={repairing}
            onClick={async () => {
              if (!sessionId || repairing) return
              setRepairing(true)
              try {
                const res = await fetch(
                  `/api/transcript/${encodeURIComponent(sessionId)}/repair`,
                  { method: "POST" },
                )
                if (!res.ok) {
                  const text = await res.text().catch(() => "")
                  throw new Error(text || `HTTP ${res.status}`)
                }
                const data = (await res.json()) as {
                  repaired: boolean
                  repairedToolUseIds: string[]
                  synthesizedToolUseIds: string[]
                  synthesizedOrphanToolUseIds: string[]
                }
                if (data.repaired) {
                  const orphanCount = data.synthesizedOrphanToolUseIds.length
                  const activeCount = data.synthesizedToolUseIds.length
                  const summary = [
                    activeCount > 0 ? `孤立 tool_use ${activeCount}` : null,
                    orphanCount > 0 ? `孤儿分支复活 ${orphanCount}` : null,
                  ]
                    .filter(Boolean)
                    .join("、")
                  message.success(`已修复: ${summary}`)
                } else {
                  message.info("transcript 健康,无需修复")
                }
              } catch (err) {
                message.error(
                  `修复失败: ${err instanceof Error ? err.message : String(err)}`,
                )
              } finally {
                setRepairing(false)
              }
            }}
            style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}
          />
        </Tooltip>
        <Button
          icon={<PictureOutlined />}
          onClick={() => fileInputRef.current?.click()}
          title="上传图片"
          disabled={status === "streaming" || pendingAsk?.status === "pending"}
          style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}
        />
        <ConversationInfoButton />
      </div>

      {/* TextArea + slash dropdown 区 */}
      <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            position: "relative",
          }}
        >
          {/* Slash 自动补全下拉菜单 */}
          {showSkillMenu && filteredSlash.length > 0 && (
            <div
              ref={skillMenuRef}
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                right: 0,
                marginBottom: 4,
                background: "#1a1a1e",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 8,
                maxHeight: 240,
                overflowY: "auto",
                zIndex: 1000,
                boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
              }}
            >
              {filteredSlash.map((item, idx) => (
                <div
                  key={item.kind + ":" + item.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void selectSlashItem(item);
                  }}
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background:
                      idx === skillMenuIdx
                        ? "rgba(255,102,0,0.15)"
                        : "transparent",
                    borderLeft:
                      idx === skillMenuIdx
                        ? "3px solid #ff6600"
                        : "3px solid transparent",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={() => setSkillMenuIdx(idx)}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#a78bfa",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      whiteSpace: "nowrap",
                      minWidth: 180,
                      flexShrink: 0,
                    }}
                  >
                    /{item.displayName ?? item.name}
                  </span>
                  {item.description && (
                    <span
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.45)",
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
                        item.kind === "command"
                          ? "#a78bfa"
                          : "rgba(255,255,255,0.45)",
                      background:
                        item.kind === "command"
                          ? "rgba(167,139,250,0.18)"
                          : "rgba(255,255,255,0.08)",
                      flexShrink: 0,
                    }}
                  >
                    {item.kind}
                  </span>
                </div>
              ))}
            </div>
          )}
          <TextArea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入消息, 按 Enter 发送, Shift+Enter 换行. 可直接粘贴或拖拽图片."
            rows={3}
            disabled={
              status === "streaming" || pendingAsk?.status === "pending"
            }
            style={{ resize: "none", flex: 1 }}
          />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleFilePick}
      />
    </div>
  );
});
