import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

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
  }),
)

export type ModManifest = z.infer<ReturnType<typeof ModManifestSchema>>
