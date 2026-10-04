import chalk from 'chalk';
import type { UUID } from 'crypto';
import * as React from 'react';
import type { CommandResultDisplay, ResumeEntrypoint } from '../../commands.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { LogOption } from '../../types/logs.js';
import { getSessionIdFromLog } from '../../utils/sessionStorage.js'
type ResumeResult = {
  resultType: 'sessionNotFound';
  arg: string;
} | {
  resultType: 'multipleMatches';
  arg: string;
  count: number;
};
function resumeHelpMessage(result: ResumeResult): string {
  switch (result.resultType) {
    case 'sessionNotFound':
      return `Session ${chalk.bold(result.arg)} was not found.`;
    case 'multipleMatches':
      return `Found ${result.count} sessions matching ${chalk.bold(result.arg)}. Please use /resume to pick a specific session.`;
  }
}
function ResumeError(t0) {
  return null;
}
function ResumeCommand({
  onDone,
  onResume
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onResume: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
}): React.ReactNode | null {
  return null;
}
export function filterResumableSessions(logs: LogOption[], currentSessionId: string): LogOption[] {
  return logs.filter(l => !l.isSidechain && getSessionIdFromLog(l) !== currentSessionId);
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  return Promise.resolve(null);
};
