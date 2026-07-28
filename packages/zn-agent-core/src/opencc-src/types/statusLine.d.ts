// Status line command input type
export type StatusLineCommandInput = {
  session_id?: string
  cwd?: string
  branch?: string
  model?: string
  goal?: {
    condition: string
    status: string
    round_count: number
    max_rounds: number | null
    duration_seconds: number
  }
  [key: string]: unknown
}