export interface RenderArgs {
  body: string
  args: string
  argNames?: string[]
}

/**
 * Replace `$ARGUMENTS`, `$1..$n`, `${name}` tokens in `body` based on
 * whitespace-split `args` and optional `argNames` (positional mapping).
 * - `$ARGUMENTS` → full args string
 * - `$N` (1-indexed) → N-th whitespace token, or '' if missing
 * - `${name}` → if name appears in argNames, the corresponding positional token;
 *   otherwise literal text is preserved
 */
export function renderPrompt({ body, args, argNames }: RenderArgs): string {
  const tokens = args.trim() ? args.split(/\s+/) : []

  // Pre-compute argNames → positional index map (only for tokens present).
  // name → its positional value (or '' if missing).
  const nameValue = new Map<string, string>()
  if (argNames) {
    argNames.forEach((name, i) => {
      nameValue.set(name, tokens[i] ?? '')
    })
  }

  let out = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    // Escape: $$ means literal $.
    if (ch === '$' && body[i + 1] === '$') {
      out += '$$'
      i += 2
      continue
    }
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    // We're at a $. Try to match:
    //   $ARGUMENTS (rest of body until something un-$-compatible — but spec: case-sensitive literal)
    //   $N where N is digits
    //   ${name} where name is alpha-numeric + dash + underscore
    if (body.startsWith('$ARGUMENTS', i)) {
      out += args
      i += '$ARGUMENTS'.length
      continue
    }
    if (body[i + 1] !== undefined && /[0-9]/.test(body[i + 1]!)) {
      // parse number
      let j = i + 1
      while (j < body.length && /[0-9]/.test(body[j]!)) j++
      const idx = Number(body.slice(i + 1, j)) - 1
      out += tokens[idx] ?? ''
      i = j
      continue
    }
    if (body[i + 1] === '{') {
      const end = body.indexOf('}', i + 2)
      if (end > i + 2) {
        const name = body.slice(i + 2, end)
        if (nameValue.has(name)) {
          out += nameValue.get(name)!
          i = end + 1
          continue
        }
        // unknown name → preserve literal
        out += body.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    // Unrecognized $X → keep literal
    out += ch
    i++
  }
  return out
}