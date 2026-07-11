export function substituteArguments(
  body: string,
  args: string,
  quoted: boolean,
  argNames: string[] = [],
): string {
  if (!args && argNames.length === 0) return body

  const tokens = args ? splitArgs(args, quoted) : []
  let out = body
  out = out.replace(/\$ARGUMENTS/g, args)
  out = out.replace(/\$@/g, args)
  for (let i = 0; i < tokens.length; i++) {
    out = out.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), tokens[i]!)
  }
  for (const name of argNames) {
    out = out.replace(new RegExp(`\\$${name}\\b`, 'g'), args)
  }
  return out
}

function splitArgs(args: string, quoted: boolean): string[] {
  if (!quoted) return args.split(/\s+/).filter(Boolean)
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}
