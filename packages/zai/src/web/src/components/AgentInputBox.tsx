import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input, message } from "antd";
import { useAgentStore } from "../store/useAgentStore";
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
      // Step 5 will wire up handleSend
    }
  };

  return <div data-agent-inputbox-placeholder />;
}
