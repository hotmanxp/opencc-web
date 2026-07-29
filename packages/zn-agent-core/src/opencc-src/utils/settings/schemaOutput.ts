import { toJSONSchema } from 'zod/v4'
import { jsonStringify } from '../slowOperations.ts'
import { SettingsSchema } from './types.ts'

export function generateSettingsJSONSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { unrepresentable: 'any' })
  return jsonStringify(jsonSchema, null, 2)
}
