import { execa } from 'execa';
import * as React from 'react';
import { useEffect, useState } from 'react';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getGhAuthStatus } from '../../utils/github/ghAuthStatus.js';
import { type ImportTokenError, isSignedIn, RedactedGithubToken } from './api.js'
type CheckResult = {
  status: 'not_signed_in';
} | {
  status: 'has_gh_token';
  token: RedactedGithubToken;
} | {
  status: 'gh_not_installed';
} | {
  status: 'gh_not_authenticated';
};
async function checkLoginState(): Promise<CheckResult> {
  if (!(await isSignedIn())) {
    return {
      status: 'not_signed_in'
    };
  }
  const ghStatus = await getGhAuthStatus();
  if (ghStatus === 'not_installed') {
    return {
      status: 'gh_not_installed'
    };
  }
  if (ghStatus === 'not_authenticated') {
    return {
      status: 'gh_not_authenticated'
    };
  }

  // ghStatus === 'authenticated'. getGhAuthStatus spawns with stdout:'ignore'
  // (telemetry-safe); spawn once more with stdout:'pipe' to read the token.
  const {
    stdout
  } = await execa('gh', ['auth', 'token'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    reject: false
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      status: 'gh_not_authenticated'
    };
  }
  return {
    status: 'has_gh_token',
    token: new RedactedGithubToken(trimmed)
  };
}
function errorMessage(err: ImportTokenError, codeUrl: string): string {
  switch (err.kind) {
    case 'not_signed_in':
      return `Login failed. Please visit ${codeUrl} and login using the GitHub App`;
    case 'invalid_token':
      return 'GitHub rejected that token. Run `gh auth login` and try again.';
    case 'server':
      return `Server error (${err.status}). Try again in a moment.`;
    case 'network':
      return "Couldn't reach the server. Check your connection.";
  }
}
type Step = {
  name: 'checking';
} | {
  name: 'confirm';
  token: RedactedGithubToken;
} | {
  name: 'uploading';
};
function Web({
  onDone
}: {
  onDone: LocalJSXCommandOnDone;
}) {
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <Web onDone={onDone} />;
}
