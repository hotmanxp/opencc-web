import { relative } from 'path';
import React, { useMemo } from 'react';
import { useDiffInIDE } from '../../../hooks/useDiffInIDE.js';
import { Box, Text } from '../../../ink.js';
import type { ToolUseContext } from '../../../Tool.js';
import { getLanguageName } from '../../../utils/cliHighlight.js';
import { getCwd } from '../../../utils/cwd.js';
import { getFsImplementation, safeResolvePath } from '../../../utils/fsOperations.js';
import { expandPath } from '../../../utils/path.js';
import type { CompletionType } from '../../../utils/unaryLogging.js';
import { Select } from '../../CustomSelect/index.js';
import { ShowInIDEPrompt } from '../../ShowInIDEPrompt.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { ToolUseConfirm } from '../PermissionRequest.js';
import type { WorkerBadgeProps } from '../WorkerBadge.js';
import type { IDEDiffSupport } from './ideDiffConfig.js';
import type { FileOperationType, PermissionOption } from './permissionOptions.js';
import { type ToolInput, useFilePermissionDialog } from './useFilePermissionDialog.js';
export type FilePermissionDialogProps<T extends ToolInput = ToolInput> = {
  // Required props from PermissionRequestProps
  toolUseConfirm: ToolUseConfirm;
  toolUseContext: ToolUseContext;
  onDone: () => void;
  onReject: () => void;

  // Dialog customization
  title: string;
  subtitle?: React.ReactNode;
  question?: string | React.ReactNode;
  content?: React.ReactNode; // Can be general content or diff component

  // Logging
  completionType?: CompletionType;
  languageName?: string; // override — derived from path when omitted

  // File/directory operations
  path: string | null;
  parseInput: (input: unknown) => T;
  operationType?: FileOperationType;

  // IDE diff support
  ideDiffSupport?: IDEDiffSupport<T>;

  // Worker badge for teammate permission requests
  workerBadge: WorkerBadgeProps | undefined;
};
export function FilePermissionDialog<T extends ToolInput = ToolInput>({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  title,
  subtitle,
  question = 'Do you want to proceed?',
  content,
  completionType = 'tool_use_single',
  path,
  parseInput,
  operationType = 'write',
  ideDiffSupport,
  workerBadge,
  languageName: languageNameOverride
}: FilePermissionDialogProps<T>): React.ReactNode | null {
  // Derive from path unless caller provided an explicit override (NotebookEdit
  // passes 'python'/'markdown' from cell_type). getLanguageName is async;
  // downstream UnaryEvent.language_name and logPermissionEvent already accept
  // Promise<string>. useMemo keeps the promise stable across renders.
  return null;
}
