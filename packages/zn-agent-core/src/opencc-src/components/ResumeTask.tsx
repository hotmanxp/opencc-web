import React, { useCallback, useState } from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { type CodeSession, fetchCodeSessionsFromSessionsAPI } from 'src/utils/teleport/api.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow list navigation
import { Box, Text, useInput } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { logForDebugging } from '../utils/debug.js';
import { detectCurrentRepository } from '../utils/detectRepository.js';
import { formatRelativeTime } from '../utils/format.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Spinner } from './Spinner.js';
import { TeleportError } from './TeleportError.js';
type Props = {
  onSelect: (session: CodeSession) => void;
  onCancel: () => void;
  isEmbedded?: boolean;
};
type LoadErrorType = 'network' | 'auth' | 'api' | 'other';
const UPDATED_STRING = 'Updated';
const SPACE_BETWEEN_TABLE_COLUMNS = '  ';
export function ResumeTask({
  onSelect,
  onCancel,
  isEmbedded = false
}: Props): React.ReactNode | null {
  return null;
}

/**
 * Determines the type of error based on the error message
 */
function determineErrorType(errorMessage: string): LoadErrorType {
  const message = errorMessage.toLowerCase();
  if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
    return 'network';
  }
  if (message.includes('auth') || message.includes('token') || message.includes('permission') || message.includes('oauth') || message.includes('not authenticated') || message.includes('/login') || message.includes('console account') || message.includes('403')) {
    return 'auth';
  }
  if (message.includes('api') || message.includes('rate limit') || message.includes('500') || message.includes('529')) {
    return 'api';
  }
  return 'other';
}

/**
 * Renders error-specific troubleshooting guidance
 */
function renderErrorSpecificGuidance(errorType: LoadErrorType): React.ReactNode {
  switch (errorType) {
    case 'network':
      return <Box marginY={1} flexDirection="column">
          <Text dimColor>Check your internet connection</Text>
        </Box>;
    case 'auth':
      return <Box marginY={1} flexDirection="column">
          <Text dimColor>Teleport requires a Claude.ai account</Text>
          <Text dimColor>
            Run <Text bold>/login</Text> and select &quot;OpenCC account with
            subscription&quot;
          </Text>
        </Box>;
    case 'api':
      return <Box marginY={1} flexDirection="column">
          <Text dimColor>Sorry, OpenCC encountered an error</Text>
        </Box>;
    case 'other':
      return <Box marginY={1} flexDirection="row">
          <Text dimColor>Sorry, OpenCC encountered an error</Text>
        </Box>;
  }
}
