import { readFile, writeFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { Tool, ToolContext } from '../Tool.js'
import { FileEditInputSchema, type FileEditInput } from './schema.js'
import { renderPrompt } from './prompt.js'

export const FileEditTool: Tool<typeof FileEditInputSchema, string> = {
  name: 'Edit',
  description: renderPrompt(),
  inputSchema: FileEditInputSchema,
  isDestructive: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as FileEditInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return { output: `File not found: ${absPath}`, isError: true }
      return { output: `Failed to read ${absPath}: ${err.message}`, isError: true }
    }

    const occurrences = content.split(input.old_string).length - 1
    if (occurrences === 0) {
      return { output: `old_string not found in ${absPath}. Re-read the file to get current contents.`, isError: true }
    }
    if (occurrences > 1 && !input.replace_all) {
      return { output: `old_string is not unique (${occurrences} matches) in ${absPath}. Add more context or set replace_all=true.`, isError: true }
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string)

    try {
      await writeFile(absPath, updated, 'utf-8')
    } catch (e) {
      return { output: `Failed to write ${absPath}: ${(e as Error).message}`, isError: true }
    }
    const replaced = input.replace_all ? occurrences : 1
    return { output: `Replaced ${replaced} occurrence(s) in ${absPath}` }
  },
}
