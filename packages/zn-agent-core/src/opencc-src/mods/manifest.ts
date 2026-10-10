import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { PluginManifestUserConfigSchema } from '../utils/plugins/schemas.js'

/**
 * Mod manifest (`opencc-mod.json`) schema.
 *
 * Mods are user-authored JavaScript packages that extend OpenCC's behavior,
 * tools and UI at runtime (see docs/mods-plan.md §3.3/§3.4). The manifest is
 * intentionally minimal — everything else is declared programmatically via
 * `register(ctx)`.
 *
 * Zod mirrors the PluginManifestSchema style (src/utils/plugins/schemas.ts).
 * Note: `zod` is currently a phantom dependency (present via transitive
 * resolution, not declared in package.json) — see docs/mods-plan.md §3.4.
 */
export const MOD_MANIFEST_FILE = 'opencc-mod.json'

export const ModManifestSchema = lazySchema(() =>
  z.object({
    /** Mod identifier. Used in tool/command prefixes and error attribution. */
    name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9_-]{0,63}$/,
        'mod name must be 1-64 chars of [a-z0-9_-], starting with [a-z0-9]',
      ),
    version: z.string().optional(),
    description: z.string().optional(),
    /**
     * Entry file relative to the mod root, e.g. "./mods/register.js".
     * Must be a relative path pointing at a `.js`/`.mjs` file inside the
     * mod root (enforced by validate.ts).
     */
    entry: z
      .string()
      .regex(/^\.{1,2}\//, 'entry must be a relative path starting with ./'),
    /**
     * 用户可配置项。由插件列表的「Configure options」渲染,mod 通过
     * `ctx.options` 读取。
     *
     * zai patch (2026-10-10, mods 同步):与插件 manifest 的 `userConfig`
     * 同键名同 schema —— 这是刻意的,不是命名巧合:让 mod 原样复用插件的
     * 配置存储、校验与对话框,并且 mod 的 manifest 对写过插件的人可读。
     */
    userConfig: PluginManifestUserConfigSchema().shape.userConfig,
  }),
)

export type ModManifest = z.infer<ReturnType<typeof ModManifestSchema>>
