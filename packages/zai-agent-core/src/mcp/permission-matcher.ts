export type ToolRule = string | { pattern: string; action?: 'allow' | 'deny' }

export function matchToolName(rule: ToolRule, name: string): boolean {
  if (typeof rule === 'string') return rule === name
  const regex = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return regex.test(name)
}
