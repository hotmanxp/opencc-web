import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode | null {
  return null;
}
