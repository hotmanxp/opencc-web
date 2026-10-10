import { registerBuiltinMod } from '../builtin.js'
import type { ModContext } from '../engine.js'
import { getLoadedMods } from '../registry.js'
import { getKnownMods } from '../registry.js'
import { BUILTIN_ORIGIN } from '../registry.js'

/**
 * Built-in mod `modctl` — mod 运行时的自检面板。
 *
 * 它存在的理由不只是「有个内置 mod 可验证」:mod 系统有一整套对用户不可见
 * 的状态(哪些被发现了、哪些在跑、各自注册了什么、订阅了哪些事件、熔断了
 * 没有),出问题时用户没有任何手段自查。这个命令把那些状态摊开成一段文字。
 *
 * 它也是 vendor 里第一个内置 mod —— 在此之前 `builtinSpecs` 一直为空
 * (见 builtin.ts 文件末的说明),所以内置 mod 这条路径(`@builtin` id、
 * `noteDiscoveredMod(name, true)`、无 root 路径)在 zai 侧从未真跑过。
 *
 * 纯数据通道:只用 `local` 命令 + `ui.notice`,不碰任何渲染面 —— 内置 mod
 * 必须能在没有 TUI 的宿主里工作,这正是与上游 diff / handoff 的区别。
 */
registerBuiltinMod({
  name: 'modctl',
  version: '1.0.0',
  description: 'mod 运行时自检:当前加载了哪些 mod、各自注册了什么',
  register(ctx: ModContext) {
    ctx.registerCommand({
      name: 'modctl',
      description: '列出当前加载的 mod 及其注册的命令 / 工具 / 事件订阅',
      handler: () => {
        const loaded = getLoadedMods()
        const known = getKnownMods()

        if (loaded.length === 0 && known.size === 0) {
          return '没有任何 mod 被加载。\n把 mod 目录放在 ~/.zai/mods/<name>/ 下(内含 opencc-mod.json),然后重载。'
        }

        const lines: string[] = []

        // 已加载:代码在跑,注册的内容是活的。
        for (const mod of loaded) {
          const isBuiltin = mod.root === BUILTIN_ORIGIN
          const origin = isBuiltin ? '内置' : mod.root
          lines.push(
            `${isBuiltin ? '●' : '○'} ${mod.manifest.name}${mod.manifest.version ? ` v${mod.manifest.version}` : ''}  (${origin})`,
          )
          if (mod.commands.length > 0) {
            lines.push(`    命令: ${mod.commands.map(c => c.name).join(', ')}`)
          }
          if (mod.tools.length > 0) {
            // 工具的运行时名是 `mods_<mod>_<tool>`。
            lines.push(`    工具: ${mod.tools.map(t => `mods_${mod.manifest.name}_${t.name}`).join(', ')}`)
          }
          if (mod.handlers.length > 0) {
            lines.push(`    事件: ${mod.handlers.map(h => h.event).join(', ')}`)
          }
        }

        // 已知但未加载 = 被用户关掉了。它们的代码没跑,但仍占一行以便开回来。
        const disabled = [...known.keys()].filter(
          name => !loaded.some(m => m.manifest.name === name),
        )
        for (const name of disabled) {
          lines.push(`○ ${name}  (已停用)`)
        }

        if (disabled.length > 0) {
          lines.push('')
          lines.push('提示:停用的 mod 在插件管理弹窗里可以重新打开。')
        }

        return lines.join('\n')
      },
    })
  },
})