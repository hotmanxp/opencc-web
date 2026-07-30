// src/utils/processUserInput/processStackedSkillInvocation.ts

import type { Command } from '../../types/command.js';

export const STACKED_SKILL_LIMIT = 5;

export interface SplitStackedSkillInvocationInput {
  primaryCommandName: string;
  primaryArgs: string;
  resolveCommand: (name: string) => Command | undefined;
}

export interface SplitStackedSkillInvocationResult {
  commands: Command[];
  trailingArgs: string;
  capped: boolean;
}

/**
 * Splits a slash-command invocation into a leading stack of commands plus a
 * trailing args tail. Tokenises the input `/${primaryCommandName} ${primaryArgs}`
 * from the start, advancing past leading `/foo` tokens. A token is consumed only
 * if `resolveCommand` returns a non-undefined Command; the loop otherwise breaks.
 *
 * Mirrors upstream `getMessagesForSlashCommand` stack expansion in v2.1.201
 * (constant `JBl=5`). The hard cap is exactly STACKED_SKILL_LIMIT.
 *
 * Behaviour:
 *   - `/foo bar baz`         → commands=[foo], trailingArgs="bar baz"  (single)
 *   - `/foo /bar baz`        → commands=[foo, bar], trailingArgs="baz"
 *   - `/foo /unknown /bar`   → commands=[foo], trailingArgs="/unknown /bar"
 *   - `/a /b /c /d /e /f x`  → commands=[a..e], trailingArgs="/f x", capped=true
 */
export function splitStackedSkillInvocation(
  input: SplitStackedSkillInvocationInput,
): SplitStackedSkillInvocationResult {
  const commands: Command[] = [];
  // Reconstruct the raw invocation: `/${primary} ${args}` minus empty fragments.
  const reconstructed = ['/' + input.primaryCommandName, input.primaryArgs]
    .filter((s) => s.length > 0)
    .join(' ')
    .trimStart();
  let remaining = reconstructed;
  let capped = false;

  // Check if the primary resolves; if not, the whole invocation is unparseable
  // as a stacked skill and falls through to raw args.
  const primaryMatch = /^\/(\S+)/.exec(remaining);
  if (!primaryMatch) {
    return { commands: [], trailingArgs: input.primaryArgs, capped: false };
  }
  const primaryCandidate = input.resolveCommand(primaryMatch[1]);
  if (!primaryCandidate) {
    return { commands: [], trailingArgs: input.primaryArgs, capped: false };
  }
  commands.push(primaryCandidate);
  remaining = remaining.slice(primaryMatch[0].length).trimStart();

  while (commands.length < STACKED_SKILL_LIMIT) {
    const tokenMatch = /^\/(\S+)/.exec(remaining);
    if (!tokenMatch) break;
    const candidateName = tokenMatch[1];
    const candidate = input.resolveCommand(candidateName);
    if (!candidate) break;
    commands.push(candidate);
    // Advance past the consumed "/name" token.
    remaining = remaining.slice(tokenMatch[0].length).trimStart();
  }

  // If we hit the cap AND the next token is still a slash-command, set capped.
  if (commands.length >= STACKED_SKILL_LIMIT && /^\//.test(remaining)) {
    capped = true;
  }

  return { commands, trailingArgs: remaining, capped };
}
