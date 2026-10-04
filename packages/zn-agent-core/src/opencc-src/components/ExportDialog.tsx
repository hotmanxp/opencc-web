import React, { useCallback, useRef, useState } from 'react';
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { setClipboard } from '../ink/termio/osc.js';
import { Box, Text, useInput } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getCwd } from '../utils/cwd.js';
import type { ExportFormat } from '../utils/exportFormats.js';
import { ensureExportFilenameExtension, resolveExportFilepath } from '../utils/exportFormats.js';
import { writeFileSync_DEPRECATED } from '../utils/slowOperations.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/select.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import TextInput from './TextInput.js';
type ExportDialogProps = {
  defaultFilename: string;
  defaultFormat: ExportFormat;
  getContent: (format: ExportFormat) => Promise<string>;
  onDone: (result: {
    success: boolean;
    message: string;
  }) => void;
};
type DialogStep = 'format' | 'method' | 'filename';
export function ExportDialog({
  defaultFilename,
  defaultFormat,
  getContent,
  onDone
}: ExportDialogProps): React.ReactNode | null {
  return null;
}
