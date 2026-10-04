import React, { useCallback, useRef, useState } from 'react';
import type { ExportFormat } from '../utils/exportFormats.js';
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
