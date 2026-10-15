/**
 * Regression: `prependUserContext` went async during the mods sync
 * (2026-10-12), because upstream dispatches `prompt.context` inside it. Both
 * vendor call sites kept using it synchronously, so the model request went out
 * carrying `messages: Promise<Message[]>` instead of the transcript, and every
 * turn came back
 *
 *     400 invalid params, messages must not be empty (2013)
 *
 * Nothing caught it. `utils/messages.ts` carries `@ts-nocheck`, and a Promise
 * standing in for `Message[]` does not fail at any boundary that can see it —
 * it fails when the request reaches the provider. tsc was green, 1323 tests
 * were green, and the build was green.
 *
 * So the guard here is STATIC and reads every call site. The bug was a caller
 * forgetting `await`; only a check that looks at how each caller uses the
 * value can catch that one. A runtime assertion on `prependUserContext` alone
 * would only prove the function resolves — it passed while the product was
 * broken.
 *
 * Should another vendor function be made async, add it to ASYNC_EXPORTS below
 * in the same commit that changes its signature. Every other signature change
 * in the mods sync (resolveSystemPromptSections stays async,
 * normalizeAttachmentForAPI stays sync, getAttributionTexts stays sync) was
 * paired with its callers correctly; this one was not.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const OPENCC_SRC_DIR = join(__dirname, '../../src/opencc-src')

/**
 * Vendor functions whose declaration is `async`. A call site that consumes one
 * of these without `await` hands a Promise to whatever wanted the value, which
 * is the failure this file exists to prevent.
 */
const ASYNC_EXPORTS = ['prependUserContext'] as const

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** A call site is safe only when the identifier is directly `await`ed. */
function findUnawaitedCallSites(
  files: string[],
  fnName: string,
): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')
    lines.forEach((text, i) => {
      // Only a real invocation, so the import statement and the prose in
      // doc comments are not mistaken for call sites.
      const call = new RegExp(`(?<![\\w$.])${fnName}\\(`)
      if (!call.test(text)) return
      // The declaration itself is not a call site.
      if (new RegExp(`function\\s+${fnName}\\s*\\(`).test(text)) return
      // `await fn(` — allow whitespace/newline between them.
      if (new RegExp(`await\\s+${fnName}\\s*\\(`).test(text)) return
      hits.push({ file, line: i + 1, text: text.trim() })
    })
  }
  return hits
}

describe('async vendor call sites', () => {
  const files = collectSourceFiles(OPENCC_SRC_DIR)

  it('finds the vendor source tree', () => {
    // A silently empty file list would make every assertion below vacuously
    // pass, which is how a guard rots.
    expect(files.length).toBeGreaterThan(100)
  })

  for (const fnName of ASYNC_EXPORTS) {
    it(`every call site of ${fnName}() awaits it`, () => {
      const hits = findUnawaitedCallSites(files, fnName)
      expect(
        hits,
        `These call sites consume the async ${fnName}() without awaiting, so ` +
          `they pass a Promise where the resolved value is expected:\n` +
          hits.map(h => `  ${h.file}:${h.line}  ${h.text}`).join('\n'),
      ).toEqual([])
    })
  }

  it('declares each guarded export as async', () => {
    // Pins the premise of the guard. If someone drops the `async` keyword and
    // fixes the callers in the same commit, this fails and points at the list
    // above so the entry can be retired deliberately rather than silently.
    for (const fnName of ASYNC_EXPORTS) {
      const declaring = files.filter(f =>
        new RegExp(`export\\s+async\\s+function\\s+${fnName}\\s*\\(`).test(
          readFileSync(f, 'utf8'),
        ),
      )
      expect(
        declaring.length,
        `${fnName}() is no longer declared async — update ASYNC_EXPORTS.`,
      ).toBeGreaterThan(0)
    }
  })
})
