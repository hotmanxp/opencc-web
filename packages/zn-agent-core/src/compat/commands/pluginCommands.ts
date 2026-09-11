// @zn-ai/zn-agent-core compat shim — plugin command channel.
//
// zai patch (2026-09-10, tf-mynh1twy): expose the vendor plugin-command
// loader through a compat-typed channel so zai's registry fill site can
// register `source === 'plugin'` commands into the compat command registry
// (userLoader only registers builtin + user). The vendor module
// (`opencc-src/utils/plugins/loadPluginCommands.ts`) is excluded from tsc,
// so its import resolves as `any`; we cast to the compat `Command[]` shape
// here so the emitted `dist/compat/commands/pluginCommands.d.ts` stays
// self-contained (only references `./types.js`).
//
// Output shape is unchanged from the vendor loader: each command carries
// `name` (`pluginName[:namespace:]command`), `description`,
// `source === 'plugin'`, and `pluginInfo.pluginManifest.name` — the fields
// slashList.ts uses to render `(pluginName)` and strip the prefix for
// `displayName`.

import { getPluginCommands } from '../../opencc-src/utils/plugins/loadPluginCommands.js'
import type { Command } from './types.js'

/**
 * Return the plugin markdown commands the vendor loader has already memoized
 * (typed as compat `Command`). Callers must not mutate the returned array —
 * it is the vendor's shared memoized list.
 */
export async function getLoadedPluginCommands(): Promise<Command[]> {
  const cmds = await getPluginCommands()
  return cmds as unknown as Command[]
}
