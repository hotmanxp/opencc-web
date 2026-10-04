import React, { useCallback, useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { installOAuthTokens } from '../cli/handlers/auth.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { setClipboard } from '../ink/termio/osc.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { Box, Link, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { sendNotification } from '../services/notifier.js';
import { OAuthService } from '../services/oauth/index.js';
import { getOauthAccountInfo, validateForceLoginOrg } from '../utils/auth.js';
import { logError } from '../utils/log.js';
import { getSettings_DEPRECATED } from '../utils/settings/settings.js';
import { ProviderManager } from './ProviderManager.js';
import { Select } from './CustomSelect/select.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Spinner } from './Spinner.js';
import TextInput from './TextInput.js';
export type ConsoleOAuthFlowResult = {
  type: 'oauth';
} | {
  type: 'provider-setup';
  message: string;
};
type Props = {
  onDone(result?: ConsoleOAuthFlowResult): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
  initialStatus?: OAuthStatus;
};
type OAuthStatus = {
  state: 'idle';
} // Initial state, waiting to select login method
| {
  state: 'platform_setup';
} // Show third-party provider setup flow
| {
  state: 'platform_setup_complete';
  message: string;
}
| {
  state: 'ready_to_start';
} // Flow started, waiting for browser to open
| {
  state: 'waiting_for_login';
  url: string;
} // Browser opened, waiting for user to login
| {
  state: 'creating_api_key';
} // Got access token, creating API key
| {
  state: 'about_to_retry';
  nextState: OAuthStatus;
} | {
  state: 'success';
  token?: string;
} | {
  state: 'error';
  message: string;
  toRetry?: OAuthStatus;
}
const PASTE_HERE_MSG = 'Paste code here if prompted > ';
export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod: forceLoginMethodProp,
  initialStatus
}: Props): React.ReactNode | null {
  return null;
}
type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus;
  mode: 'login' | 'setup-token';
  startingMessage: string | undefined;
  forcedMethodMessage: string | null;
  showPastePrompt: boolean;
  pastedCode: string;
  setPastedCode: (value: string) => void;
  cursorOffset: number;
  setCursorOffset: (offset: number) => void;
  textInputColumns: number;
  handleSubmitCode: (value: string, url: string) => void;
  setOAuthStatus: (status: OAuthStatus) => void;
  setLoginWithClaudeAi: (value: boolean) => void;
  onDone: (result?: ConsoleOAuthFlowResult) => void;
};
function OAuthStatusMessage({
  oauthStatus,
  mode,
  startingMessage,
  forcedMethodMessage,
  showPastePrompt,
  pastedCode,
  setPastedCode,
  cursorOffset,
  setCursorOffset,
  textInputColumns,
  handleSubmitCode,
  setOAuthStatus,
  setLoginWithClaudeAi,
  onDone,
}: OAuthStatusMessageProps) {
  return null;
}
