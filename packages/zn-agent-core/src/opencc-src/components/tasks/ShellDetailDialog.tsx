// @ts-nocheck
import React, { Suspense, use, useDeferredValue, useEffect, useState } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import type { CommandResultDisplay } from '../../commands.js';
import { Text } from '../../ink.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js';
import { tailFile } from '../../utils/fsOperations.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
type Props = {
  shell: DeepImmutable<LocalShellTaskState>;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onKillShell?: () => void;
  onBack?: () => void;
};
const SHELL_DETAIL_TAIL_BYTES = 8192;
type TaskOutputResult = {
  content: string;
  bytesTotal: number;
};

/**
 * Read the tail of the task output file. Only reads the last few KB,
 * not the entire file.
 */
async function getTaskOutput(shell: DeepImmutable<LocalShellTaskState>): Promise<TaskOutputResult> {
  const path = getTaskOutputPath(shell.id);
  try {
    const result = await tailFile(path, SHELL_DETAIL_TAIL_BYTES);
    return {
      content: result.content,
      bytesTotal: result.bytesTotal
    };
  } catch {
    return {
      content: '',
      bytesTotal: 0
    };
  }
}
export function ShellDetailDialog(t0) {
  return null;
}
function _temp(setOutputPromise_0, shell_0) {
  return setOutputPromise_0(getTaskOutput(shell_0));
}
type ShellOutputContentProps = {
  outputPromise: Promise<TaskOutputResult>;
  columns: number;
};
function ShellOutputContent(t0) {
  return null;
}
function _temp2(line_0, i_1) {
  return <Text key={i_1} wrap="truncate-end">{line_0}</Text>;
}
