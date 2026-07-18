import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input } from "antd";
import { useAgentStore } from "../store/useAgentStore";

const { TextArea } = Input;

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

  return <div data-agent-inputbox-placeholder />;
}
