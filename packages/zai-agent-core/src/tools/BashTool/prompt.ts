export function renderPrompt(): string {
  return `Executes a shell command in a sandboxed child process.

  Args:
    - command: The shell command to run (passed to sh -c)
    - description: Optional human-readable description
    - timeout: Milliseconds before SIGTERM (default 600_000, max 600_000)
    - run_in_background: If true, returns taskId immediately and runs async

  Output: <stdout>...</stdout>\\n<stderr>...</stderr>\\nexit code: N

  Constraints:
    - Command runs in sandbox.workdir
    - Environment restricted to sandbox.envAllowlist
    - Stdout+stderr capped at 10 MB; longer output truncated

  This tool is NOT concurrency safe and IS destructive by default.`
}
