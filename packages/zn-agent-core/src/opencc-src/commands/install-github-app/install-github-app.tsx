import { execa } from 'execa';
import React, { useCallback, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { WorkflowMultiselectDialog } from '../../components/WorkflowMultiselectDialog.js';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box } from '../../ink.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getAnthropicApiKey, isAnthropicAuthEnabled } from '../../utils/auth.js';
import { openBrowser } from '../../utils/browser.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { getGithubRepo } from '../../utils/git.js';
import { plural } from '../../utils/stringUtils.js';
import { ApiKeyStep } from './ApiKeyStep.js';
import { CheckExistingSecretStep } from './CheckExistingSecretStep.js';
import { CheckGitHubStep } from './CheckGitHubStep.js';
import { ChooseRepoStep } from './ChooseRepoStep.js';
import { CreatingStep } from './CreatingStep.js';
import { ErrorStep } from './ErrorStep.js';
import { ExistingWorkflowStep } from './ExistingWorkflowStep.js';
import { InstallAppStep } from './InstallAppStep.js';
import { OAuthFlowStep } from './OAuthFlowStep.js';
import { extractGitHubRepoSlug } from './repoSlug.js';
import { SuccessStep } from './SuccessStep.js';
import { setupGitHubActions } from './setupGitHubActions.js';
import type { State, Warning, Workflow } from './types.js';
import { WarningsStep } from './WarningsStep.js';
const INITIAL_STATE: State = {
  step: 'check-gh',
  selectedRepoName: '',
  currentRepo: '',
  useCurrentRepo: false,
  // Default to false, will be set to true if repo detected
  apiKeyOrOAuthToken: '',
  useExistingKey: true,
  currentWorkflowInstallStep: 0,
  warnings: [],
  secretExists: false,
  secretName: 'ANTHROPIC_API_KEY',
  useExistingSecret: true,
  workflowExists: false,
  selectedWorkflows: ['claude', 'claude-review'] as Workflow[],
  selectedApiKeyOption: 'new' as 'existing' | 'new' | 'oauth',
  authType: 'api_key'
};
function InstallGitHubApp(props: {
  onDone: (message: string) => void;
}): React.ReactNode | null {
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <InstallGitHubApp onDone={onDone} />;
}
