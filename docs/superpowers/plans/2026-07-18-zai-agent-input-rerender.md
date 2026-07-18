# zai Agent 输入时整页重渲染 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 zai Web Agent 页面在用户输入字符时的整页重渲染收敛到只重渲输入子树, 单次 keystroke 耗时从 ~1240ms 降到 ≤60ms。

**Architecture:** 拆分输入区为独立组件 (`AgentInputBox`), 主 `Agent` 改用细粒度 zustand selector, 消息相关组件加 `React.memo`, 消息列表用 `useMemo` 缓存。三层防护 (隔离 / 订阅粒度 / 组件 memo) 叠加, 任一失效下两层兜底。

**Tech Stack:** React 18.3 + zustand 5 + AntD 5 + react-markdown 10 + react-syntax-highlighter 16 + TypeScript 5.6 + Vite 7 + vitest

## Global Constraints

- 包路径: `packages/zai` (根包名 `@zn-ai/zai`)。
- 工作目录: `/Users/ethan/code/opencc-web/packages/zai`。
- 提交规范: `feat:` / `fix:` / `refactor:` / `test:` / `docs:`, 作用域用 `zai-web:`。
- 不引入新依赖 (zustand, react, antd 已存在)。
- 不动 `useAgentStore` 接口、不动后端、不动 SSE 协议。
- 风格: `const` > `let`; 避免不必要解构; 不引入 `as any` / `@ts-ignore` / 空 catch / catch-all。
- 不动 `MessageBubble` 的 props shape (M3 只在声明处加 `React.memo`, 不改 props)。
- 现有 vitest (`packages/zai/src/web/src/components/TaskDrawer.test.tsx`) 与本次重构正交, 无需新增测试。

---

## Task 1: 提取 `<AgentInputBox>` 组件骨架 (搬迁 + 隔离)

**Files:**
- Create: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1053-1057,1095-1106,1115-1128,1129-1164,1166-1206,1335-1375,1377-1396,1398-1417,1446-1542,1546-1588,1972-2095` (对应 input / attachments / slash / send / keydown / 文件附件 / TextArea JSX 一带)

**Interfaces:**
- Consumes: `useAgentStore` 选择 `status` / `sessionId` / `activeSessionId` / `pendingAsk` / `stop`; `useAppStore.instanceContext` (不需要, 移除)。
- Produces: 一个 default export React 组件, 内部自管 input / attachments / slash menu / file ref, 不需要 props。

**说明**: 本任务做最小骨架搬迁 — 把 input 区独立成组件, 用 `<AgentInputBox />` 占位替换原 JSX。**不**在这一步做 M2/M3/M4, 让 commit 历史清晰 (一个 commit 一个职责, 便于 review 时单点回滚)。

- [ ] **Step 1: 在 `Agent.tsx` 顶部加上 import 占位**

打开 `packages/zai/src/web/src/pages/Agent.tsx`, 在 import 区域 (大约 41-52 行) 末尾添加:

```tsx
import AgentInputBox from "../components/AgentInputBox";
```

(只加这一行, 文件底部稍后替换 JSX 时再真正使用。)

- [ ] **Step 2: 创建 `AgentInputBox.tsx` 空骨架**

新建 `packages/zai/src/web/src/components/AgentInputBox.tsx`:

```tsx
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
  return <div data-agent-inputbox-placeholder />;
}
```

注: 骨架只 import 用到的 (`Input` 因为 `TextArea` 解构), 其他 (useState/useRef/useEffect/useCallback/useMemo/AttachmentStrip/api 等) 在后续步骤按需 import。`PendingAttachment` 与 `SlashItem` 类型先在这里本地定义, 后续步骤把它们从 `Agent.tsx` 完全迁出, 然后从 `Agent.tsx` 删除对应定义。

- [ ] **Step 3: 验证骨架编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过 (新文件没有未使用 import 警告之外的问题)。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): scaffold AgentInputBox component"
```

---

## Task 2: 把 input state 搬迁到 AgentInputBox

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1053-1057,1095-1106,1097,1115-1164,1166-1206`

**Interfaces:**
- Produces: `AgentInputBox` 内部自管 `input` / `attachments` / `slashItems` / `showSkillMenu` / `skillMenuIdx` / `skillFilter` / 全部 ref, 暴露 selectSlashItem / addAttachments / removeAttachment / handlePaste / handleDrop / handleFilePick / handleSend / handleKeyDown 内部方法。

- [ ] **Step 1: 把 state + ref + effect 块搬运到 AgentInputBox**

在 `AgentInputBox.tsx` 替换整个组件函数体为:

```tsx
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
```

- [ ] **Step 2: 从 Agent.tsx 删除对应 state/ref/effect**

打开 `packages/zai/src/web/src/pages/Agent.tsx`, 删除以下行 (行号是近似, 用变量名搜索更精确):

- 第 1053 行 `const [input, setInput] = useState('')` —— 删除整行
- 第 1056 行 `const [attachments, setAttachments] = useState<PendingAttachment[]>([]);` —— 删除
- 第 1057 行 `const fileInputRef = useRef<HTMLInputElement>(null);` —— 删除
- 第 1062 行 `const textareaRef = useRef<HTMLTextAreaElement>(null);` —— 删除
- 第 1063 行 `const prevStatusRef = useRef<AgentStatus>("idle");` —— 删除
- 第 1068-1074 行 (unmount 清理 effect) —— 删除
- 第 1097 行 (slash 相关 state + ref) —— 删除
- 第 1115-1127 行 (ResizeObserver sessionListRef effect) —— **不删** (这是侧栏的, 不是 input)
- 第 1129-1152 行 (streaming timer + spinTimer effect) —— **不删** (Agent 仍需要 elapsed/spinner)
- 第 1158-1164 行 (refocus effect) —— 删除
- 第 1198-1206 行 (slash fetch effect) —— 删除

每次删除前用 grep 确认这些变量名只在这一处被声明、没被 Agent 别处用到:

```bash
cd /Users/ethan/code/opencc-web/packages/zai && grep -n "setInput\b\|setAttachments\b\|fileInputRef\b\|textareaRef\b\|prevStatusRef\b\|slashItems\b\|showSkillMenu\b\|skillMenuIdx\b\|skillFilter\b\|skillMenuRef\b\|textAreaRef\b" src/web/src/pages/Agent.tsx
```

预期: 只在 Agent.tsx 内部使用 (没有别的文件 import Agent 的内部), 这些声明删除后其它引用也就剩 `AgentInputBox` 内。

- [ ] **Step 3: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: TS 错误会指向 Agent.tsx 残留引用 (例如 `setInput` 还被 handleSend 用)。先继续下一步搬迁, 全部 task 完成后再 typecheck。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): move input state out of Agent into AgentInputBox"
```

---

## Task 3: 把 slash 过滤与菜单 effect 搬迁

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1209-1281`

**Interfaces:**
- Produces: `AgentInputBox` 暴露内部 `filteredSlash` (useMemo) + `setSkillMenuIdx` / `setShowSkillMenu` / 点击外部关闭 effect。

- [ ] **Step 1: 把 fuzzyMatch + filteredSlash useMemo 搬到 AgentInputBox**

在 `AgentInputBox` (Step 2 骨架后) 添加:

```tsx
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
```

- [ ] **Step 2: 从 Agent.tsx 删除对应代码**

删除 Agent.tsx 中:
- `fuzzyMatch` 函数定义 (约 1209-1225 行)
- `filteredSlash` useMemo (约 1228-1260 行)
- `setSkillMenuIdx` 重置 effect (约 1263-1266 行)
- 外部点击关闭 effect (约 1269-1281 行)

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): move slash menu filtering into AgentInputBox"
```

---

## Task 4: 把 selectSlashItem + 附件操作 + 键盘/粘贴/drop 处理器搬迁

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1283-1334,1336-1417,1546-1588`

**Interfaces:**
- Produces: `AgentInputBox` 暴露 `selectSlashItem` (useCallback) + `addAttachments` / `removeAttachment` / `handlePaste` / `handleDrop` / `handleFilePick` (内部函数) + `handleKeyDown` (依赖本地 input / showSkillMenu / filteredSlash)。

- [ ] **Step 1: 把 handler 全部搬迁到 AgentInputBox (顶部加 import)**

在 `AgentInputBox.tsx` 顶部 import 区 (Step 1 已有的 `antd` import 旁) 加 `import { message } from "antd";`, 然后在 `AgentInputBox` 末尾 (filteredSlash useMemo 后) 依次添加以下函数 (用 `useCallback` 包), 注意把对 `setInput` / `attachments` / `showSkillMenu` / `setSkillMenuIdx` / `textareaRef` 的引用都改成闭包内的本地版本:

```tsx
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
```

- [ ] **Step 2: 把 handleKeyDown (slash 导航部分) 搬到 AgentInputBox**

```tsx
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
    // 纯 Enter 发送逻辑 — handleSend 留在 Step 5
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 由 Step 5 注入 handleSend
    }
  };
```

- [ ] **Step 3: 从 Agent.tsx 删除 selectSlashItem / addAttachments / removeAttachment / handlePaste / handleDrop / handleFilePick / handleKeyDown**

删除 Agent.tsx 中:
- `selectSlashItem` useCallback (约 1283-1334 行)
- `addAttachments` 函数 (约 1339-1375 行)
- `removeAttachment` 函数 (约 1377-1383 行)
- `handlePaste` 函数 (约 1385-1396 行)
- `handleDrop` 函数 (约 1398-1410 行)
- `handleFilePick` 函数 (约 1412-1417 行)
- `handleKeyDown` 函数 (约 1546-1588 行) — 整体删除

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): move input handlers into AgentInputBox"
```

---

## Task 5: 把 send / postPromptToLLM 搬迁到 AgentInputBox

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:301-306,1419-1444,1446-1542`

**Interfaces:**
- Produces: `AgentInputBox` 暴露 `postPromptToLLM` (useCallback) + `handleSend` (依赖本地 input / attachments / status / sessionId / activeSessionId / pendingAsk)。
- 消费: `useAgentStore` 透传 `clearMessages` / `loadSessions` / `applySessionEvent` 等通过 `getState()` 调用的方法 — 保持原写法, 不需要 selector。

- [ ] **Step 1: 搬迁 postPromptToLLM**

在 `AgentInputBox` 末尾 (handler 后) 添加:

```tsx
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
```

并把 `deriveLocalTitle` 函数 (`Agent.tsx:301-306`) 从 Agent.tsx 删除, 复制到 `AgentInputBox.tsx` 顶部 (在 `MAX_ATTACHMENTS_PER_TURN` 常量之后):

```tsx
const TITLE_MAX_LEN = 50;
function deriveLocalTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return "";
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine;
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + "…";
}
```

- [ ] **Step 2: 搬迁 handleSend**

```tsx
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
```

最后, 把 Step 2.handleKeyDown 里 `// 由 Step 5 注入 handleSend` 注释替换为 `handleSend();`, 并在依赖数组补 `handleSend`。

- [ ] **Step 3: 从 Agent.tsx 删除 handleSend / postPromptToLLM / deriveLocalTitle**

- 删除 `Agent.tsx:1419-1444` postPromptToLLM
- 删除 `Agent.tsx:1446-1542` handleSend
- 删除 `Agent.tsx:301-306` deriveLocalTitle

- [ ] **Step 4: 从 Agent.tsx 移除 `PendingAttachment` / `SlashItem` 类型定义** (如果 Agent.tsx 内有)

```bash
cd /Users/ethan/code/opencc-web/packages/zai && grep -n "PendingAttachment\|SlashItem" src/web/src/pages/Agent.tsx
```

预期: Agent.tsx 已不再引用 (因为 handleSend / slash menu 全搬走了)。如果有残留, 删除。

- [ ] **Step 5: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过。

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): move send + prompt post into AgentInputBox"
```

---

## Task 6: 把 TextArea 与 slash 下拉 JSX 搬到 AgentInputBox

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1889-2095`

**Interfaces:**
- Produces: `AgentInputBox` 渲染 status bar 上方的输入区: `<div onDrop onDragOver>` 包裹 + `<TextArea>` + slash dropdown + 文件 input + 图片附件 `<AttachmentStrip>` (在 `attachments.length > 0` 时)。**注意**: 原 `AttachmentStrip` 内嵌在 status bar 一行 (Agent.tsx:1941-1949), 那是 input 的附件缩略图, 应一并搬到 AgentInputBox (保留在 status bar 上方、紧贴 TextArea)。

- [ ] **Step 1: 把整个 status bar + TextArea 区段搬到 AgentInputBox**

**保留原 UI 布局**: TextArea 上方一行 status bar (cwd / 模型 / streaming 指示 / `esc 中断` + 附件缩略图内嵌 + spacer + 上传图片按钮 + permission mode button), status bar 下方 TextArea + slash dropdown。

替换 `AgentInputBox` 的 return 为:

```tsx
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
```

- [ ] **Step 2: Agent.tsx 删除原 status bar 内的 AttachmentStrip + file input + 整个 TextArea 区段**

- 删除 `Agent.tsx:1941-1949` (status bar 内的 AttachmentStrip) — 它搬到了 AgentInputBox
- 删除 `Agent.tsx:1962-1969` (file input) — 搬到了 AgentInputBox
- 删除 `Agent.tsx:1972-2095` 整段 (`<div onDrop onDragOver>` + slash dropdown + TextArea) — 用 `<AgentInputBox />` 替代

- [ ] **Step 3: 在 Agent.tsx 主 JSX 替换为 `<AgentInputBox />`**

打开 `Agent.tsx`, 找到 `<div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>` 这块 JSX (Task 6.Step 2 删掉的区段), 替换为:

```tsx
<AgentInputBox />
```

并确保 `import AgentInputBox from "../components/AgentInputBox";` 仍在文件顶部。

- [ ] **Step 4: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): render AgentInputBox in place of inline TextArea JSX"
```

---

## Task 7: Agent 主组件改用细粒度 zustand selector (M2)

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1025-1051`

**Interfaces:**
- Produces: `Agent` 内 20 个独立 `useAgentStore(s => s.x)` 调用取代原 destructure。

- [ ] **Step 1: 替换 destructure 为细粒度 selector**

打开 `packages/zai/src/web/src/pages/Agent.tsx`, 找到:

```tsx
  const {
    messages,
    status,
    cwd,
    sessions,
    sessionId,
    todosBySession,
    activeSessionId,
    stop,
    clearMessages,
    loadSessions,
    setCurrentSession,
    loadTranscript,
    createNewSession,
    deleteSession,
    pendingAsk,
    setAskAnswer,
    setAskNotes,
    submitAsk,
    rejectAsk,
  } = useAgentStore();
```

替换为:

```tsx
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
```

保留下面已有的 `patchSessionMode` selector (Agent.tsx:1049) 不动。

注意 `todosForCurrentSession` 这块 (Agent.tsx:1047-1048) 保持原样:

```tsx
  const todosForCurrentSession: TodoItem[] =
    sessionId != null ? (todosBySession[sessionId] ?? []) : [];
```

- [ ] **Step 2: AgentInputBox 的 handleKeyDown 加 Shift+Tab mode cycle**

Agent.tsx 中原 handleKeyDown 已删除 (Step 4)。Shift+Tab cycle permission mode 的逻辑需要保留, 但它依赖 TextArea 获得焦点 — 搬回 AgentInputBox 的 handleKeyDown:

打开 `packages/zai/src/web/src/components/AgentInputBox.tsx`, 顶部 import 区追加:

```tsx
import { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
```

(从 `../components/ModeStatusButton` 取, 与 Agent.tsx 原来 import 路径一致)

在 `handleKeyDown` 的 `// 由 Step 5 注入 handleSend` 注释块之前添加:

```tsx
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
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): use fine-grained zustand selectors in Agent"
```

---

## Task 8: 给消息相关组件加 React.memo (M3)

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:232,257,313,527,766`
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`

**Interfaces:**
- Produces: `MessageBubble` / `MarkdownText` / `StreamingMarkdown` / `ThinkingBlock` / `ToolCallBlock` / `AgentInputBox` 全部包成 `React.memo`。

- [ ] **Step 1: 改 MarkdownText 声明**

打开 `packages/zai/src/web/src/pages/Agent.tsx`, 找到:

```tsx
function MarkdownText({ text }: { text: string }) {
```

替换为:

```tsx
const MarkdownText = React.memo(function MarkdownText({ text }: { text: string }) {
```

并把函数结尾的 `}` 改为 `});` — 注意末尾 `}` 已经是函数声明结束, 改成 `});` 即可。

- [ ] **Step 2: 改 StreamingMarkdown**

```tsx
function StreamingMarkdown({ text }: { text: string }) {
```

→

```tsx
const StreamingMarkdown = React.memo(function StreamingMarkdown({ text }: { text: string }) {
```

末尾 `}` → `});`。

- [ ] **Step 3: 改 ThinkingBlock**

```tsx
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
```

→

```tsx
const ThinkingBlock = React.memo(function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
```

末尾 `}` → `});`。

- [ ] **Step 4: 改 ToolCallBlock**

```tsx
function ToolCallBlock({ msg }: { msg: AgentMessage }) {
```

→

```tsx
const ToolCallBlock = React.memo(function ToolCallBlock({ msg }: { msg: AgentMessage }) {
```

末尾 `}` → `});`。

- [ ] **Step 5: 改 MessageBubble**

```tsx
function MessageBubble({
  msg,
  streaming,
}: {
  msg: AgentMessage;
  streaming: boolean;
}) {
```

→

```tsx
const MessageBubble = React.memo(function MessageBubble({
  msg,
  streaming,
}: {
  msg: AgentMessage;
  streaming: boolean;
}) {
```

末尾 `}` → `});`。

- [ ] **Step 6: 给 AgentInputBox 也包 React.memo**

打开 `packages/zai/src/web/src/components/AgentInputBox.tsx`, 改 import:

```tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
```

(把 `React` 也 import 进来, 因为 `React.memo` 需要它), 然后把 `export default function AgentInputBox() {` 改为:

```tsx
export default React.memo(function AgentInputBox() {
```

并把文件最末尾的 `}` 改为 `});`。

- [ ] **Step 7: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过。

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "perf(zai-web): memo MessageBubble, MarkdownText, ThinkingBlock, ToolCallBlock, AgentInputBox"
```

---

## Task 9: messages.map 用 useMemo 缓存 (M4)

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1852-1872`

**Interfaces:**
- Produces: `messageList` useMemo, JSX 里 `messages.map(...)` 替换为 `{messageList}`。

- [ ] **Step 1: 在 `Agent` 主体里加 useMemo**

打开 `packages/zai/src/web/src/pages/Agent.tsx`, 在 `messages.map(...)` JSX 调用上方 (大约 1852 行附近, 在 TodoZone 后) 加:

```tsx
  const messageList = useMemo(
    () =>
      messages.map((msg: AgentMessage, idx: number) => {
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
            streaming={
              status === "streaming" && idx === messages.length - 1
            }
          />
        );
      }),
    [messages, status],
  );
```

- [ ] **Step 2: JSX 里替换 `messages.map`**

把:

```tsx
{messages.map((msg: AgentMessage, idx: number) => {
  /* … */
})}
```

替换为:

```tsx
{messageList}
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```

预期: 通过。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "perf(zai-web): memoize messages.map result"
```

---

## Task 10: 性能验收 (实测回归)

**Files:** 无 (验证任务)

**Interfaces:** 不适用。

- [ ] **Step 1: 启动 dev server**

```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm dev --no-open
```

预期: Vite 启动, API + Web 端口可用。日志里能看见 `VITE vX ready in N ms` 与 `Local: http://localhost:...`。

- [ ] **Step 2: 用 chrome-devtools 打开 Agent 页面**

通过 `mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page` 打开 `http://localhost:<port>/agent`, 等待 transcript 加载完成。

- [ ] **Step 3: 装 hook + 跑实测**

通过 `mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script` 注入以下脚本:

```js
async () => {
  window.__zaiAllCommits = [];
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  hook.onCommitFiberRoot = (renderer, root) => {
    const rendered = [];
    const walk = (fiber) => {
      if (!fiber) return;
      const t = fiber.type;
      if (typeof t === 'function' && fiber.alternate) {
        const cur = fiber.memoizedProps;
        const prev = fiber.alternate.memoizedProps;
        const curState = fiber.memoizedState;
        const prevState = fiber.alternate.memoizedState;
        const sh = (a, b) => {
          if (a === b) return true;
          if (!a || !b) return false;
          const ka = Object.keys(a), kb = Object.keys(b);
          if (ka.length !== kb.length) return false;
          for (const k of ka) if (a[k] !== b[k]) return false;
          return true;
        };
        const shs = (a, b) => {
          if (a === b) return true;
          let n1 = a, n2 = b, idx = 0;
          while (n1 && n2 && idx < 50) {
            if (n1.memoizedState !== n2.memoizedState) return false;
            n1 = n1.next; n2 = n2.next; idx++;
          }
          return !n1 && !n2;
        };
        if (!sh(cur, prev) || !shs(curState, prevState)) {
          rendered.push(t.displayName || t.name || 'Anon');
        }
      }
      walk(fiber.child);
      walk(fiber.sibling);
    };
    walk(root.current);
    window.__zaiAllCommits.push(rendered);
  };

  const ta = document.querySelector('textarea.zai-agent-textarea') || document.querySelector('textarea');
  ta.focus();
  await new Promise(r => setTimeout(r, 100));
  window.__zaiAllCommits.length = 0;

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const t0 = performance.now();
  setter.call(ta, ta.value + 'x');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => {
    const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
    ric(() => r());
  });
  const dt = performance.now() - t0;

  const tally = {};
  for (const c of window.__zaiAllCommits) for (const n of c) tally[n] = (tally[n] || 0) + 1;
  return {
    ms: Math.round(dt),
    commitCount: window.__zaiAllCommits.length,
    top: Object.entries(tally).sort((a,b) => b[1]-a[1]).slice(0, 20),
  };
}
```

- [ ] **Step 4: 通过验收 — 性能 (perf)**

预期结果 (修复后):

```js
{
  ms: ≤ 60,
  commitCount: 1,
  top: [
    ['AgentInputBox', 1],       // 或内部 antd TextArea 等
    ['TextArea', 1],            // 等
    // 不应包含: MessageBubble, Markdown, ThinkingBlock, ToolCallBlock, SyntaxHighlighter, DomWrapper, EllipsisTooltip
  ]
}
```

若 `top` 里仍包含 `MessageBubble` / `Markdown` / `ThinkingBlock` / `ToolCallBlock` / `SyntaxHighlighter` 任一项, **或** `ms > 60`, **或** `commitCount > 2`, 任务失败, 回溯检查 M1-M4 哪一项没生效。

- [ ] **Step 4b: 功能回归 — 真实交互 (functional)**

用 chrome-devtools 的人工交互脚本 (通过 `take_snapshot` 拿 uid → `click` / `fill` / `press_key`):

1. **输入文字**: 在 TextArea 内填 "hello regression test" — 文本应出现在 TextArea 中, transcript 不变。
2. **Enter 发送**: 按 Enter — TextArea 清空, transcript 末尾出现新 user.text 气泡。
3. **Shift+Enter 换行**: 重新填入 "line1" 按 Shift+Enter 再填 "line2" — TextArea 内容应包含两行换行。
4. **粘贴图片**: 触发粘贴事件 (用 `evaluate_script` 注入 base64 PNG + `dispatchEvent(new ClipboardEvent('paste', { clipboardData }))`) — AttachmentStrip 出现缩略图, 状态切到 "ready"。
5. **拖拽图片**: 同样通过 `dispatchEvent(new DragEvent('drop', { dataTransfer }))` 模拟。
6. **`/` 触发 slash 菜单**: 填 "/" — 下拉菜单出现, 列项与 `/api/slash` 返回一致。
7. **Slash 选择**: 用 ArrowDown 移动选中, Enter 触发 — 行为与原 Agent 一致 (local command 直接执行, prompt/skill 填入输入框)。
8. **会话切换**: 点侧栏某条历史会话 (用 `take_snapshot` 拿 uid → `click`) — `messages` 应加载对应 transcript。
9. **permission mode cycle**: 在 TextArea 焦点下按 Shift+Tab — mode 按钮的 `MODE_CYCLE_ORDER` 顺序循环。

任一步失败 → 回溯对应 Task 重新审视实现。

- [ ] **Step 5: 关闭 dev server**

通过 chrome-devtools 关闭页面, 然后 `pkill -f "zai/src/cli/index.ts dev"` 停服务。

- [ ] **Step 6: 不需要单独 commit** (本任务纯验证)

---

## Self-Review

**1. Spec coverage**:
- §1.M1 (拆 AgentInputBox) → Task 1-6 ✅
- §1.M2 (细粒度 selector) → Task 7 ✅
- §1.M3 (5 个 React.memo) → Task 8 ✅
- §1.M4 (useMemo messages.map) → Task 9 ✅
- §3.1 功能不变 → Task 10 实测 ✅
- §3.2 性能验收 ≤60ms → Task 10 ✅

**2. Placeholder scan**: 无 "TBD" / "TODO" / "类似 Task N"; 每步都有具体代码或命令。

**3. Type consistency**:
- `PendingAttachment` 类型只在 AgentInputBox 定义, Agent.tsx 删除 ✅
- `SlashItem` 类型只在 AgentInputBox 定义, Agent.tsx 删除 ✅
- `deriveLocalTitle` 从 Agent.tsx 搬到 AgentInputBox.tsx, 唯一实现 ✅
- `MODE_CYCLE_ORDER` 从 Agent.tsx 移到 AgentInputBox (Task 7 Step 2) ✅
- `useAgentStore` selector 字段名与 store 类型完全一致 (msg-by-msg 对照 spec §1.M2 表) ✅

**4. 风险点**: Task 7 Step 2 (Shift+Tab mode cycle 搬家) 用了 `useAgentStore.getState()` 兜底, 不引入新订阅, 与 spec §4 "拆分后组件通信" 风险分析一致。

**5. 顺序性**: Task 1-6 是 M1 拆分 (搬迁), 每步可独立 commit 互不破坏 (因为每步都先 add 后 delete, 编译能保持中间态), 但 typecheck 可能在中间步骤失败 (Step 3 验证编译); 这是预期的, 直到 Task 5 完成后才整体通过。Task 7-9 独立施加 M2/M3/M4, 每步 commit 后 typecheck 通过。Task 10 验证全部。