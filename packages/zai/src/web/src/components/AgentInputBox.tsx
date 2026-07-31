import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input, Button, message, Popover, Tooltip } from "antd";
import {
  PictureOutlined,
  ToolOutlined,
  CompressOutlined,
  ExpandOutlined,
  MenuUnfoldOutlined,
  ShareAltOutlined,
  StopOutlined,
  AppstoreAddOutlined,
} from "@ant-design/icons";
import {
  STORAGE_KEYS,
  useLocalStorageState,
} from "../components/splitPane/shared.js";
import { useSplitPaneCompactLock } from "../hooks/useSplitPaneCompactLock.js";
import { useSubmitPrompt } from "../hooks/useSubmitPrompt.js";
import { useAgentStore, type AgentMessage } from "../store/useAgentStore";
import type { V2TaskItem } from "../store/useAgentStore.js";
import { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
import { useAppStore } from "../store/useAppStore";
import { api } from "../lib/api";
import { AttachmentStrip } from "../components/AttachmentStrip";
import ConversationInfoButton from "../components/ConversationInfoButton";
import SettingsButton from './SettingsButton'
import SharePopover from "./SharePopover.js";
import { toolbarIconButtonStyle, TOOLBAR_ACTIVE_COLOR } from "./toolbarStyles.js";
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

// crypto.randomUUID() 在 insecure context 下抛异常 (HTTP 非 localhost).
// LAN 模式下访问 zai 的场景 (192.168.x.x) 走 HTTP, 触发 addAttachments 后整段
// 会中断 → 缩略图不显示. 这里兜底到时间戳+随机数, 仅用于本地 React key 用,
// 不参与任何 cryptographic 用途.
function genLocalId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore — 某些浏览器在非 secure context 下访问 crypto.randomUUID 会抛 TypeError */
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

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

/**
 * AgentInputBox 直接从 useAppStore.isMobile 读取移动端判断, 不再接受 props.
 * 由 useIsMobile() (挂在 Layout 顶部) 通过 matchMedia 同步到 store.
 */
export default React.memo(function AgentInputBox() {
  const status = useAgentStore((s) => s.status);
  const sessionId = useAgentStore((s) => s.sessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const isMobile = useAppStore((s) => s.isMobile);
  const pendingAsk = useAgentStore((s) => s.pendingAsk);
  // 任务摘要: 从 store 取当前 session 的 v2 tasks 统计 N/M 任务.
  // 修复: 任务摘要从独立 BottomStatusBar 行合并到状态行, 让 UI 更紧凑.
  // 取 store 字段而非 props — AgentInputBox 是叶子组件, 让 store selector
  // 自动追踪 sid 变化, 避免父组件多传一组 props.
  // 2026-07-31: 老 TODO (todosBySession) 已被 refactor 删除, 全部走 v2 task tools.
  const v2Tasks: V2TaskItem[] = useAgentStore((s) =>
    s.sessionId ? s.v2TasksBySession[s.sessionId] ?? [] : []
  );
  // 单一布尔 transcriptCollapsed:Layout hydrate 时根据 settings.outputStyle
  // 把初始值定为 (compact === true),用户点工具栏按钮 → 直接翻转.
  // 这里 *不* 重新计算 visuallyCollapsed — transcriptCollapsed 本身就是
  // 当前视觉折叠态,刷新时回到 Layout hydrate 后的值(由 settings 决定).
  const transcriptCollapsed = useAgentStore((s) => s.transcriptCollapsed);
  const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed);
  // 分屏开启时锁住 transcript-collapsed 折叠按钮 — hook 内 effect 会立刻把
  // transcriptCollapsed 设为 true, 然后整个按钮 + Tooltip 不挂载, 让 "分屏
  // 模式下不可切换"的契约在 DOM 层一次性落实.
  const { isLocked: transcriptLockActive } = useSplitPaneCompactLock();
  // outputStyle 仅用于 tooltip 文案:让用户知道 settings 是 compact,
  // 刷新后会回到当前这个工具栏按钮点击后的反向设置.
  const outputStyle = useAppStore((s) => s.outputStyle);
  const v2Total = v2Tasks.length;
  const v2Done = v2Tasks.filter((t) => t.status === "completed").length;
  const v2InProgress = v2Tasks.filter((t) => t.status === "in_progress").length;
  const totalTasks = v2Total;
  const doneTasks = v2Done;
  const inProgressTasks = v2InProgress;
  const openTasks = v2Total - v2Done - v2InProgress;

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
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
  // 右侧分屏开关: 复用 STORAGE_KEYS.open 与 SplitPane + 左侧栏 toggle 共享.
  // useLocalStorageState 自带 same-tab 的 'zai-localstorage-sync' 事件, 写一次
  // → 所有持有同 key 的组件(本按钮 / 左侧栏 SplitPaneToggle / SplitPane 内部
  // 顶角 toggle)同步翻转, 无需在 Agent.tsx 多传一组 props.
  const [splitPaneOpen, setSplitPaneOpen] = useLocalStorageState<boolean>(
    STORAGE_KEYS.open,
    false,
  );

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
      localId: genLocalId(),
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

  const { submitPrompt, pushUserMsg } = useSubmitPrompt();

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
            // 上方已手工 pushUserMsg 原文本 + 渲染版,这里 skip 让
            // submitPrompt 不重复 push,避免 msgs 出现 duplicate user.text.
            await submitPrompt(result.payload?.rendered ?? text, {
              skipPushUserMsg: true,
            });
            return;
          case "message":
            message.info(result.payload.text, 3);
            return;
          case "unknown":
            pushUserMsg(text, false);
            await submitPrompt(text, { skipPushUserMsg: true });
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

    attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl));
    setAttachments([]);

    if (blocks.length > 0) {
      // 含图片附件: 仍走原始内联实现 (submitPrompt hook 不接 contentBlocks,
      // 保持图片附件路径不抽到 hook — 与 handleSend 历史契约对齐, 避免破坏
      // 已有 ["AgentInputBox"] 附件提交路径).
      // 注意: 该分支不调 pushUserMsg — UI 走 transcript 刷新路径,
      // server 把 user 消息落盘后由 loadTranscript 渲染一条 user.text.
      // 纯文本分支由 submitPrompt 默认行为 push 一条 user.text, 不重复.
      const sid = sessionId || activeSessionId || undefined;
      const { sessionId: returnedSessionId } = await api.post<{
        sessionId: string;
      }>(
        "/agent/prompt",
        { prompt: text || undefined, contentBlocks: blocks, sessionId: sid },
        { headers: sid ? { "X-Session-Id": sid } : undefined },
      );
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
    } else {
      await submitPrompt(text);
    }
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
          borderTop: "1px solid var(--border-light)",
          borderBottom: "1px solid var(--border-light)",
          padding: "6px 10px",
          fontSize: 12,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          color: "var(--text-tertiary)",
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
                ? "var(--success)"
                : status === "streaming"
                  ? "var(--accent-start)"
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
        {!isMobile && (
          <span>
            {status === "idle" && "就绪"}
            {status === "streaming" && `对话中… (${elapsed}s)`}
            {status === "aborted" && "已中止"}
            {status === "error" && "错误"}
          </span>
        )}
        {/* 任务摘要: 始终展示, 避免对话进行中被"遮挡"造成用户找不到任务进度.
            修复历史: 早期版本 streaming 时整段不渲染, 用户反馈"被遮"; 改为始终
            渲染 + 流式期间降透明, 视觉上不与 spinner 抢眼, 又不丢信息.
            flex 保护: flexShrink:0 + whiteSpace:nowrap + overflow:hidden/textOverflow:
            ellipsis 防止右端按钮(PictureOutlined + InfoCircleOutlined)通过
            flex spacer 把任务摘要挤到 0 宽 — 之前症状: 窄屏/长任务文本时
            "X/Y 任务 · K 待开始" 整段被挤不可见. */}
        {totalTasks > 0 && (
          <Popover
            content={<TodoDropdown v2Tasks={v2Tasks} />}
            trigger="click"
            placement="topLeft"
            arrow={false}
            destroyTooltipOnHide
          >
            <Tooltip title="点击查看任务详情" placement="top">
              <span
                data-testid="agent-input-task-summary"
                style={{
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  // 关键 flex 保护: 不让右端 spacer + 按钮把这段挤没.
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  // 流式期间降透明, 让 spinner 成为视觉焦点, 任务信息仍可读.
                  opacity: status === "streaming" ? 0.7 : 1,
                  transition: "opacity 0.2s",
                }}
              >
                <span style={{ color: "var(--text-tertiary)", marginRight: 4 }}>·</span>
                <span style={{ color: doneTasks === totalTasks ? "var(--success)" : "var(--text-primary)" }}>
                  {doneTasks}/{totalTasks} 任务
                </span>
                {inProgressTasks > 0 && (
                  <span style={{ color: "#a78bfa", marginLeft: 8 }}>
                    · {inProgressTasks} 进行中
                  </span>
                )}
                {openTasks > 0 && (
                  <span style={{ color: "var(--text-tertiary)", marginLeft: 8 }}>
                    · {openTasks} 待开始
                  </span>
                )}
              </span>
            </Tooltip>
          </Popover>
        )}
        {/* Esc 中断提示仅在桌面端展示, 移动端用输入框旁的"停止"按钮替代 —
            物理/虚拟键盘没有 Esc 键, 文字提示对移动用户没意义.
            桌面端保留是为了让键盘用户能记住快捷键. */}
        {status === "streaming" && !isMobile && (
          <span style={{ color: "var(--text-tertiary)" }}>· esc 中断</span>
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
        {/* Share 按钮: 分享当前 session 到 LAN.
            - 位置: spacer 后最右, 作为工具栏右端第一入口 (演示场景核心操作).
            - disabled: 无 sessionId 时 disabled (分享空 session 无意义).
            - Popover: 受控 open={shareOpen}, 内部渲染 SharePopover.
            - 图标色与同行其他按钮一致 (var(--text-dim-45)).
            详见 docs/superpowers/specs/2026-07-25-zai-agent-share-design.md §4.6 */}
        <Tooltip
          title={
            sessionId
              ? "分享到 LAN — 点开后选择 IP 复制链接发给同事"
              : "先开一个会话再分享"
          }
          placement="top"
        >
          <Popover
            open={shareOpen}
            onOpenChange={(v) => setShareOpen(v)}
            trigger="click"
            placement="topRight"
            arrow={false}
            destroyTooltipOnHide
            content={<SharePopover />}
          >
            <Button
              icon={<ShareAltOutlined />}
              data-testid="share-button"
              disabled={!sessionId}
              aria-pressed={shareOpen}
              style={{
                ...toolbarIconButtonStyle,
                ...(shareOpen && {
                  color: TOOLBAR_ACTIVE_COLOR,
                  borderColor: TOOLBAR_ACTIVE_COLOR,
                }),
              }}
            />
          </Popover>
        </Tooltip>
        <SettingsButton />
        {/* 折叠/展开 transcript 按钮: 与 transcript repair 按钮相邻, 都是 transcript 相关.
            图标在 collapsed=false 时显示 ExpandOutlined (可折叠), true 时显示
            CompressOutlined (可展开), hover Tooltip 给完整文案, 与同行其他图标按钮
            视觉风格保持一致 (icon-only + flexShrink:0).

            视觉态 = transcriptCollapsed, 初值由 Layout 根据 settings.outputStyle
            设好(compact → true,其余 → false). 按钮只翻这一个布尔, 不依赖 settings,
            因此在 compact 模式下点击也能正常切换. tooltip 在 outputStyle=compact 时
            提示"刷新后回到 compact"以区分与 settings 持久化的关系. */}
        {!transcriptLockActive && !isMobile && (
          <Tooltip
            title={
              outputStyle === "compact"
                ? transcriptCollapsed
                  ? "临时展开 transcript(刷新后回到 compact)"
                  : "临时收起 transcript(刷新后回到 compact)"
                : transcriptCollapsed
                  ? "展开 transcript"
                  : "折叠 transcript"
            }
            placement="top"
          >
            <Button
              icon={transcriptCollapsed ? <CompressOutlined /> : <ExpandOutlined />}
              data-testid="transcript-collapse-button"
              onClick={() => setTranscriptCollapsed(!transcriptCollapsed)}
              style={toolbarIconButtonStyle}
            />
          </Tooltip>
        )}
        {/* 修复 transcript 按钮:
            对当前 session 触发 POST /api/transcript/:sessionId/repair,把历史上
            漏写的 tool_result 补成"tool execution did not complete" 占位,
            解决 transcript 里 tool_use 没配对的 warning。按钮放在 spacer 后、
            上传图片前 — 不抢主操作, 但用户能直接找到。点击后即时 toast 结果,
            失败不打断会话。 */}
        {!isMobile && (
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
            style={toolbarIconButtonStyle}
          />
        </Tooltip>
        )}

        <Button
          icon={<PictureOutlined />}
          onClick={() => fileInputRef.current?.click()}
          title="上传图片"
          disabled={status === "streaming" || pendingAsk?.status === "pending"}
          style={toolbarIconButtonStyle}
        />
        <ConversationInfoButton />
        {/* 移动端「常用指令」按钮: 仅 isMobile 时挂载.
            位置: 工具栏最右端 (紧贴 ConversationInfoButton), 与桌面端
            split-pane toggle 平级. 移动端 split-pane toggle 不挂载, 这里
            是行尾最右一个按钮.
            行为: 调 useAppStore.setQuickDrawerOpen(true) 打开右侧 Drawer. */}
        {isMobile && (
          <Tooltip title="常用指令" placement="top">
            <Button
              icon={<AppstoreAddOutlined />}
              onClick={() => useAppStore.getState().setQuickDrawerOpen(true)}
              data-testid="mobile-quick-drawer-toggle"
              aria-label="打开常用指令"
              style={toolbarIconButtonStyle}
            />
          </Tooltip>
        )}
        {/* 右侧分屏 toggle — 行尾最右侧.
            图标用 MenuUnfoldOutlined (三线+右箭头, 侧边栏展开风格),
            比 BorderOutlined 更直观表达"右侧面板滑出"的操作.
            数据源 STORAGE_KEYS.open 与 SplitPane + 左侧栏 toggle 共享, 任意
            一处写 → 全局同步 (useLocalStorageState 自带 same-tab storage event).
            open 时用品牌色 #ff6600 高亮, 关闭时与同行其他按钮颜色一致. */}
        {!isMobile && (
        <Tooltip title="切换右侧分屏" placement="top">
          <Button
            icon={<MenuUnfoldOutlined />}
            data-testid="split-pane-toggle-inputbox"
            aria-pressed={splitPaneOpen}
            onClick={() => setSplitPaneOpen(!splitPaneOpen)}
            style={{
              ...toolbarIconButtonStyle,
              ...(splitPaneOpen && {
                color: TOOLBAR_ACTIVE_COLOR,
                borderColor: TOOLBAR_ACTIVE_COLOR,
              }),
            }}
          />
        </Tooltip>
        )}

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
                background: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                maxHeight: 240,
                overflowY: "auto",
                zIndex: 1000,
                boxShadow: "0 4px 24px var(--text-dim-50)",
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
                        color: "var(--text-dim-45)",
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
                          : "var(--text-dim-45)",
                      background:
                        item.kind === "command"
                          ? "rgba(167,139,250,0.18)"
                          : "var(--bg-faint-08)",
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
          {/* 移动端"停止"按钮: 替代桌面端的 Esc 键 —
            物理键盘/软键盘都没有 Esc, 必须给移动用户提供一个等价入口.
            - 仅 isMobile 时挂载 (桌面端继续靠 Esc keydown, 避免按钮占位);
            - 仅 streaming 时显示, 非流式态 stop 无意义;
            - 调用 useAgentStore.getState().stop() 与 AgentConversation 的
              全局 Esc 处理路径完全一致 (AgentConversation.tsx:91-99),
              走同一套后端 abort + status 流, 不会绕过任何清理逻辑. */}
          {isMobile && status === "streaming" && (
            <Button
              data-testid="mobile-stop-button"
              aria-label="停止生成"
              onClick={() => {
                void useAgentStore.getState().stop()
              }}
              style={{
                flexShrink: 0,
                marginLeft: 8,
                height: "auto",
                alignSelf: "stretch",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "0 12px",
                background: "rgba(255, 102, 0, 0.15)",
                border: "1px solid #ff6600",
                borderRadius: 6,
                color: "#ff6600",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <StopOutlined />
              <span>停止</span>
            </Button>
          )}
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
