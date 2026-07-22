// Mirror of AskUserQuestionTool/prompt.ts. These constants are the single
// source of truth for the tool name + description injected into the system
// prompt. The runtime resolves the tool by name, so changing this string is
// a breaking change for any model that has already tool-call-trained on it.

export const REQUEST_APPROVE_TOOL_NAME = 'RequestApprove'

export const DESCRIPTION = `Use this tool to gate the agent loop on a human review of a document you've produced (plan, spec, design doc, proposal, RFC, contract, etc.). The user will see the document rendered as markdown in a right-side drawer with three controls: Approve, Reject (with required comment), and an optional overall comment.`

export const REQUEST_APPROVE_TOOL_PROMPT = `Use this tool to gate the agent loop on a human review of a document you've produced (plan, spec, design doc, proposal, RFC, contract, etc.). The user will see the document rendered as markdown in a right-side drawer with three controls: Approve, Reject (with required comment), and an optional overall comment.

Use inline markdown for short documents (≤ a few thousand words). For long specs, write the document to a workspace file first (using the Write tool) and pass body.kind: 'file' with the relative path. Do NOT use this tool for short clarifying questions (use AskUserQuestion instead).`
