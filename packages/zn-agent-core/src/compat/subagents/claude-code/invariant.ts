/**
 * Pinned constants for Claude Code CLI verification.
 *
 * Unlike Codex, the Claude CLI is a fully self-contained binary on PATH
 * (no separate `app-server` process) — so there's no protocol version to
 * pin. This file currently holds only what's needed for one-shot logging
 * and ops diagnostics.
 */

import { failCodex as failClaude } from '../codex/invariant.js'

/** Default grace for kill-tree escalation; mirrors codex provider. */
export const MAX_AGENT_MESSAGE_BYTES = 4 * 1024 * 1024

/** Throw an Error annotated with a stable `code`; re-exported as
 * `failClaude` so the codebase can keep `codex:`/`claude-code:` prefixes
 * distinct in stack traces.
 */
export const failClaudeCode: (reason: string, hint?: string) => Error = failClaude
