import { z } from 'zod'

export const SubjectSchema = z.string().min(1).max(200)
export const DescriptionSchema = z.string().max(2000).optional()
export const ActiveFormSchema = z.string().max(80).optional()
export const TaskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const TaskCreateInput = z.object({
  subject: SubjectSchema.describe('Short title of the task (1-200 chars).'),
  description: DescriptionSchema.describe('Optional longer description.'),
  activeForm: ActiveFormSchema.describe(
    'Optional present-tense label shown when in_progress (e.g. "Implementing feature").',
  ),
})

export const TaskGetInput = z.object({
  id: TaskIdSchema.describe('Task ID returned by TaskCreate or TaskList.'),
})

export const TaskUpdateInput = z.object({
  id: TaskIdSchema.describe('Task ID to update.'),
  status: TaskStatusSchema.optional().describe('New status.'),
  subject: SubjectSchema.optional().describe('Replace subject.'),
  description: DescriptionSchema.describe('Replace description.'),
  activeForm: ActiveFormSchema.describe('Replace activeForm.'),
})

export const TaskListInput = z.object({})