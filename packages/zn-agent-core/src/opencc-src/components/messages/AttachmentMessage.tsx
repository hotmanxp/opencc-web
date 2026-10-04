// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import React, { useMemo } from 'react';
import type { Attachment } from 'src/utils/attachments.js';
type Props = {
  addMargin: boolean;
  attachment: Attachment;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function AttachmentMessage({
  attachment,
  addMargin,
  verbose,
  isTranscriptMode
}: Props): React.ReactNode | null {
  return null;
}
function TaskStatusMessage(t0) {
  return null;
}
function GenericTaskStatus(t0) {
  return null;
}
function TeammateTaskStatus(t0) {
  return null;
}
// We allow setting dimColor to false here to help work around the dim-bold bug.
// https://github.com/chalk/chalk/issues/290
function Line(t0) {
  return null;
}
