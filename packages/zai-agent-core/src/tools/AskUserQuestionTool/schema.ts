import { z } from 'zod'
import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH } from './prompt.js'

export const questionOptionSchema = z.object({
  label: z.string()
    .describe('The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.'),
  description: z.string()
    .describe('Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.'),
  preview: z.string().optional()
    .describe('Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons.'),
})

export const questionSchema = z.object({
  question: z.string(),
  header: z.string().max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH),
  options: z.array(questionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
})

// 值类型: 每个 question 一条 annotation
const annotationSchema = z.object({
  preview: z.string().optional(),
  notes: z.string().optional(),
})
// 整个 record 可选 (没填 notes/preview 就不输出)
export const annotationsSchema = z.record(z.string(), annotationSchema).optional()

export const inputSchema = z.strictObject({
  questions: z.array(questionSchema).min(1).max(6),
  answers: z.record(z.string(), z.string()).optional(),
  annotations: annotationsSchema,
  metadata: z.object({ source: z.string().optional() }).optional(),
}).refine(
  (data) => {
    const qs = data.questions.map(q => q.question)
    if (qs.length !== new Set(qs).size) return false
    for (const q of data.questions) {
      const labels = q.options.map(o => o.label)
      if (labels.length !== new Set(labels).size) return false
    }
    return true
  },
  { message: 'Question texts must be unique, option labels must be unique within each question' }
)

export const outputSchema = z.object({
  questions: z.array(questionSchema),
  answers: z.record(z.string(), z.string()),
  annotations: annotationsSchema,
})

export type Question = z.infer<typeof questionSchema>
export type QuestionOption = z.infer<typeof questionOptionSchema>
export type Output = z.infer<typeof outputSchema>
