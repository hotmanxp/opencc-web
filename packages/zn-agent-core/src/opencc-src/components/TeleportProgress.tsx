// @ts-nocheck
import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import type { Root } from '../ink.js';
import { AppStateProvider } from '../state/AppState.js';
import { checkOutTeleportedSessionBranch, processMessagesForTeleportResume, type TeleportProgressStep, type TeleportResult, teleportResumeCodeSession } from '../utils/teleport.js';
type Props = {
  currentStep: TeleportProgressStep;
  sessionId?: string;
};
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const STEPS: {
  key: TeleportProgressStep;
  label: string;
}[] = [{
  key: 'validating',
  label: 'Validating session'
}, {
  key: 'fetching_logs',
  label: 'Fetching session logs'
}, {
  key: 'fetching_branch',
  label: 'Getting branch info'
}, {
  key: 'checking_out',
  label: 'Checking out branch'
}];
export function TeleportProgress(t0) {
  return null;
}

/**
 * Teleports to a remote session with progress UI rendered into the existing root.
 * Fetches the session, checks out the branch, and returns the result.
 */
export async function teleportWithProgress(root: Root, sessionId: string): Promise<TeleportResult> {
  // Capture the setState function from the rendered component
  let setStep: (step: TeleportProgressStep) => void = () => {};
  function TeleportProgressWrapper(): React.ReactNode | null {
    return null;
  }
  root.render(<AppStateProvider>
      <TeleportProgressWrapper />
    </AppStateProvider>);
  const result = await teleportResumeCodeSession(sessionId, setStep);
  setStep('checking_out');
  const {
    branchName,
    branchError
  } = await checkOutTeleportedSessionBranch(result.branch);
  return {
    messages: processMessagesForTeleportResume(result.log, branchError),
    branchName
  };
}
