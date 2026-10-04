// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useEffect } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import type { TeleportRemoteResponse } from 'src/utils/conversationRecovery.js';
import type { CodeSession } from 'src/utils/teleport/api.js';
import { type TeleportSource, useTeleportResume } from '../hooks/useTeleportResume.js';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { ResumeTask } from './ResumeTask.js';
import { Spinner } from './Spinner.js';
interface TeleportResumeWrapperProps {
  onComplete: (result: TeleportRemoteResponse) => void;
  onCancel: () => void;
  onError?: (error: string, formattedMessage?: string) => void;
  isEmbedded?: boolean;
  source: TeleportSource;
}

/**
 * Wrapper component that manages the full teleport resume flow,
 * including session selection, loading state, and error handling
 */
export function TeleportResumeWrapper(t0) {
  return null;
}
