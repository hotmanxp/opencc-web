/**
 * zai skill 目录热更新 —— vendor `skillChangeDetector` 的接线层。
 *
 * Why 需要这一层:vendor(`opencc-src/utils/skills/skillChangeDetector.ts`)自带
 * 完整的 chokidar watcher(监听 `~/.agents/skills`、`~/.agents/commands`、项目
 * `.zai/{skills,commands}`、`--add-dir` 的 `.zai/skills`,变更 1s 防抖后
 * `clearSkillCaches()` + `clearCommandsCache()` + `resetSentSkillNames()` +
 * emit)。但它只在 vendor 交互式入口 `opencc-src/main.tsx:463` 初始化,而
 * zai-server 走 headless 运行时(`createOpenccRuntime` / `createHeadlessContext`),
 * 那条路径零引用 —— 结果是:
 *   - skill 目录变了没人清缓存,模型侧 skill_listing(`loadAllCommands` /
 *     `getSkillToolCommands` 双重 memoize)一直是首次快照;
 *   - 只有重启进程或 `/clear` / 装插件(走 `refreshActivePlugins`)才刷新。
 *
 * 本模块做三件事:
 *   1. 启动 vendor watcher(带默认 skills 根的兜底创建);
 *   2. 变更时清 zai 侧的 compat plugin 缓存(vendor 的 clearCommandsCache 管不到);
 *   3. 广播 `skills.changed`,让每个打开的 tab 重拉 `/api/slash`(前端此前只在
 *      挂载时拉一次,装完 skill 必须手动刷新页面才看得到)。
 *
 * 不做 toast:skill 变更可能是用户自己 `git pull` / 编辑器保存触发的批量事件,
 * 弹提示只会打扰;静默刷新列表即可。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { eventBus } from './eventBus.js'

/**
 * zai 默认 skill 根。与 `agentRuntime.ts` 的 `AGENTS_SKILLS_DIR` 同值
 * (那里是 `resolveSkillsDirs()` 的默认项);重复声明是为了不在本模块反向
 * 依赖 agentRuntime(会成环)。
 */
const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills')

let unsubscribe: (() => void) | null = null
let started = false

export interface StartSkillWatcherOptions {
  /** 当前启用的 skills 根目录列表(`resolveSkillsDirs()` 的返回值)。 */
  skillsDirs: string[]
  /**
   * 清 zai 侧 plugin 运行时缓存。vendor 的 `clearCommandsCache()` 只清它自己
   * 的 memoize;zai 的 `listSkills()` 还走 compat `DefaultPluginRuntime`
   * (自持 `cache ??=`,全仓没有 `clearCache()` 调用点),不清它的话
   * `/api/slash`、`/api/agent/skills` 里的 plugin skill 会一直停在首次 load
   * 的快照上。
   */
  clearPluginCache?: () => void
  /**
   * 重新加载 user/plugin 命令到 zai 自己的 command registry。vendor 的
   * watcher 同样覆盖 `~/.agents/commands` 与项目 `.zai/commands`,而 zai 的
   * registry 只在启动时 `initCommands()` 扫过一次 —— 不重扫的话装一条命令
   * 会触发 skills.changed,列表却纹丝不动。
   */
  reloadCommands?: () => Promise<void>
}

/**
 * 启动 skill 目录 watcher。进程内幂等 —— 重复调用只生效一次
 * (与 `initAgentRuntime` 的 `if (runtime) return` 语义一致)。
 */
export function startSkillWatcher(opts: StartSkillWatcherOptions): void {
  if (started) return
  started = true

  // 不 await:vendor 的 initialize() 内部 chokidar.watch 是 I/O,启动路径
  // 不该被它拖住(与 startMemoryWatcher 的 fire-and-forget 一致)。失败只
  // 降级为"无热更新",不影响 server 起服务。
  void (async () => {
    try {
      // vendor `getWatchablePaths()` 逐个 stat 候选目录,不存在就整条跳过。
      // 首次安装 skill 之前 `~/.agents/skills` 不存在时,watcher 就永远看不到
      // 之后建出来的目录 —— 正好掐掉"首次安装自动发现"。zai 默认就用这个根,
      // 先补齐(空目录无副作用,与 Nova/OpenCode/OpenCC 共享该目录)。
      if (opts.skillsDirs.includes(AGENTS_SKILLS_DIR)) {
        mkdirSync(AGENTS_SKILLS_DIR, { recursive: true })
      }

      const { skillChangeDetector } = await import('@zn-ai/zn-agent-core')

      unsubscribe = skillChangeDetector.subscribe(() => {
        // vendor 在 emit 之前已经清过它自己的 skill/command 缓存 + 重置了
        // 模型侧 skill_listing 去重(git pull 这类批量变更已被 vendor 侧 1s
        // 防抖折叠成一次回调)。这里补 zai 侧的两件事:
        try {
          opts.clearPluginCache?.()
        } catch (err) {
          console.warn('[skillWatcher] clearPluginCache failed:', err)
        }
        // 重扫 user/plugin 命令 —— registry 是 zai 自己的单例,不重扫就停在
        // 启动时那次扫描。异步且不阻塞广播(失败只写日志,不影响刷新)。
        if (opts.reloadCommands) {
          void opts.reloadCommands().catch((err) => {
            console.warn('[skillWatcher] reloadCommands failed:', err)
          })
        }
        eventBus.emit({ type: 'skills.changed' })
      })

      await skillChangeDetector.initialize()
    } catch (err) {
      console.warn('[skillWatcher] start failed:', err)
    }
  })()
}

/**
 * 关 watcher + 退订。`runtimeLifecycle.closeServer` 调用。
 *
 * 注意 vendor 的 `dispose()` 会把模块级 `disposed` 置 true 且不可逆(只有
 * `resetForTesting` 能复位),所以本函数之后不能在同进程内再 start —— 与
 * 进程级 shutdown 的语义一致。
 */
export function stopSkillWatcher(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  started = false
  void (async () => {
    try {
      const { skillChangeDetector } = await import('@zn-ai/zn-agent-core')
      await skillChangeDetector.dispose()
    } catch (err) {
      console.warn('[skillWatcher] dispose failed:', err)
    }
  })()
}