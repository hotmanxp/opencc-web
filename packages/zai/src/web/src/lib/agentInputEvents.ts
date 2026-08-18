/**
 * 分屏文件管理「插入对话」→ 对话输入框 的跨组件事件。
 *
 * FsContextMenu(分屏区,目录树 / 搜索列表的右键菜单)dispatch,
 * AgentInputBox(对话输入框)监听并按 detail.text 在光标处插入。
 *
 * 为什么用 window CustomEvent 而非全局 store / Context:
 *   AgentInputBox 的输入 value 是组件本地 state(React.memo),FsTab 在完全
 *   独立的子树,传 props 要穿透整条组件链;库内已有同款先例(fs-editor-get-doc
 *   / zai-localstorage-sync),改动面最小。见 CONTEXT.md「插入对话」。
 */
export const AGENT_INPUT_INSERT_EVENT = 'agent-input-insert';

export interface AgentInputInsertDetail {
  /** 要插入输入框的文本 —— 相对文件管理区 cwd 的路径(与「复制相对路径」同值)。 */
  text: string;
}