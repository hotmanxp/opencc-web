import type { Question } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'

/**
 * Compute the default answers that should be auto-submitted when the
 * AskUserQuestion idle timer fires. Skips questions the user already
 * answered, and excludes the synthetic `__other__` option from defaults
 * so the model sees an honest gap when no labelled option fits.
 *
 * Behavior:
 * - Single-select: first non-`__other__` option (or '' if none).
 * - Multi-select: all non-`__other__` option labels joined by ', '.
 *
 * @param questions       The questions in the current dialog.
 * @param existingAnswers The answers the user has already provided.
 * @returns A record of question-text -> label, ready to spread into the
 *          submit map.
 */
export function computeAutoContinueAnswers(
  questions: ReadonlyArray<Question>,
  existingAnswers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) {
    if (existingAnswers[q.question]) continue
    const eligible = q.options.filter(o => o.label !== '__other__')
    if (q.multiSelect) {
      out[q.question] = eligible.map(o => o.label).join(', ')
    } else {
      const first = eligible[0]
      out[q.question] = first?.label ?? ''
    }
  }
  return out
}
