import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { Input, Button, message, Popover, Tooltip } from "antd";
import {
  PictureOutlined,
  ToolOutlined,
  CompressOutlined,
  ExpandOutlined,
  ShareAltOutlined,
  StopOutlined,
  AppstoreAddOutlined,
  CloseOutlined,
  PlusOutlined,
  EditOutlined,
  ArrowUpOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import { useSplitPaneCompactLock } from "../hooks/useSplitPaneCompactLock.js";
import { useSubmitPrompt } from "../hooks/useSubmitPrompt.js";
import {
  useAgentStoreOrCtx,
  useAgentStoreOrCtxApi,
  type AgentMessage,
} from "../store/useAgentStore";
import type { V2TaskItem, QueuedPrompt } from "../store/useAgentStore.js";
import { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
import { useAppStore } from "../store/useAppStore";
import { useDesktopAttachmentStore } from "../store/desktopAttachmentStore";
import type { FsSearchEntry } from "../../../shared/fs.js";
import { api } from "../lib/api";
import { AttachmentStrip } from "../components/AttachmentStrip";
import ConversationInfoButton from "../components/ConversationInfoButton";
import SettingsButton from './SettingsButton'
import PluginButton from './PluginButton'
import SharePopover from "./SharePopover.js";
import { toolbarIconButtonStyle, TOOLBAR_ACTIVE_COLOR } from "./toolbarStyles.js";
import TodoDropdown from "./TodoDropdown.js";
import QuickCommandPopover from "./QuickCommandPopover.js";
import type { SlashItem } from "./quickCommandTypes.js";
import { readImageAsBase64, ImageReadError } from "../lib/imageReader";
import {
  AGENT_INPUT_INSERT_EVENT,
  type AgentInputInsertDetail,
} from "../lib/agentInputEvents";
import { activeAtToken, formatFileMention } from "./mentionGrammar.js";
import { useFsMentionSearch } from "./useFsMentionSearch.js";
import FileMentionPopover from "./FileMentionPopover.js";
import MentionChip from "./MentionChip.js";
import {
  InputMachine,
  PLACEHOLDER,
  projectClipboard,
} from "./input/inputMachine.js";
import type { InputReference } from "./input/inputMachine.js";
import { deriveChipDecorations } from "./input/decorations.js";
import type { ChipDecoration } from "./input/decorations.js";

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

/**
 * Mirror-layer 高亮的纯函数 core(参考 deepseek-harness
 * `client/ui-conversation/src/client/input/decorations.ts` 的派生思路):
 * 输入文本以 `/` 起首且后续 name 是已知 slashItems 之一时,返回 `/name`
 * 的高亮范围(不含尾部空格 — 与 dsh 行为一致)。否则 null。
 *
 * 仅识别"输入开头"的命令 token(贴齐 claim-token 语义),中段出现的
 * `/name` 不参与高亮 — 这是约定而非漏判,防止误把普通文本里偶然出现的
 * "/foo" 渲染成命令样式。
 */
export function deriveCommandToken(
  input: string,
  slashItems: readonly SlashItem[],
): { start: number; end: number; name: string } | null {
  if (!input.startsWith("/")) return null;
  // 提取 `/` 之后到第一个空白/换行前的连续字符作为命令名
  const m = /^\/([A-Za-z0-9_-]+)/.exec(input);
  if (!m) return null;
  const name = m[1] ?? "";
  if (name.length === 0) return null;
  const known = slashItems.some((it) => it.name === name);
  if (!known) return null;
  return { start: 0, end: 1 + name.length, name };
}

/**
 * AgentInputBox 直接从 useAppStore.isMobile 读取移动端判断, 不再接受 props.
 * 由 useIsMobile() (挂在 Layout 顶部) 通过 matchMedia 同步到 store.
 */

/**
 * backdrop 渲染辅助(追齐 deepseek-harness InputBar 的 decoration 手法):
 * 把 draft 切成「普通文本 / chip / token-mark」三段,按 offset 升序渲染。
 * 三种装饰源:
 * - chips:occurrence 表派生(U+FFFC 占位符处渲染 MentionChip)
 * - commandToken:leading `/命令` 的高亮 mark
 * - atToken:光标处仍活跃的 `@` token(用户正在敲,染紫)
 * 由于 chip 只占 1 字符(占位符),文本与 chip 之间天然对齐,不再需要旧的
 * hidden-placeholder 宽度对位。
 */
function renderDraftDecorations(
  draft: string,
  chips: readonly ChipDecoration[],
  commandToken: { start: number; end: number } | null,
  atToken: { start: number; end: number; prefix: string } | null,
) {
  const result: React.ReactNode[] = [];
  type Instr =
    | { at: number; stop: number; kind: "chip"; d: ChipDecoration }
    | { at: number; stop: number; kind: "mark"; prefix: string };
  const instructions: Instr[] = [];
  for (const c of chips) {
    instructions.push({ at: c.offset, stop: c.offset + 1, kind: "chip", d: c });
  }
  if (commandToken) {
    instructions.push({
      at: commandToken.start,
      stop: commandToken.end,
      kind: "mark",
      prefix: draft.slice(commandToken.start, commandToken.end),
    });
  }
  if (atToken) {
    instructions.push({ at: atToken.start, stop: atToken.end, kind: "mark", prefix: atToken.prefix });
  }
  instructions.sort((a, b) => a.at - b.at);
  let pos = 0;
  for (const ins of instructions) {
    if (ins.at < pos) continue;
    if (ins.at > pos) {
      result.push(<span key={`t-${pos}`}>{draft.slice(pos, ins.at)}</span>);
    }
    if (ins.kind === "chip") {
      result.push(
        <MentionChip
          key={`oc-${ins.d.occurrenceId}`}
          data={{ path: ins.d.path, label: ins.d.label, invalid: ins.d.invalid }}
          onMouseDown={(e) => {
            // 阻止焦点离开 textarea(combobox 模式:点击 chip 不丢光标)
            e.preventDefault();
          }}
        />,
      );
    } else {
      result.push(
        <span
          key={`m-${ins.at}`}
          data-decoration="token-mark"
          className="agent-input-cmd-token"
        >
          {ins.prefix}
        </span>,
      );
    }
    pos = ins.stop;
  }
  if (pos < draft.length) {
    result.push(<span key="t-end">{draft.slice(pos)}</span>);
  }
  return result;
}

/**
 * 工具栏定制项 — AgentConversation 被 /agent、/m、/desktop 等多场景复用,
 * 场景专属按钮(如分屏 toggle)不再内置,改由调用方通过插槽注入。
 * 详见 AgentConversation.tsx 顶部注释。
 */
export interface AgentInputBoxProps {
  /** 状态行最左侧插槽(● 状态指示之前) */
  toolbarLeftSlot?: ReactNode;
  /** 状态行最右侧插槽(行尾最后一个元素) */
  toolbarRightSlot?: ReactNode;
  /** 修复 transcript 按钮(扳手图标)。调试性质入口,默认不渲染;
   *  /agent 页面显式开启。 */
  showTranscriptRepair?: boolean;
}

export default React.memo(function AgentInputBox({
  toolbarLeftSlot,
  toolbarRightSlot,
  showTranscriptRepair = false,
}: AgentInputBoxProps = {}) {
  const status = useAgentStoreOrCtx((s) => s.status);
  const sessionId = useAgentStoreOrCtx((s) => s.sessionId);
  // zai race fix: createNewSession 异步窗口(~50–200ms)期间禁用 Send + 短路 Enter。
  // 见 useAgentStore.createNewSession 注释。
  const creatingSession = useAgentStoreOrCtx((s) => s.creatingSession);
  const activeSessionId = useAgentStoreOrCtx((s) => s.activeSessionId);
  const isMobile = useAppStore((s) => s.isMobile);
  // dsh 连接状态指示 (2026-08-15): SSE 断流时显示"重连中…/连接已断开",
  // 恢复后自动消失。connected/connecting 不显示 — 连接正常时保持状态行整洁。
  const streamState = useAppStore((s) => s.streamState);
  const streamAttempt = useAppStore((s) => s.streamAttempt);
  const pendingAsk = useAgentStoreOrCtx((s) => s.pendingAsk);
  // 排队中的 prompt(对话进行中提交, 后端串行队列等待执行) — 渲染在输入框
  // 上方排队预览区; 某条开始执行时由 watcher 移入 transcript。
  const queuedPrompts = useAgentStoreOrCtx((s) => s.queuedPrompts);
  // 任务摘要: 从 store 取当前 session 的 v2 tasks 统计 N/M 任务.
  // 修复: 任务摘要从独立 BottomStatusBar 行合并到状态行, 让 UI 更紧凑.
  // 取 store 字段而非 props — AgentInputBox 是叶子组件, 让 store selector
  // 自动追踪 sid 变化, 避免父组件多传一组 props.
  // 2026-07-31: 老 TODO (todosBySession) 已被 refactor 删除, 全部走 v2 task tools.
  const v2Tasks: V2TaskItem[] = useAgentStoreOrCtx((s) =>
    s.sessionId ? s.v2TasksBySession[s.sessionId] ?? [] : []
  );
  // 单一布尔 transcriptCollapsed:Layout hydrate 时根据 settings.outputStyle
  // 把初始值定为 (compact === true),用户点工具栏按钮 → 直接翻转.
  // 这里 *不* 重新计算 visuallyCollapsed — transcriptCollapsed 本身就是
  // 当前视觉折叠态,刷新时回到 Layout hydrate 后的值(由 settings 决定).
  const transcriptCollapsed = useAgentStoreOrCtx((s) => s.transcriptCollapsed);
  const setTranscriptCollapsed = useAgentStoreOrCtx((s) => s.setTranscriptCollapsed);
  // 分屏开启时锁住 transcript-collapsed 折叠按钮 — hook 内 effect 会立刻把
  // transcriptCollapsed 设为 true, 然后整个按钮 + Tooltip 不挂载, 让 "分屏
  // 模式下不可切换"的契约在 DOM 层一次性落实.
  const { isLocked: transcriptLockActive } = useSplitPaneCompactLock();
  // outputStyle 仅用于 tooltip 文案:让用户知道 settings 是 compact,
  // 刷新后会回到当前这个工具栏按钮点击后的反向设置.
  const outputStyle = useAppStore((s) => s.outputStyle);
  // 任务摘要: 只统计完成数与总数, 不再展示"进行中"/"待开始"分项 — 状态行更紧凑,
  // 用户需要看分项时点摘要 → 弹出 TodoDropdown 详细列表.
  const totalTasks = v2Tasks.length;
  const doneTasks = v2Tasks.filter((t) => t.status === "completed").length;

  // Context-aware store api(2026-09-02):AgentInputBox 可能在 NewSuperTaskModal
  // 等 Provider 包裹下渲染,这里走 useAgentStoreOrCtxApi() 拿当前 store 实例,
  // 让所有事件 handler(clearMessages / patchSessionMode / setState / stop 等)
  // 走与组件 selector 一致的 store,而不是硬编码全局 useAgentStore 单例。
  // 注意:必须在组件顶层调用一次,closure 到 handler 中复用 —— 不能在
  // handler 内现取(useAgentStoreOrCtxApi 内部 useContext,违反 Rules of Hooks)。
  const storeApi = useAgentStoreOrCtxApi();

  // 输入状态机(zai 版 deepseek-harness InputMachine):draft + occurrence
  // 表 + 事务 undo/redo 的权威源。React 只读镜像(render 时读 machine.state),
  // 所有 mutation 走 machine.dispatch / insertTextAt,再 forceRender。
  const machineRef = useRef<InputMachine | null>(null);
  if (machineRef.current === null) machineRef.current = new InputMachine();
  const [, setTick] = useState(0);
  const forceRender = useCallback(() => setTick((t) => t + 1), []);
  const input = machineRef.current.state.draft;
  const machineChips = deriveChipDecorations(machineRef.current.state);
  // 光标位置(activeAtToken 需要这个来定位 @-token,textarea selectionStart 不
  // 在 React state 里;需要在 onChange/onKeyUp/onClick 里同步刷新。
  // 初始值 0 + input 变化时由 onChange 重写,只为减少首挂载误判。
  const [cursor, setCursor] = useState(0);
  // machine 权威变更入口:以「完整新 draft」喂给状态机(diff 由机器恢复),
  // 触发重渲;editRange 可省(机器内部 diff)。
  const commitDraft = useCallback((next: string) => {
    machineRef.current?.dispatch({ type: "draft-changed", draft: next });
    forceRender();
  }, [forceRender]);

  // ---- auto-grow + caret reveal(mirror 是高度权威) ----
  // 与 deepseek-harness InputBar 同款:镜像层以同样的 metrics/wrap 渲染
  // draft,决定 .grow 高度;scroll 是唯一滚动容器。光标 reveal 用 mirror
  // 上的 Range 度量(浏览器对 textarea 自己的 reveal 会滚动到对话层)。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const revealCaret = useCallback((caret: number) => {
    const scrollEl = scrollRef.current;
    const mirrorEl = mirrorRef.current;
    const text = mirrorEl?.firstChild;
    if (scrollEl === null || mirrorEl === null || !(text instanceof Text)) return;
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return;
    const at = Math.min(caret, text.data.length);
    const afterNewline = at > 0 && text.data[at - 1] === "\n";
    const range = document.createRange();
    range.setStart(text, afterNewline ? at - 1 : at);
    if (afterNewline) range.setEnd(text, at);
    else range.collapse(true);
    const line = afterNewline
      ? Number.parseFloat(getComputedStyle(mirrorEl).lineHeight) || 0
      : 0;
    const rect = range.getBoundingClientRect();
    const box = scrollEl.getBoundingClientRect();
    if (rect.bottom + line > box.bottom) {
      scrollEl.scrollTop += rect.bottom + line - box.bottom;
    } else if (rect.top + line < box.top) {
      scrollEl.scrollTop -= box.top - rect.top - line;
    }
  }, []);
  // 输入/光标变化后小步 reveal(不滚动时会话层;rea 光标可见)。
  const revealAfterEdit = useCallback((caret: number) => {
    requestAnimationFrame(() => revealCaret(caret));
  }, [revealCaret]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  // 排队消息编辑态: editingQueuedId 非空 → 该行切换为内联编辑框。
  // 编辑只改排队文本(后端 /agent/queue/edit 原位替换, id 与队列位置不变)。
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedText, setEditingQueuedText] = useState("");
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

  // 命令高亮: 输入开头 `/<已知命令>` 时在输入框内把 token 染紫底,
  // 视觉与下方 slash 自动补全 dropdown 的 `/name` 紫色块对齐,
  // 让用户在敲 Tab/Enter 之前就能确认"我现在用的是什么命令"。
  // mirror-backdrop 渲染: backdrop 与 textarea 共用 antd 的 padding/font
  // metrics,前者渲染可见文本(带 mark),后者 text-fill-color 透明
  // 只保留 caret/selection — 见下方 <div data-input-backdrop> 与
  // TextArea styles.textarea.color:"transparent"。
  // 必须在 slashItems state 之后:slashItems 初始为 [],首挂载到 fetch
  // 返回前不会有高亮;fetch 完成后 useMemo 重算,用户输入框里的高亮随之刷新。
  const commandToken = useMemo(
    () => deriveCommandToken(input, slashItems),
    [input, slashItems],
  );

  // 已完成 @-mention 扫描 + 维护:见下方 "showSkillMenu 之后的 @-mention 块"
  // (需要 atToken 互斥门控,先声明 atToken)。

  // 在光标处插入文本(分屏「插入对话」与拖入文件地址共用):
  // rc-textarea(antd Input.TextArea)把 ref 变成命令式句柄
  // { resizableTextArea: { textArea } },需要解码到原生 <textarea>
  // 才能读 selection / 设光标。插入后聚焦并把光标移到文本末尾。
  // happy-dom 等环境可能不实现 textarea selection API(selectionStart 为
  // undefined),归一化后退化为「追加到末尾」,避免 slice(0, undefined)
  // 把整段文本重复插入。
  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    const valLen = ta?.value.length ?? 0;
    const rawStart = ta ? ta.selectionStart : 0;
    const rawEnd = ta ? ta.selectionEnd : rawStart;
    const start = Number.isFinite(rawStart) ? rawStart : valLen;
    const end = Number.isFinite(rawEnd) ? rawEnd : start;
    // 完整事务语义:外部纯文本插入(替换选区/光标处)走机器 insertTextAt
    if (end === start) {
      machineRef.current?.insertTextAt(text, start);
    } else {
      const next =
        machineRef.current!.state.draft.slice(0, start) +
        text +
        machineRef.current!.state.draft.slice(end);
      machineRef.current?.dispatch({ type: "draft-changed", draft: next });
      // U+FFFC 出现在被替换区间内时 reconcile 已清理对应 occurrence
    }
    forceRender();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = start + text.length;
      // happy-dom 未实现 setSelectionRange(测试环境),退回标准 selectionStart/
      // selectionEnd 属性赋值,两者在真实浏览器均有等价效果。
      if (typeof el.setSelectionRange === "function") {
        el.setSelectionRange(pos, pos);
      } else {
        el.selectionStart = pos;
        el.selectionEnd = pos;
      }
    });
  }, [forceRender]);

  // 分屏文件管理「插入对话」→ 光标处插入 @"文件" 引用 chip(与 @ 菜单选择
  // 文件同一形态)。FsContextMenu dispatch agent-input-insert 事件,detail
  // 带 path 与 kind;插入后聚焦并把光标移到 chip 之后便于继续打字。
  // U+FFFC 占位 + occurrence 是机器的事务(chip 参与 undo/backspace 整删),
  // 发送时由 projectClipboard 展开回 @path。
  const insertFileReferenceAtCaret = useCallback((text: string, kind?: 'file' | 'dir') => {
    const ta = textareaRef.current;
    const valLen = ta?.value.length ?? 0;
    const rawStart = ta ? ta.selectionStart : 0;
    const rawEnd = ta ? ta.selectionEnd : rawStart;
    const start = Number.isFinite(rawStart) ? rawStart : valLen;
    const end = Number.isFinite(rawEnd) ? rawEnd : start;
    const machine = machineRef.current;
    if (!machine) return;
    // 有选区时先删除选区(consume-span 事务),再在光标处插入 chip
    if (end !== start) {
      machine.dispatch({
        type: "consume-span",
        span: { start, end, draftRev: machine.state.draftRev },
      });
    }
    const refPath = kind === "dir" && !text.endsWith("/") ? `${text}/` : text;
    const reference: InputReference = {
      source: "fs",
      ref: refPath,
      label: refPath.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? refPath,
      clipboardText: `@${refPath}`,
    };
    const before = machine.state.draft;
    machine.insertReferenceAt(reference, start);
    forceRender();
    // 新光标 = start + 前导空格(如在文字中间补的分隔) + 占位符(1) + 尾随空格
    const beforeLen = start > 0 && !/\s/.test(before.slice(start - 1, start)) ? 1 : 0;
    const tailFirst = before.slice(start, start + 1);
    const afterLen = tailFirst === "" || tailFirst !== " " ? 1 : 0;
    const pos = start + beforeLen + 1 + afterLen;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      if (typeof el.setSelectionRange === "function") {
        el.setSelectionRange(pos, pos);
      } else {
        el.selectionStart = pos;
        el.selectionEnd = pos;
      }
    });
  }, [forceRender]);

  // 分屏文件管理「插入对话」事件桥:detail.text 为相对路径,kind 可选
  // (目录/文件);插入后聚焦输入框并把光标移到 chip 末尾。
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<AgentInputInsertDetail>).detail;
      const text = detail?.text;
      if (typeof text !== "string" || !text) return;
      insertFileReferenceAtCaret(text, detail.kind);
    };
    window.addEventListener(AGENT_INPUT_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(AGENT_INPUT_INSERT_EVENT, onInsert);
  }, [insertFileReferenceAtCaret]);

  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [skillMenuIdx, setSkillMenuIdx] = useState(0);

  // @-mention 文件补全 token 检测 + 搜索 hook(必须在 showSkillMenu 声明之后):
  // - activeAtToken(input, cursor) 给出当前光标处的 @ token(可能 undefined)
  // - 与 `/` slash 互斥:slash 只在 leading 位置触发,@ 在 (^|\s) 之后,所以同一
  //   input 不会同时进入两条路径;额外用 showSkillMenu 互斥门控更稳
  // - useFsMentionSearch 仅在 token 存在时拉数据(enabled),关闭时清空
  // - atMenuIdx 高亮位置:hook 返回 items 变化时归零
  const atToken = useMemo(
    () => activeAtToken(input, cursor),
    [input, cursor],
  );
  const [atMenuDismissed, setAtMenuDismissed] = useState(false);
  const showAtMenu =
    atToken !== undefined && !showSkillMenu && !atMenuDismissed;
  const atSearch = useFsMentionSearch(atToken?.query ?? "", {
    enabled: showAtMenu,
  });
  const [atMenuIdx, setAtMenuIdx] = useState(0);
  // 弹层"软关闭"标记:用户选中 file(完成态)或按 Escape / 点击外部,
  // 弹层应该关掉但输入框文本保留。下次输入变化(input change / atToken
  // prefix 变化)时重置 — 重新唤起弹层。dir 选择不触发软关闭,让
  // 弹层继续展示子内容(用户主动连选场景)。
  // hook items 变化时归零,避免越界;token 切换时同理。
  useEffect(() => {
    setAtMenuIdx(0);
  }, [atSearch.items, atToken?.prefix]);
  // input 或 atToken 变化 → 重置弹层软关闭(用户重新输入或换新 token)
  useEffect(() => {
    setAtMenuDismissed(false);
  }, [input, atToken?.prefix]);

  // 桌面端 "+" 按钮弹出的命令/技能选择层: 独立的 on/off 状态, 与 / slash
  // 自动补全下拉(showSkillMenu)互不干扰。两条路径共用 selectSlashItem 选择
  // 行为,只是触发方式不同 — 输入法触发 vs 显式按钮触发。
  const [quickOpen, setQuickOpen] = useState(false);
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
            storeApi.getState().clearMessages();
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
    commitDraft("/" + item.name + " ");
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [sessionId, activeSessionId, commitDraft]);

  // 选中一个 @-mention 候选:把 active @ token 整段替换为一个「引用 chip」。
  // 事务语义(deepseek-harness insert-reference):span 被替换为 U+FFFC 占位符
  // + occurrence 记录,尾随自动加一个空格。chip 是真实的 1 字符占位,不是
  // 文本宽度对位的视觉假象 —— 长路径不会撑宽输入框,光标/换行天然对齐。
  const selectAtEntry = useCallback(
    (entry: FsSearchEntry) => {
      if (!atToken) return;
      const formatted = formatFileMention(
        { path: entry.path, kind: entry.type },
        atToken.quoted,
      );
      if (formatted === undefined) {
        message.warning(`路径不安全: ${entry.path}`);
        return;
      }
      // start 用 atToken.end - prefix.length 而不是 cursor - prefix.length:
      // end 是 prefix 的真实结束 offset,start = end - prefix.length 始终给出
      // prefix 的起始位置。
      const start = atToken.end - atToken.prefix.length;
      // 引用实体路径:纯相对路径(dir 保留尾部 / 供 chip 判断 dir 类型);
      // 剪贴板/发送投影才是 formatted(@path 或 @"path")。
      const refPath = entry.type === "dir" ? `${entry.path}/` : entry.path;
      const reference: InputReference = {
        source: "fs",
        ref: refPath,
        label: refPath.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? refPath,
        clipboardText: formatted,
      };
      const machine = machineRef.current;
      if (!machine) return;
      machine.dispatch({
        type: "insert-reference",
        reference,
        span: { start, end: atToken.end, draftRev: machine.state.draftRev },
        tailSpace: true,
      });
      forceRender();
      // 新光标 = 占位符(1) + 尾随空格(1),落在 chip 之后方便继续打字
      const newCursor = start + 2;
      setCursor(newCursor);
      // 选中后即完成态,软关闭弹层(与旧 file 路径一致)
      setAtMenuDismissed(true);
      // rAF 只保留 DOM 焦点 + selection 同步(不参与 React 状态)。
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        if (typeof el.setSelectionRange === "function") {
          el.setSelectionRange(newCursor, newCursor);
        } else {
          el.selectionStart = newCursor;
          el.selectionEnd = newCursor;
        }
      });
    },
    [atToken, forceRender],
  );

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
    if (files.length === 0) {
      // 文本粘贴消毒:U+FFFC 是机器内部占位符,外部粘贴进来会破坏
      // occurrence 一致性,拦截并手动插入消毒后的纯文本。
      const text = e.clipboardData.getData("text/plain");
      if (text.includes(PLACEHOLDER)) {
        e.preventDefault();
        const el = textareaRef.current;
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? start;
        const clean = text.split(PLACEHOLDER).join("");
        const next =
          machineRef.current!.state.draft.slice(0, start) +
          clean +
          machineRef.current!.state.draft.slice(end);
        commitDraft(next);
        const pos = start + clean.length;
        requestAnimationFrame(() => {
          if (!el) return;
          el.focus();
          if (typeof el.setSelectionRange === "function") {
            el.setSelectionRange(pos, pos);
          } else {
            el.selectionStart = pos;
            el.selectionEnd = pos;
          }
        });
      }
      return;
    }
    e.preventDefault();
    void addAttachments(files);
  };

  // 拖入文件允许的最大体积:服务端 express.json 上限 20mb,base64 膨胀
  // ~1.33x,留出 JSON envelope 余量后按 14 MB 预检,超限直接本地报错,
  // 不发出注定失败(413)的请求。uploads 上限常量与 fs.ts MAX_UPLOAD_BYTES 对应。
  const MAX_DROP_UPLOAD_BYTES = 14 * 1024 * 1024;

  // 把拖入的非图片文件作为副本上传到 `<cwd>/.zai/uploads/`,返回副本的
  // 绝对路径。浏览器无法暴露拖入文件的系统绝对路径(File.path / file:// URI
  // 已被移除),所以「文件地址」= 服务端副本路径,agent 可通过该路径读取内容。
  const uploadFileToProject = useCallback(async (file: File): Promise<string> => {
    if (file.size > MAX_DROP_UPLOAD_BYTES) {
      throw new Error(
        `文件过大 (${(file.size / 1024 / 1024).toFixed(1)} MB > 14 MB)`,
      );
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
    const data = dataUrl.replace(/^data:[^;]+;base64,/, "");
    const res = await fetch("/api/fs/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name || "file", data }),
    });
    const body = (await res.json().catch(() => ({
      ok: false,
      error: `HTTP ${res.status}`,
    }))) as { ok: boolean; error?: string; absPath?: string };
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    if (!body.absPath) throw new Error("上传响应缺少 absPath");
    return body.absPath;
  }, []);

  // 逐个上传拖入的非图片文件,完成后把绝对路径(多文件换行分隔)插入
  // 输入框光标处。单个失败只报该文件错误,不阻断其余文件。
  const insertFileAddresses = useCallback(
    async (files: File[]) => {
      const paths: string[] = [];
      for (const f of files) {
        try {
          paths.push(await uploadFileToProject(f));
        } catch (err) {
          message.error(
            `上传 ${f.name} 失败: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (paths.length === 0) return;
      insertAtCursor(paths.join("\n"));
      message.success(`已上传 ${paths.length} 个文件, 地址已加入输入框`);
    },
    [insertAtCursor, uploadFileToProject],
  );

  const handleDrop = async (e: React.DragEvent) => {
    // streaming 时同样阻止默认行为 — 否则浏览器会把文件下载下来
    if (status === "streaming") {
      e.preventDefault();
      message.warning("请等待当前回复结束");
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) {
      // 拖入的是文件夹等无 File 项的拖放:浏览器默认下载/打开,阻止之
      e.preventDefault();
      return;
    }
    // 所有文件型拖放都必须 preventDefault —— 不阻止的话,非图片文件会
    // 被浏览器按默认行为下载/导航("下载成功"提示即来自此),图片则会在
    // 新窗口打开,打断对话。
    e.preventDefault();
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (images.length > 0) void addAttachments(images);
    if (others.length > 0) await insertFileAddresses(others);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    void addAttachments(files);
    e.target.value = "";
  };

  // IME guard:composition Enter 选词候选,不能发送(否则中文输入法
  // 候选区按 Enter 会直接发消息)。compositionend 的 keydown 在 Safari 晚到,
  // 所以延迟一拍清标记。
  const composingRef = useRef(false);
  const onCompositionStart = (): void => {
    composingRef.current = true;
  };
  const onCompositionEnd = (): void => {
    setTimeout(() => {
      composingRef.current = false;
    }, 10);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @-mention 文件补全菜单:优先级高于 slash,因为用户当前输入焦点就是 @
    // (slash 与 at 由 grammar 自然互斥,但下面用 showSkillMenu 二次门控更稳)
    if (showAtMenu) {
      // 方向键 / Enter 走 ArrowDown/Up + Enter:即便 items 还没加载也安全
      // (modulo 操作在 length=0 时返回 NaN/0,被后面的 in-list guard 过滤)
      const len = atSearch.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (len > 0) setAtMenuIdx((i) => (i + 1) % len);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (len > 0) setAtMenuIdx((i) => (i - 1 + len) % len);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const entry = atSearch.items[atMenuIdx];
        if (entry) selectAtEntry(entry);
        return;
      }
      if (e.key === "Escape") {
        // Escape 在 items 还没加载时也必须能关闭(popup 已在 mount),
        // 否则用户没法"放弃"。删除 @ token(consume-span 事务)让 atToken
        // 自然变 undefined,同时进入机器 undo 栈(可撤销删除)。
        e.preventDefault();
        if (atToken) {
          // 用 atToken.end(在 dir continuation 等 cursor > end 的场景下
          // 仍然指向 prefix 真实结束位置)而不是 cursor 来切。
          const start = atToken.end - atToken.prefix.length;
          const machine = machineRef.current;
          if (machine) {
            machine.dispatch({
              type: "consume-span",
              span: { start, end: atToken.end, draftRev: machine.state.draftRev },
            });
            forceRender();
          }
          setCursor(start);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            if (typeof el.setSelectionRange === "function") {
              el.setSelectionRange(start, start);
            } else {
              el.selectionStart = start;
              el.selectionEnd = start;
            }
          });
        }
        return;
      }
    }
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
          commitDraft("/" + it.name + " ");
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
        storeApi.getState().sessions.find(
          (s) => s.sessionId === sessionId,
        )?.permissionMode ?? "default";
      const idx = MODE_CYCLE_ORDER.indexOf(currentMode);
      const next = MODE_CYCLE_ORDER[(idx + 1) % MODE_CYCLE_ORDER.length]!;
      void storeApi.getState().patchSessionMode(sessionId, next);
      return;
    }
    // undo/redo:机器持有事务日志(chip 插入/删除也有事务语义),浏览器原生
    // undo 无法表达「占位符 ↔ occurrence」,必须拦截,不让原生栈跑。
    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === "z" || e.key === "Z" || e.key === "y")
    ) {
      e.preventDefault();
      const redo = e.key === "y" || e.shiftKey;
      const machine = machineRef.current;
      if (!machine) return;
      machine.dispatch({ type: redo ? "redo" : "undo" });
      forceRender();
      const el = textareaRef.current;
      if (el) {
        const caret = Math.min(el.selectionStart ?? 0, machine.state.draft.length);
        requestAnimationFrame(() => {
          el.focus();
          if (typeof el.setSelectionRange === "function") {
            el.setSelectionRange(caret, caret);
          } else {
            el.selectionStart = caret;
            el.selectionEnd = caret;
          }
        });
      }
      return;
    }
    // IME 组合输入中的 Enter 是选词候选,绝不能触发发送。
    if (composingRef.current && e.key === "Enter") return;
    // zai race fix: createNewSession 异步窗口期,Send 按钮已 disabled,
    // 但 Enter 键能绕过 disabled — 这里显式短路,避免 phantom POST。
    if (creatingSession) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const { submitPrompt, pushUserMsg } = useSubmitPrompt();

  // 排队消息生命周期:
  // - 提交时若后端排队(响应 queued:true), 消息只在排队预览区(不写
  //   transcript)。queue.changed 事件持续刷新 queuedPrompts。
  // - 某条 id 从 queuedPrompts 消失 = 开始执行(被后端消费)→ pushUserMsg
  //   写入 transcript, 与正常发送一致。
  // - 被用户取消的 id 进 canceledQueuedRef, watcher 跳过, 不写 transcript。
  //
  // 实现用"待 push 集合"(pendingPushRef)而不是 prev/next diff: diff 在
  // "消息入队显示"与"被消费消失"落在同一个 React 批次时(abort 后 drain
  // 快速连续消费、或事件批处理合并)会漏 — prev 永远捕获不到那条消息的
  // 存在, 消失时无从感知。pendingPushRef 记录所有曾进入队列的 id, 无论
  // 是否稳定渲染过, 消失时都能被识别。
  const canceledQueuedRef = useRef<Set<string>>(new Set());
  const pendingPushRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const currentIds = new Set(queuedPrompts.map((p) => p.id));
    // 新出现的排队消息 → 记录待 push(text 可能被后一个快照覆盖, 保首见值)
    for (const p of queuedPrompts) {
      if (!pendingPushRef.current.has(p.id)) {
        pendingPushRef.current.set(p.id, p.text);
      }
    }
    // 消失且未取消 → 开始执行, push 进 transcript
    for (const [id, text] of pendingPushRef.current) {
      if (currentIds.has(id)) continue;
      if (canceledQueuedRef.current.delete(id)) {
        pendingPushRef.current.delete(id); // 被取消, 丢弃
        continue;
      }
      pendingPushRef.current.delete(id);
      pushUserMsg(text);
    }
    // 正在编辑的行消失 / 被消费 → 退出编辑态(对齐 DSH QueueDock 的
    // editing cleanup: row no longer pending → setEditing(null))。
    setEditingQueuedId((current) => {
      if (current !== null && !currentIds.has(current)) return null;
      return current;
    });
  }, [queuedPrompts, pushUserMsg]);

  const cancelQueued = useCallback(
    async (promptId: string) => {
      canceledQueuedRef.current.add(promptId);
      const sid = sessionId || activeSessionId || undefined;
      let removed = true;
      try {
        const resp = await api.post<{ removed?: boolean }>("/agent/queue/cancel", {
          sessionId: sid,
          promptId,
        });
        removed = resp.removed !== false;
      } catch {
        // 失败回滚取消标记, 让 watcher 下次按正常路径处理(消息仍在排队)。
        canceledQueuedRef.current.delete(promptId);
        return;
      }
      if (!removed) {
        // 后端返回 removed:false — 消息已被消费(开始执行)或已不存在。
        // 撤销取消标记, 让 watcher 正常 push 进 transcript, 否则这条
        // 用户消息会永久缺失。
        canceledQueuedRef.current.delete(promptId);
        return;
      }
      // 立即本地移除避免闪烁; 后端 queue.changed 事件也会刷新快照。
      storeApi.setState((s) => ({
        queuedPrompts: s.queuedPrompts.filter((p) => p.id !== promptId),
      }));
    },
    [sessionId, activeSessionId],
  );

  // 开始编辑一条排队消息: 以当前快照文本为初值, 行切换为内联编辑框。
  const startEditQueued = useCallback(
    (p: QueuedPrompt) => {
      setEditingQueuedId(p.id);
      setEditingQueuedText(p.text);
    },
    [],
  );

  const cancelEditQueued = useCallback(() => {
    setEditingQueuedId(null);
    setEditingQueuedText("");
  }, []);

  // 保存编辑: POST /agent/queue/edit → 成功则本地同步文本(等 queue.changed
  // 确认), 并更新 pendingPushRef 的"首见值", 让该条真正执行时 watcher 把
  // 编辑后的文本写入 transcript(而不是编辑前的旧文本)。
  // queue-item-not-found = 该条已被消费开始执行, 编辑必然失败 — 由后端
  // queue.changed 快照把它移出预览, 这里只提示并退出编辑态。
  const saveEditQueued = useCallback(
    async () => {
      if (editingQueuedId === null) return;
      const text = editingQueuedText.trim();
      if (text === "") return;
      const sid = sessionId || activeSessionId || undefined;
      try {
        const resp = await api.post<{ ok?: boolean; error?: string }>(
          "/agent/queue/edit",
          { sessionId: sid, promptId: editingQueuedId, text },
        );
        if (resp.ok === false) {
          message.warning("编辑失败：这条消息可能已经开始发送。");
          cancelEditQueued();
          return;
        }
        pendingPushRef.current.set(editingQueuedId, text);
        storeApi.setState((s) => ({
          queuedPrompts: s.queuedPrompts.map((p) =>
            p.id === editingQueuedId ? { ...p, text } : p,
          ),
        }));
        cancelEditQueued();
      } catch {
        message.error("编辑失败，请重试。");
      }
    },
    [editingQueuedId, editingQueuedText, sessionId, activeSessionId, cancelEditQueued],
  );

  // 插话发送: POST /agent/queue/steer → 该条移出排队预览(后端移入 inbox
  // next-step lane, 当前轮结束后最先执行), watcher 在离开预览时把消息写入
  // transcript —— 用户消息即时"插入会话", 与 DSH steer 语义对齐。
  // 注意: 不能进 canceledQueuedRef(取消标记会抑制 watcher 的 transcript
  // 写入, 插话消息就永远不显示了)。
  const steerQueued = useCallback(
    async (promptId: string) => {
      const sid = sessionId || activeSessionId || undefined;
      try {
        const resp = await api.post<{ ok?: boolean; error?: string }>(
          "/agent/queue/steer",
          { sessionId: sid, promptId },
        );
        if (resp.ok === false) {
          if (resp.error === "steer-unavailable") {
            message.info("当前不在生成中，无需插话。");
          } else {
            message.warning("插话失败：这条消息可能已经开始发送。");
          }
          return;
        }
        // 立即本地移除避免闪烁; 后端 queue.changed 事件也会刷新快照。
        storeApi.setState((s) => ({
          queuedPrompts: s.queuedPrompts.filter((p) => p.id !== promptId),
        }));
      } catch {
        message.error("插话发送失败，请重试。");
      }
    },
    [sessionId, activeSessionId],
  );

  const handleSend = async () => {
    // zai race fix: createNewSession 异步窗口期(createNewSession 内 set
    // sessionId:null → server POST 回来前)必须阻断 Send。Enter 键已短路
    // (line ~1039),这里是 Enter / Send button / 编程触发三入口的统一拦截。
    // 非 race 时(`creatingSession=false`):即便 sessionId 为空也走原 fallback
    // 路径(sid = sessionId || activeSessionId || undefined),保持向后兼容。
    if (creatingSession) return;
    // draft 里的 U+FFFC 占位符展开为剪贴板投影(@path 文本)再发送 —
    // 后端协议不变:收到的还是「文本里夹着 @相对路径」。
    const expanded = projectClipboard(machineRef.current!.state);
    const text = expanded.trim();
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
      machineRef.current?.dispatch({ type: "clear" });
      forceRender();
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
            storeApi.getState().clearMessages();
            message.success("对话已清空");
            return;
          case "compacted":
            message.success(
              `压缩完成,移除 ${result.payload.removedMessages} 条`,
            );
            await storeApi.getState().loadSessions();
            return;
          case "status":
            message.info(
              `cwd: ${result.payload.cwd}\nmodel: ${result.payload.model}\nsession: ${result.payload.sessionId ?? "-"}`,
              5,
            );
            return;
          case "prompt":
            // 与 opencc 一致: 只显示用户输入的 `/<command-name> <args>`,
            // 不把 skill 展开后的完整 prompt(rendered)以「渲染后」行显示。
            // rendered 仍作为模型输入发送,不影响命令执行语义。
            // commandText 同时随请求上送 —— 服务端把原始指令写成可见
            // 消息、rendered 以 isMeta 落盘,刷新/恢复后展示形态与实时一致。
            pushUserMsg(text, false);
            await submitPrompt(result.payload?.rendered ?? text, {
              skipPushUserMsg: true,
              commandText: text,
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
    // 桌面附件自动附带: 仅桌面页 (/desktop)。附件区保留, 同路径附件只随
    // 一次消息附带 (desktopAttachmentStore merged 语义); @path 引用置于
    // 消息开头, 让 AI 先看到附件上下文。命令文本 (/开头) 走 /agent/command
    // 无 prompt 通道, 不附带。
    const desktopMentions = window.location.pathname.startsWith("/desktop")
      ? useDesktopAttachmentStore.getState().takeUnmergedMentions(text)
      : "";
    const finalText = desktopMentions.trim()
      ? `${desktopMentions.trim()}${text ? "\n" + text : ""}`
      : text;
    if (!finalText && blocks.length === 0) return;
    // 追齐 OPENCC: 对话进行中(streaming)不禁用发送 — 消息进入后端
    // per-session 串行队列, 当前轮结束后自动执行, 输入框上方显示排队预览。
    machineRef.current?.dispatch({ type: "clear" });
    forceRender();

    if (blocks.length > 0) {
      // 第一版排队仅文本: streaming 中图片消息不可发送(图片按钮/drop 已禁用,
      // 但 streaming 前挂载的附件仍可能随 Enter 提交), 拦截并提示 — 否则
      // pushUserMsg 写 transcript + 后端排队(queued:true)双显, 消费时 watcher
      // 再 push 一次造成三份。
      if (status === "streaming") {
        message.warning("对话进行中暂不支持发送图片,请等待当前回复结束");
        commitDraft(expanded); // 恢复文字(附件保留在 attachments 状态)
        return;
      }
      // 含图片附件: 仍走原始内联实现 (submitPrompt hook 不接 contentBlocks,
      // 保持图片附件路径不抽到 hook — 与 handleSend 历史契约对齐, 避免破坏
      // 已有 ["AgentInputBox"] 附件提交路径).
      // 修复: 必须本地 push 一条 user.text, 把图片附件一并写进 store,
      // 否则首条带图消息发出去后 UI 不渲染用户消息 (commit 87a44c0a 把这里的
      // pushUserMsg 删了, 注释声称的 transcript 刷新路径实际不存在).
      // 纯文本分支由 submitPrompt 默认行为 push 一条 user.text, 不重复.
      pushUserMsg(finalText, false, readyAttachments);
      // 图片附件: 不要 revokeObjectURL, 缩略图 URL 被 push 进的 user.text
      // 消息持有着, MessageBubble / AttachmentStrip 渲染时还在用. 提前 revoke
      // 会让图片缩略图渲染成空 (revoked blob URL → <img> 拿不到资源).
      // 清理时机: 切会话/清屏/session.ended 时由 MessageBubble unmount 路径
      // 兜底; 或者用户重新上传新图覆盖同 localId 时.
      setAttachments([]);
      const sid = sessionId || activeSessionId || undefined;
      const { sessionId: returnedSessionId } = await api.post<{
        sessionId: string;
      }>(
        "/agent/prompt",
        { prompt: finalText || undefined, contentBlocks: blocks, sessionId: sid },
        { headers: sid ? { "X-Session-Id": sid } : undefined },
      );
      storeApi.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      });
      const localTitle = deriveLocalTitle(finalText);
      if (localTitle) {
        storeApi.getState().applySessionEvent({
          type: "session.renamed",
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        });
      }
    } else {
      // 纯文本分支: 没有图片块, 所有附件都是孤儿, revoke 它们的 blob URL.
      // (image 分支的附件已经在 pushUserMsg 里被 user.text 引用, 不能 revoke.)
      attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl));
      setAttachments([]);
      await submitPrompt(finalText);
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
        {/* 最左侧插槽 — 场景专属按钮由此注入(● 状态指示之前)。 */}
        {toolbarLeftSlot}
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
            {creatingSession && "正在创建会话…"}
            {!creatingSession && status === "idle" && "就绪"}
            {!creatingSession && status === "streaming" && `对话中… (${elapsed}s)`}
            {!creatingSession && status === "aborted" && "已中止"}
            {!creatingSession && status === "error" && "错误"}
          </span>
        )}
        {streamState === "reconnecting" && (
          <span
            data-testid="conn-reconnecting"
            style={{ color: "var(--warning, #d4a72c)", marginLeft: 4 }}
          >
            重连中… ({streamAttempt}/3)
          </span>
        )}
        {streamState === "error" && (
          <span
            data-testid="conn-error"
            style={{ color: "var(--danger, #ff4d4f)", marginLeft: 4 }}
          >
            连接已断开
            <a
              onClick={() => window.location.reload()}
              style={{ marginLeft: 6, textDecoration: "underline", cursor: "pointer" }}
            >
              重连
            </a>
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
        {/* 「+ 命令」按钮: 桌面 + 移动端均挂载. 行为完全相同 — 点击弹出
            QuickCommandPopover (跨端复用). 移动端另保留 AppstoreAddOutlined
            按钮 (→ MobileQuickDrawer 3 Tab) 作为补充入口 (bash/prompt/git
            移动端专属).
            位置: spacer 后第一个,作为工具栏右端第一入口 — 命令面板是用户最
            常用的辅助操作之一,放在最左能让拇指/鼠标最快够到. aria-pressed
            传达开关态, 红色高亮 active 状态. */}
        <Tooltip title="命令/技能" placement="top">
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setQuickOpen((v) => !v);
              // 两条路径互斥: 打开 + 弹层时关闭 / slash 自动补全下拉,
              // 避免两个 dropdown 叠在同一锚点上互相遮挡.
              setShowSkillMenu(false);
            }}
            data-testid="quick-command-trigger"
            aria-label="打开命令/技能列表"
            aria-pressed={quickOpen}
            style={{
              ...toolbarIconButtonStyle,
              ...(quickOpen && {
                color: TOOLBAR_ACTIVE_COLOR,
                borderColor: TOOLBAR_ACTIVE_COLOR,
              }),
            }}
          />
        </Tooltip>
        {/* Share 按钮: 分享当前 session 到 LAN.
            - 位置: spacer 后第二, 工具栏右端第二个入口 (演示场景核心操作).
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
        <PluginButton />
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
            解决 transcript 里 tool_use 没配对的 warning。调试性质入口,
            2026-09-02 起默认不渲染,由 showTranscriptRepair prop 控制(/agent 开启)。 */}
        {showTranscriptRepair && !isMobile && (
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
        {/* 最右侧插槽 — 场景专属按钮由此注入。分屏 toggle 已抽为独立组件
            SplitPaneToggleButton,只在 /agent 页面经此插槽挂载。 */}
        {toolbarRightSlot}

      </div>

      {/* TextArea + slash dropdown 区 */}
      <div
        data-testid="agent-input-drop-zone"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {/* 排队预览区: 对话进行中提交的消息在此等待, 当前轮结束后自动执行。
            每条可单独取消(×)。渲染在输入框上方, 追齐 OPENCC 的 queued
            commands 预览。 */}
        {queuedPrompts.length > 0 && (
          <div
            data-testid="queued-prompts-preview"
            style={{
              border: "1px solid var(--border-subtle)",
              borderBottom: "none",
              borderRadius: "8px 8px 0 0",
              background: "var(--bg-card)",
              maxHeight: 120,
              overflowY: "auto",
              padding: "4px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {queuedPrompts.map((p) => (
              <div
                key={p.id}
                data-testid={`queued-prompt-${p.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  padding: "2px 4px",
                  borderRadius: 4,
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    color: "#a78bfa",
                    fontWeight: 600,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  排队中
                </span>
                {editingQueuedId === p.id ? (
                  <Input
                    size="small"
                    autoFocus
                    value={editingQueuedText}
                    data-testid={`queued-edit-input-${p.id}`}
                    aria-label="编辑排队消息"
                    onChange={(e) => setEditingQueuedText(e.target.value)}
                    onPressEnter={() => void saveEditQueued()}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") cancelEditQueued();
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      padding: "1px 8px",
                    }}
                  />
                ) : (
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.text}
                  </span>
                )}
                {editingQueuedId === p.id ? (
                  <>
                    <Button
                      type="text"
                      size="small"
                      icon={<CheckOutlined />}
                      onClick={() => void saveEditQueued()}
                      aria-label="保存排队消息"
                      style={{
                        flexShrink: 0,
                        width: 20,
                        height: 20,
                        fontSize: 10,
                        color: "var(--text-secondary)",
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={cancelEditQueued}
                      aria-label="取消编辑排队消息"
                      style={{
                        flexShrink: 0,
                        width: 20,
                        height: 20,
                        fontSize: 10,
                        color: "var(--text-dim-45)",
                      }}
                    />
                  </>
                ) : (
                  <>
                    <Tooltip
                      title={status === "streaming" ? "插话发送：插入到当前轮之后最先执行" : "仅生成中可插话发送"}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<ArrowUpOutlined />}
                        onClick={() => void steerQueued(p.id)}
                        disabled={status !== "streaming" || editingQueuedId !== null}
                        aria-label="插入提示"
                        style={{
                          flexShrink: 0,
                          width: 20,
                          height: 20,
                          fontSize: 10,
                          color: "var(--text-dim-45)",
                        }}
                      />
                    </Tooltip>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => startEditQueued(p)}
                      disabled={editingQueuedId !== null}
                      aria-label="编辑排队消息"
                      style={{
                        flexShrink: 0,
                        width: 20,
                        height: 20,
                        fontSize: 10,
                        color: "var(--text-dim-45)",
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() => void cancelQueued(p.id)}
                      aria-label="取消排队消息"
                      style={{
                        flexShrink: 0,
                        width: 20,
                        height: 20,
                        fontSize: 10,
                        color: "var(--text-dim-45)",
                      }}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
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
                      // 命令/Skill 名视觉 identity: 与输入框内 mark 共享
                      // var(--cmd-token-color) — 深色主题 #a78bfa 紫,
                      // 浅色主题 var(--accent-start) 橙. 输入框敲 `/name`
                      // 时出现的 mark 与 dropdown 选条完全同色,反馈一致。
                      color: "var(--cmd-token-color)",
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
          {/* "+" 按钮触发的命令/技能选择弹层.
              与 / slash 下拉不同: 弹层带搜索框 + 显式卡片, 锚定在输入框上方
              (与 slash 同一锚点). 打开时焦点交给内部搜索框, 选中调用相同的
              selectSlashItem — 行为差异仅在触发方式, 不在执行语义.
              桌面 + 移动端均使用 (maxHeight 360 控制高度, 不会溢出视口). */}
          {quickOpen && (
            <QuickCommandPopover
              items={slashItems}
              onClose={() => setQuickOpen(false)}
              onSelect={async (item) => {
                setQuickOpen(false);
                await selectSlashItem(item);
              }}
            />
          )}
          {/* @-mention 文件补全 popup:锚定在输入框上方,与 slash 同一锚点。
              同一 input 不会同时触发 slash 与 at(grammar 互斥),所以不冲突。
              选中走 selectAtEntry —— 替换 token 文本,不触发任何命令执行。
              onDismiss 关闭弹层:此处也用删 @ token 的办法,与 Escape 路径一致
              (避免弹层关闭但 @ 还卡在输入框)。 */}
          {showAtMenu && (
            <FileMentionPopover
              items={atSearch.items}
              loading={atSearch.loading}
              error={atSearch.error}
              truncated={atSearch.truncated}
              activeIndex={atMenuIdx}
              onActiveIndexChange={setAtMenuIdx}
              onSelect={selectAtEntry}
              onDismiss={() => {
                // 外部点击关闭:用删除 token 方式自然消失,保留光标。
                if (atToken) {
                  const start = atToken.end - atToken.prefix.length;
                  const machine = machineRef.current;
                  if (machine) {
                    machine.dispatch({
                      type: "consume-span",
                      span: { start, end: atToken.end, draftRev: machine.state.draftRev },
                    });
                    forceRender();
                  }
                  setCursor(start);
                  requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (!el) return;
                    el.focus();
                    if (typeof el.setSelectionRange === "function") {
                      el.setSelectionRange(start, start);
                    } else {
                      el.selectionStart = start;
                      el.selectionEnd = start;
                    }
                  });
                }
              }}
            />
          )}
          {/* Mirror-backdrop wrapper(追齐 deepseek-harness InputBar 的三层手法):
            唯一滚动容器 .scroll → .grow → [backdrop(可见装饰层)/ textarea
            (透明文本,只留 caret)/ mirror(隐藏,决定高度 → auto-grow)]。
            三层共享 metrics + font-stack(DshChipCell 打头,保证 U+FFFC 占
            位符在 textarea 与 backdrop 里宽度一致),文本与 chip 天然逐字
            对齐、零漂移。backdrop 常驻:chip / token-mark / 普通文本全在
            这里渲染。 */}
          <div
            data-testid="agent-input-decorator-wrap"
            className="agent-input-decorator-wrap"
          >
            <div ref={scrollRef} className="agent-input-scroll" data-input-scroll>
              <div className="agent-input-grow">
                <div
                  aria-hidden
                  data-input-backdrop
                  className="agent-input-backdrop"
                  data-decoration={commandToken ? "token" : atToken ? "at" : "chips"}
                >
                  {renderDraftDecorations(
                    input,
                    machineChips,
                    commandToken,
                    atToken
                      ? { start: atToken.end - atToken.prefix.length, end: atToken.end, prefix: atToken.prefix }
                      : null,
                  )}
                </div>
                <textarea
                  ref={textareaRef}
                  className="agent-input-textarea-field"
                  value={input}
                  data-testid="agent-input-textarea"
                  placeholder="输入消息, 按 Enter 发送, Shift+Enter 换行. 拖入图片直接插入, 拖入其他文件自动上传并加入地址. 敲 @ 触发文件补全."
                  rows={1}
                  disabled={pendingAsk?.status === "pending"}
                  // onChange:写入新值(machine 事务),同时同步光标位置。
                  onChange={(e) => {
                    commitDraft(e.target.value);
                    const sel = e.target.selectionStart;
                    if (typeof sel === "number") {
                      setCursor(sel);
                      revealAfterEdit(sel);
                    }
                  }}
                  // onKeyUp:方向键/Home/End 不触发 onChange,但会动光标;
                  // 这里补一刀,保证下一次 render 之前 cursor 已就位。
                  onKeyUp={(e) => {
                    const sel = (e.target as HTMLTextAreaElement).selectionStart;
                    if (typeof sel === "number") {
                      setCursor(sel);
                      revealAfterEdit(sel);
                    }
                  }}
                  // onClick:鼠标点击定位光标;selectStart 同步刷新。
                  onClick={(e) => {
                    const sel = (e.target as HTMLTextAreaElement).selectionStart;
                    if (typeof sel === "number") {
                      setCursor(sel);
                      revealAfterEdit(sel);
                    }
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onCompositionStart={onCompositionStart}
                  onCompositionEnd={onCompositionEnd}
                />
                {/* 隐藏镜像:含换行,决定 .grow 的真实高度(min 两行交给 CSS) */}
                <div
                  ref={mirrorRef}
                  aria-hidden
                  className="agent-input-mirror"
                >{`${input}\n`}</div>
              </div>
            </div>
          </div>
          {/* 移动端"停止"按钮: 替代桌面端的 Esc 键 —
            物理键盘/软键盘都没有 Esc, 必须给移动用户提供一个等价入口.
            - 仅 isMobile 时挂载 (桌面端继续靠 Esc keydown, 避免按钮占位);
            - 仅 streaming 时显示, 非流式态 stop 无意义;
            - 调用 storeApi.getState().stop() 与 AgentConversation 的
              全局 Esc 处理路径完全一致 (AgentConversation.tsx:91-99),
              走同一套后端 abort + status 流, 不会绕过任何清理逻辑. */}
          {isMobile && status === "streaming" && (
            <Button
              data-testid="mobile-stop-button"
              aria-label="停止生成"
              onClick={() => {
                void storeApi.getState().stop()
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
