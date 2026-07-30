export interface HandoffEntry {
  basename: string
  fullPath: string
  mtime: string // human-readable, e.g. "2026-06-07 14:30"
}

export interface PickupPromptInput {
  pickPath: string | null // user explicitly provided --pick (skip listing)
  pickContent: string | null
  errorNote: string | null
  cwd: string
  root: string
  recent: HandoffEntry[] // newest first, up to 5 entries
  userOptionCount: number // how many of the recent to surface as AskUserQuestion options
}

export async function renderPickupPrompt(
  input: PickupPromptInput,
): Promise<string> {
  const { pickPath, pickContent, errorNote, cwd, recent } = input

  // 1. Listing block — adapt to count.
  //    - 0 handoffs: error (no listing)
  //    - 1 handoff:  tell LLM to ask in plain text (AskUserQuestion requires
  //                 min 2 options; can't pad with "Other" since the tool
  //                 auto-adds it but the schema's min(2) is on YOUR options)
  //    - 2+ handoffs: use AskUserQuestion with the explicit JSON shape
  const listingBlock = recent.length
    ? recent.length === 1
      ? `## Only one handoff found

The only handoff document in \`${input.root}\` is:

- **${recent[0]!.basename}** — _${recent[0]!.mtime}_\n  → full path: \`${recent[0]!.fullPath}\`

Ask the user in plain text whether to resume it (e.g. "Found 1 handoff document \`${recent[0]!.basename}\` (${recent[0]!.mtime}). Resume it?"). Do **not** use AskUserQuestion for this — the tool requires at least 2 explicit options but we only have 1 handoff.
After the user confirms, use the **Read** tool on the full path to load it.
`
      : `## Recent handoff documents (newest first)

Found ${recent.length} handoff file(s) in \`${input.root}\`:

${recent
  .map(
    (h, i) =>
      `${i + 1}. **${h.basename}** — _${h.mtime}_\n   → full path: \`${h.fullPath}\``,
  )
  .join('\n\n')}

Use **AskUserQuestion** to ask the user which handoff to resume. Call it with **exactly this shape** (replace the placeholders per option):

\`\`\`json
{
  "questions": [{
    "question": "Which handoff do you want to resume?",
    "header": "Resume",
    "multiSelect": false,
    "options": [
      { "label": "<basename>", "description": "<mtime> — <full path>" },
      ...up to ${input.userOptionCount} options
    ]
  }]
}
\`\`\`

You MUST provide **2 to 4** explicit options (the tool schema rejects fewer than 2). Surface the **top ${input.userOptionCount}** from the list above as options.${
        recent.length > input.userOptionCount
          ? ` The other ${recent.length - input.userOptionCount} entr${recent.length - input.userOptionCount === 1 ? 'y is' : 'ies are'} provided as context but should NOT be shown as options.`
          : ''
      } After the user chooses, use the **Read** tool on the chosen file's full path to load it in full.
`
    : `## No handoff documents found

Directory \`${input.root}\` is empty (or does not exist).
`

  // 2. Explicit --pick block — user told us which file, no need to ask
  const explicitPickBlock =
    pickPath && !errorNote
      ? `## User explicitly selected

Path: \`${pickPath}\`

Read it with the **Read** tool to begin resuming.

\`\`\`markdown
${pickContent ?? '(failed to read)'}
\`\`\`
`
      : ''

  // 3. Error/warning block — prepended if --pick failed or no handoffs
  const warningBlock = errorNote
    ? `## ⚠️ Warning

${errorNote}

Use **AskUserQuestion** to ask the user for the actual handoff file path (could be from another project, copied elsewhere, or hand-written), or instruct them to run /handoff in another session to generate one.
`
    : ''

  return `# Task: Resume from a handoff document

${warningBlock}${listingBlock}${explicitPickBlock}## After loading the handoff (via Read tool)

1. **Re-activate the previously useful skills** — scan the doc's \`## Skills Used\` section and re-invoke each listed skill with the **Skill** tool (e.g. \`Skill(skill: "commit", ...)\`). Skills don't persist across sessions; without re-invoking them, the next-step guidance from each skill is missing.
2. **Restore the TaskList using TaskCreate / TaskUpdate**
3. **Verify cwd, dependencies, and intermediate artifacts are in place**
4. **Tell the user:** "Resumed \`<task>\`. Current progress: X. Next step: Y. Continue?"

## cwd

\`\`\`
${cwd}
\`\`\`
`
}
