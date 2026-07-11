export function renderPrompt(): string {
  return `Invoke a skill by name. The skill body is injected as a user message for the current session.

Args:
  - name: The skill name as listed in the <skills> block of the system prompt
  - args: Optional argument string to substitute into the skill body

The skill's full markdown body becomes available to you after invocation. Invoke a skill only when its description matches the user's request.`
}
