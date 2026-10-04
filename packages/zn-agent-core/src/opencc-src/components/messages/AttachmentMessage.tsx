// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import React, { useMemo } from 'react';
import { Ansi, Box, Text } from '../../ink.js';
import type { Attachment } from 'src/utils/attachments.js';
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js';
import { useAppState } from '../../state/AppState.js';
import { getDisplayPath } from 'src/utils/file.js';
import { formatFileSize } from 'src/utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { basename, sep } from 'path';
import { UserTextMessage } from './UserTextMessage.js';
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js';
import { getContentText } from 'src/utils/messages.js';
import type { Theme } from 'src/utils/theme.js';
import { UserImageMessage } from './UserImageMessage.js';
import { toInkColor } from '../../utils/ink.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { tryRenderPlanApprovalMessage, formatTeammateMessageContent } from './PlanApprovalMessage.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { TeammateMessageContent } from './UserTeammateMessage.js';
import { isShutdownApproved } from '../../utils/teammateMailbox.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import FullWidthRow from '../design-system/FullWidthRow.js';
import { FilePathLink } from '../FilePathLink.js';
import { useSelectedMessageBg } from '../messageActions.js';
import { isAntEmployee } from '../../utils/buildConfig.js';
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
type TaskStatusAttachment = Extract<Attachment, {
  type: 'task_status';
}>;
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
