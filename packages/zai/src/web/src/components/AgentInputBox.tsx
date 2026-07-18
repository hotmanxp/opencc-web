import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input, Button, message } from "antd";
import { PictureOutlined } from "@ant-design/icons";
import { useAgentStore, type AgentMessage } from "../store/useAgentStore";
import { readImageAsBase64, ImageReadError } from "../lib/imageReader";
import { api } from "../lib/api";
import { AttachmentStrip } from "../components/AttachmentStrip";
import ConversationInfoButton from "../components/ConversationInfoButton";

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

export default function AgentInputBox() {
  const status = useAgentStore((s) => s.status);
  const sessionId = useAgentStore((s) => s.sessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const pendingAsk = useAgentStore((s) => s.pendingAsk);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevStatusRef = useRef<typeof status>("idle");

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
      try {
        const res = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: item.name, args: "" }),
        });
        const data = (await res.json()) as { type: string; payload?: any };
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
  }, []);

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
            e instanceof ImageReadError ? e.message : (e as Error).message;
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
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
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
            await postPromptToLLM(result.payload.rendered, blocks);
            return;
          case "message":
            message.info(result.payload.text, 3);
            return;
          case "unknown":
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
      {/* status bar: 顶部一行 — cwd / 模型 / streaming 提示 / 附件缩略图内嵌 / 上传图片按钮 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.25)",
          borderRadius: 6,
          marginBottom: 6,
          fontSize: 12,
        }}
      >
        {/* cwd 文本 / 模型名 / streaming 提示 — 简化版; 完整 status bar 内容由 Task 7 搬入 */}
        {status === "streaming" && (
          <span style={{ color: "rgba(255,255,255,0.45)" }}>· esc 中断</span>
        )}
        {/* 附件缩略图内嵌到 status bar 内, 与按钮同一行, 缩到 40px, 紧贴状态文字.
            compact 去除外层 padding; flexWrap: wrap 让多张时换行. */}
        {attachments.length > 0 && (
          <AttachmentStrip
            attachments={attachments}
            onRemove={removeAttachment}
            align="start"
            size={40}
            compact
          />
        )}
        <span style={{ flex: 1 }} />
        <Button
          icon={<PictureOutlined />}
          onClick={() => fileInputRef.current?.click()}
          title="上传图片"
          disabled={status === "streaming" || pendingAsk?.status === "pending"}
          style={{ color: "rgba(255,255,255,0.45)" }}
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
}
