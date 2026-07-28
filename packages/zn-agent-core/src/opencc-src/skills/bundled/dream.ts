// The dream command is registered via COMMANDS() in src/commands.ts.
// This bundled skill registration is a no-op to satisfy the require in
// src/skills/bundled/index.ts and prevent the missing-module stub from
// being applied to src/commands/dream/index.ts's import of ./dream.js.
export function registerDreamSkill(): void {
  // No-op: dream is already registered as a command via COMMANDS().
  // This function exists solely to prevent the build system from stubbing
  // out ./dream.js globally, which would break the actual dream command
  // in src/commands/dream/dream.ts.
}
