import type { Tool, ToolCallCtx } from '../runtime/modelCaller.js'
import { z } from 'zod'

type ToolWithCall = Tool & {
  call: (args: unknown, ctx: unknown) => Promise<{ output: string }>
}

export function makeTool<T>(spec: {
  name: string
  description: string
  inputSchema: z.ZodType<T>
  executor: (args: T, ctx: ToolCallCtx) => Promise<{ output: string }>
}): ToolWithCall {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async call(args: unknown, ctx: unknown) {
      const parsed = spec.inputSchema.safeParse(args)
      if (!parsed.success) {
        return {
          output: `[error] invalid input for ${spec.name}: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        }
      }
      const ctxObj = (ctx ?? { cwd: process.cwd() }) as ToolCallCtx
      if (!ctxObj.cwd) ctxObj.cwd = process.cwd()
      return spec.executor(parsed.data, ctxObj)
    },
  }
}
