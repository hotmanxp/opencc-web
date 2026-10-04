// @ts-nocheck
import figures from 'figures';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionRequestProps } from '../PermissionRequest.js';
const CHECKING_TEXT = 'Attempting to auto-approve\u2026';

// Isolates the 20fps shimmer clock from BashPermissionRequestInner. Before this
// extraction, useShimmerAnimation lived inside the 535-line Inner body, so every
// 50ms clock tick re-rendered the entire dialog (PermissionDialog + Select +
// all children) for the ~1-3 seconds the classifier typically takes. Inner also
// has a Compiler bailout (see below), so nothing was auto-memoized — the full
// JSX tree was reconstructed 20-60 times per classifier check.
function ClassifierCheckingSubtitle() {
  return null;
}
export function BashPermissionRequest(props) {
  return null;
}

// Inner component that uses hooks - only called for non-MCP CLI commands
function BashPermissionRequestInner({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
  command,
  description
}: PermissionRequestProps & {
  command: string;
  description?: string;
}): React.ReactNode | null {
  return null;
}
