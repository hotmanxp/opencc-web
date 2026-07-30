import type { z } from 'zod/v4'
import type { AnyObject, Tool, ToolUseContext } from '../Tool.js'
import { getEmptyToolPermissionContext } from '../Tool.js'

export interface ToolFixtureOverrides<I extends z.ZodTypeAny> {
  name: string
  description?: string
  call?: (
    args: z.infer<I>,
    context: ToolUseContext,
  ) => Promise<{ data: unknown }>
  interruptBehavior?: () => 'cancel' | 'block'
  isReadOnly?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: () => boolean
  getPath?: (input: z.infer<I>) => string
}

export function createToolFixture<I extends z.ZodTypeAny>(
  inputSchema: I,
  overrides: ToolFixtureOverrides<I>,
): Tool<AnyObject, unknown> {
  const name = overrides.name
  return {
    name,
    aliases: undefined,
    inputSchema,
    description: async () => overrides.description ?? `Mock tool ${name}`,
    call: async (args, context) => {
      if (overrides.call) {
        const result = await overrides.call(args, context)
        return { data: result.data as never }
      }
      return { data: 'ok' as never }
    },
    isConcurrencySafe: overrides.isConcurrencySafe ?? (() => true),
    isReadOnly: overrides.isReadOnly ?? (() => true),
    isEnabled: overrides.isEnabled ?? (() => true),
    isDestructive: () => false,
    interruptBehavior: overrides.interruptBehavior,
    checkPermissions: async () => null,
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    getToolPermissionContext: () => getEmptyToolPermissionContext(),
    toAPISchema: () => ({ name, description: '', input_schema: { type: 'object', properties: {} } }),
    ...(overrides.getPath ? { getPath: overrides.getPath } : {}),
  } as unknown as Tool<AnyObject, unknown>
}