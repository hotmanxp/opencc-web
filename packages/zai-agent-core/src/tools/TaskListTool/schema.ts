import { z } from 'zod'

export const TaskListInputSchema = z.object({}).strict()

export type TaskListInput = z.infer<typeof TaskListInputSchema>