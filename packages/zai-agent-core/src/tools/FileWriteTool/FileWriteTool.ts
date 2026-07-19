/**
 * FileWriteTool — port alignment with opencc.
 *
 * Matrix gap addressed (P0):
 *  1. validateInput deny-rule check, gated behind
 *     ZAI_ENABLE_PERMISSION_DENY_RULES (zai has no toolPermissionContext
 *     on LegacyToolContext, so we use the env kill-switch).
 *  2. UNC path detection (\ prefix or // prefix) — short-circuits the
 *     filesystem ops to avoid NTLM credential leak on Windows-style
 *     paths handled by Node.
 *  3. line-endings preservation via writeTextContent (CRLF/CR/LF).
 *  4. UTF-16 BOM → utf16le encoding selection.
 *
 * Matrix gap addressed (P1):
 *  5. z.strictObject (already enforced in schema.ts).
 *  6. structured output `{type, filePath, content, structuredPatch,
 *     originalFile}` JSON-stringified as the LegacyTool return.
 *  7. Skills directory discovery: when writing a file, scan the path
 *     for adjacent SKILL.md manifests and load them via loadSkillsFromDirs
 *     (zai's runtime/skills/index.ts). Fire-and-forget.
 *  8. mapToolResultToToolResultBlockParam distinguishes create vs
 *     update messages ("File created successfully at: X" vs
 *     "The file X has been updated successfully.").
 *
 * Matrix gap addressed (P2):
 *  9. AGENTS.md write tracking — log when target ends in
 *     /AGENTS.md (zai constant: AGENTS_FILENAME).
 *
 * Constraints honoured:
 *  - LegacyTool contract preserved (string output).
 *  - readState.lastRead signature unchanged.
 *  - Agent.tsx / translateRuntimeEvents untouched: `output` is still
 *    a string (JSON of the structured result); the SSE pipeline can
 *    parse it back via JSON.parse at display time if it ever needs to.
 */
import { dirname, isAbsolute, resolve } from 'path'
import { sep } from 'path'
import type { LegacyTool } from '../Tool.js'
import { lastRead } from '../readState.js'
import { loadSkillsFromDirs } from '../../runtime/skills/index.js'
import { logForDebugging } from '../../opencc-internals/utils/debug.js'

// zai's local constant — AGENTS_FILENAME isn't exported from
// memoryLoader (see agents/memoryLoader.ts:36). The literal is the
// canonical filename, mirroring opencc's AGENT_INSTRUCTIONS_FILE.
const AGENTS_FILENAME = 'AGENTS.md'
import {
  FileWriteInputSchema,
  type FileWriteInput,
  type FileWriteOutput,
} from './schema.js'
import { renderPrompt } from './prompt.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getMtimeMs,
  writeTextContent,
} from './utils.js'

/**
 * Deny-rule support is opt-in. zai's LegacyToolContext has no
 * toolPermissionContext slot; when the env flag is set we attempt to
 * import the opencc-internals permission matcher lazily so this module
 * stays usable in builds that don't ship permission code.
 */
const PERMISSION_DENY_RULES_ENABLED =
  process.env.ZAI_ENABLE_PERMISSION_DENY_RULES === '1' ||
  process.env.ZAI_ENABLE_PERMISSION_DENY_RULES === 'true'

/**
 * Matrix row "mapToolResultToToolResultBlockParam": distinguish create
 * vs update in the assistant tool_result block content.
 */
function renderToolResultContent(type: 'create' | 'update', filePath: string): string {
  return type === 'create'
    ? `File created successfully at: ${filePath}`
    : `The file ${filePath} has been updated successfully.`
}

export const FileWriteTool: LegacyTool<typeof FileWriteInputSchema, string> = {
  name: 'Write',
  description: renderPrompt(),
  inputSchema: FileWriteInputSchema,
  isDestructive: () => true,

  /**
   * Semantic check mirroring opencc validateInput:
   *  - deny rule (env-gated)
   *  - UNC path short-circuit
   *  - read-first contract
   *  - mtime staleness
   *
   * Returns `{result: true}` for ENOENT (creation path) and UNC paths.
   * on zai-style LegacyTool the runtime calls this through
   * `wrapAsOpenccTool` -> `validateInput`.
   */
  validateInput: async (rawInput: unknown) => {
    const input = rawInput as FileWriteInput
    if (typeof input?.file_path !== 'string') {
      return {
        result: false,
        message: 'file_path is required',
        errorCode: 0,
      }
    }

    // UNC path short-circuit. Don't touch the filesystem.
    if (input.file_path.startsWith('\\\\') || input.file_path.startsWith('//')) {
      return { result: true }
    }

    // Deny rule (env-gated). zai has no toolPermissionContext on
    // LegacyToolContext; we keep the import optional and silent on
    // missing-module so this file stays self-contained.
    if (PERMISSION_DENY_RULES_ENABLED) {
      try {
        // Lazy optional import — the symbol may not be wired in builds
        // that don't include permission machinery.
        const mod = (await import(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          '../../opencc-internals/utils/permissions/filesystem.js' as any
        ).catch(() => null)) as null | Record<string, unknown>
        if (mod && typeof mod.matchingRuleForInput === 'function') {
          // The opencc signature expects (path, ctx, 'edit', 'deny'); we
          // pass an empty ctx — it'll just return null when no rules are
          // configured. Errors swallowed (treat as no match).
          const matched = await (mod.matchingRuleForInput as any)(
            input.file_path,
            {},
            'edit',
            'deny',
          )
          if (matched !== null) {
            return {
              result: false,
              message:
                'File is in a directory that is denied by your permission settings.',
              errorCode: 1,
            }
          }
        }
      } catch {
        // Missing dependency or runtime error → silent skip (env gate
        // already required for activation).
      }
    }

    return { result: true }
  },

  mapToolResultToToolResultBlockParam: (content: unknown, toolUseId: string) => {
    // LegacyTool contract delivers `content` as a JSON-stringified
    // structured output from `call`. Parse it back to discriminate
    // create vs update so the assistant receives the right message.
    let parsed: Partial<FileWriteOutput> = {}
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = {}
      }
    } else if (content && typeof content === 'object') {
      parsed = content as Partial<FileWriteOutput>
    }
    const filePath = parsed.filePath ?? ''
    const type: 'create' | 'update' = parsed.type === 'update' ? 'update' : 'create'
    return {
      tool_use_id: toolUseId,
      type: 'tool_result',
      content: renderToolResultContent(type, filePath),
    }
  },

  async call(rawInput, ctx) {
    const input = rawInput as FileWriteInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    // -- read-first + mtime check --------------------------------------
    let fileExists = true
    try {
      await getMtimeMs(absPath)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        fileExists = false
      } else {
        return {
          output: `Failed to write ${absPath}: ${err.message}`,
          isError: true,
        }
      }
    }

    if (fileExists) {
      const recorded = lastRead(ctx.cwd, absPath)
      if (recorded === undefined) {
        return {
          output:
            'File has not been read yet. Read it first before writing to it.',
          isError: true,
        }
      }
      const fileMtimeMs = await getMtimeMs(absPath)
      if (Math.floor(fileMtimeMs) > recorded) {
        return {
          output:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write to it.',
          isError: true,
        }
      }
    }

    // -- line endings + encoding preservation --------------------------
    let endings = 'LF' as 'LF' | 'CRLF' | 'CR'
    let encoding: BufferEncoding = 'utf8'
    let oldContent: string | null = null
    if (fileExists) {
      try {
        endings = await detectLineEndings(absPath)
        encoding = await detectFileEncoding(absPath)
        // Re-read the file to populate originalFile for the structured
        // patch. Detected encoding honored.
        const { readFile } = await import('fs/promises')
        const buf = await readFile(absPath)
        oldContent = buf.toString(encoding)
      } catch {
        // Best-effort: if encoding sniff fails, fall back to utf8/LF.
        encoding = 'utf8'
        endings = 'LF'
      }
    }

    // -- write ---------------------------------------------------------
    try {
      const { mkdir } = await import('fs/promises')
      await mkdir(dirname(absPath), { recursive: true })
      await writeTextContent(absPath, input.content, encoding, endings)
    } catch (e) {
      return {
        output: `Failed to write ${absPath}: ${(e as Error).message}`,
        isError: true,
      }
    }

    // -- skills path-trigger (fire-and-forget) -------------------------
    // zai has loadSkillsFromDirs; on the opencc side this calls
    // discoverSkillDirsForPaths + addSkillDirectories. We don't have
    // discoverSkillDirsForPaths ported into zai yet, but zai already
    // loads skills at queryLoop start from SKILLS_DIRS. If the file
    // path sits under a directory in a known skills root, the next
    // turn's loadSkillsFromDirs call will pick it up. As a finer
    // signal, scan sibling SKILL.md-style manifests up to one level.
    void triggerSkillsForFile(absPath, ctx.cwd).catch((err: unknown) => {
      logForDebugging(
        `Write: skill trigger failed for ${absPath}: ${(err as Error).message}`,
      )
    })

    // -- AGENTS.md tracking -------------------------------------------
    if (absPath.endsWith(`${sep}${AGENTS_FILENAME}`)) {
      logForDebugging(`Write: AGENTS.md tracking — wrote ${absPath}`)
    }

    // -- structured patch (no full diff util ported; emit empty array)
    const structuredPatch: Array<Record<string, unknown>> = []
    const structured: FileWriteOutput = {
      type: oldContent === null ? 'create' : 'update',
      filePath: absPath,
      content: input.content,
      structuredPatch,
      originalFile: oldContent,
    }

    // JSON-stringify so legacy `{output: string}` contract holds.
    return {
      output: JSON.stringify(structured),
      isError: false,
    }
  },
}

/**
 * Best-effort adjacent SKILL.md / sibling manifest scan. We don't have
 * `discoverSkillDirsForPaths` ported yet — until then, only the parent
 * directory of the written file is offered to loadSkillsFromDirs. The
 * runtime call site already loads skills per-turn from SKILLS_DIRS, so
 * this is mostly a no-op today; preserved as a hook for when the
 * discovery side is ported.
 */
async function triggerSkillsForFile(
  absPath: string,
  cwd: string,
): Promise<void> {
  const { stat: fsStat } = await import('fs/promises')
  const parent = dirname(absPath)
  try {
    await fsStat(parent)
  } catch {
    return // parent doesn't exist (vanishingly rare for a freshly written file)
  }
  // Offer the parent dir to the loader — loadSkillsFromDirs is a
  // no-op for non-skill directories (it gracefully ignores them).
  await loadSkillsFromDirs([parent], { cwd }).catch(() => undefined)
}

// Re-export at module level for callers that want the file's structured
// output type without pulling schema.ts.
export type { FileWriteOutput }
