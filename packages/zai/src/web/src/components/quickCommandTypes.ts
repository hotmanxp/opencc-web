/**
 * SlashItem — `/api/slash` 返回的每个命令/技能条目。
 *
 * 与 `AgentInputBox` 内嵌的局部定义同源;单独抽出是为了让 `QuickCommandPopover`
 * 与 `AgentInputBox` 共享同一份类型,避免实现分叉。两处显示字段顺序如有
 * 调整,改这里即可同步。
 *
 * `kind: "command"` 表示内置命令(可执行或 prompt 渲染);`kind: "skill"` 表示
 * 技能(总是插入到输入框)。`type` 仅对 command 有意义:
 *   - "local": 立即执行,POST /agent/command
 *   - "prompt": 渲染后作为 prompt 提交
 */
export type SlashItem = {
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
