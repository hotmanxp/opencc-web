/**
 * 插件市场桥 — B5 T5.3。
 *
 * zai 插件（~/.zai/plugins/ V2 schema，installed_plugins.json）在 dsh 轨道加载：
 * 插件内的 hooks / commands / skills 定义经桥注册进 dsh ctx。
 *
 * 优先评估 dsh `hooks/` 包（wire protocol）映射 zai 插件 hooks。
 *
 * **TODO（P1-6）真实实现**：
 * 1. 解析 `~/.zai/plugins/installed_plugins.json`（V2 schema）
 * 2. 对每个 plugin 的 hooks/commands/skills：
 *    - hooks → ctx.on('agent/...') 监听器
 *    - commands → ctx.tools.register(defineTool) 注册
 *    - skills → loadZaiSkills + skillsToTools（参考 B2 T2.4）
 * 3. 插件热卸载：通过 Cordis plugin.dispose 移除监听器
 *
 * 预计工作量 1 天。
 */

export interface ZaiPluginHook {
  name: string
  /** 钩子触发点 — zai 命名空间。 */
  trigger: string
  /** 命令名（如果钩子是 command 类型）。 */
  commandName?: string
  body: string
}

export interface ZaiPlugin {
  name: string
  version: string
  hooks: ZaiPluginHook[]
  commands: Array<{ name: string; body: string }>
  skills: Array<{ name: string; path: string }>
}

/**
 * 加载 ~/.zai/plugins/ 已安装插件（V2 schema）。
 */
export async function loadZaiPlugins(): Promise<ZaiPlugin[]> {
  return []
}

/**
 * 把 zai 插件 hooks 转为 dsh agent/* 事件监听。
 */
export function registerZaiPluginHooks(
  _ctx: unknown,
  _plugins: ZaiPlugin[],
): void {
  // 当前 stub：B5 T5.3 真实接线。
}

/**
 * 把 zai 插件 commands 注册为 dsh slash 命令。
 */
export function registerZaiPluginCommands(
  _ctx: unknown,
  _plugins: ZaiPlugin[],
): void {
  // 当前 stub：B5 T5.4 真实接线。
}