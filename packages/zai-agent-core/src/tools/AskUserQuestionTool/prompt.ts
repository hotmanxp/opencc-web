export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 32

export const DESCRIPTION = `Use this tool when you need to ask the user clarifying questions before proceeding with a task. The user will see your questions rendered as a multi-select form and submit their answers.`

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool to ask the user clarifying questions before proceeding.

Each question should:
- Be a single, focused decision the user can answer
- Have 2-4 mutually exclusive options (use multiSelect:true if not exclusive)
- Have a short header (max 32 chars) used as a chip label
- Optionally include a preview field on options for mockups / code snippets

Do not include an "Other" option — the UI adds one automatically. Do not ask more than 6 questions per call.`
