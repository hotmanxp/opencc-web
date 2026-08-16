import type { McpbManifest } from '@anthropic-ai/mcpb'
import { errorMessage } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

/**
 * Parses and validates a DXT manifest from a JSON object.
 *
 * Lazy-imports @anthropic-ai/mcpb: that package uses zod v3 which eagerly
 * creates 24 .bind(this) closures per schema instance (~300 instances between
 * schemas.js and schemas-loose.js). Deferring the import keeps ~700KB of bound
 * closures out of the startup heap for sessions that never touch .dxt/.mcpb.
 */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  // The installed @anthropic-ai/mcpb package doesn't export the schema from
  // its entry (internal schemas/* are not re-exported), so reach it through
  // the module object.
  const mcpbMod = (await import('@anthropic-ai/mcpb')) as {
    McpbManifestSchema: { safeParse(input: unknown): unknown }
  }
  const McpbManifestSchema = mcpbMod.McpbManifestSchema
  const parseResult = McpbManifestSchema.safeParse(manifestJson) as {
    success: boolean
    error?: { flatten(): unknown }
    data?: McpbManifest
  }

  if (!parseResult.success) {
    // error exists when success is false; flatten's shape is zod's standard
    // { fieldErrors: Record<string, string[]>, formErrors: string[] }.
    const errors = parseResult.error!.flatten() as {
      fieldErrors: Record<string, unknown[]>
      formErrors: unknown[]
    }
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) => `${field}: ${errs?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    throw new Error(`Invalid manifest: ${errorMessages}`)
  }

  // @ts-ignore - data exists when success is true
  return parseResult.data
}

/**
 * Parses and validates a DXT manifest from raw text data.
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown

  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }

  return validateManifest(manifestJson)
}

/**
 * Parses and validates a DXT manifest from raw binary data.
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}

/**
 * Generates an extension ID from author name and extension name.
 * Uses the same algorithm as the directory backend for consistency.
 */
export function generateExtensionId(
  manifest: McpbManifest,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  // @ts-ignore - manifest.author is unknown
  const authorName = manifest.author.name
  const extensionName = manifest.name

  // @ts-ignore - manifest properties are unknown
  const sanitizedAuthor = sanitize(authorName)
  // @ts-ignore - manifest properties are unknown
  const sanitizedName = sanitize(extensionName)

  return prefix
    ? `${prefix}.${sanitizedAuthor}.${sanitizedName}`
    : `${sanitizedAuthor}.${sanitizedName}`
}
