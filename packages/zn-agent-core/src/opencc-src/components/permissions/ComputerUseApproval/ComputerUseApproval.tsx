// @ts-nocheck
import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps';
import type { CuPermissionRequest, CuPermissionResponse } from '@ant/computer-use-mcp/types';
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp/types';
import figures from 'figures';
import * as React from 'react';
import { useMemo, useState } from 'react';
import { Text } from '../../../ink.js'
type ComputerUseApprovalProps = {
  request: CuPermissionRequest;
  onDone: (response: CuPermissionResponse) => void;
};
const DENY_ALL_RESPONSE: CuPermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_GRANT_FLAGS
};

/**
 * Two-panel dispatcher. When `request.tccState` is present, macOS permissions
 * (Accessibility / Screen Recording) are missing and the app list is
 * irrelevant — show a TCC panel that opens System Settings. Otherwise show the
 * app allowlist + grant-flags panel.
 */
export function ComputerUseApproval(t0) {
  return null;
}

// ── TCC panel ─────────────────────────────────────────────────────────────

type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry';
function ComputerUseTccPanel(t0) {
  return null;
}

// ── App allowlist panel ───────────────────────────────────────────────────

type AppListOption = 'allow_all' | 'deny';
const SENTINEL_WARNING: Record<NonNullable<ReturnType<typeof getSentinelCategory>>, string> = {
  shell: 'equivalent to shell access',
  filesystem: 'can read/write any file',
  system_settings: 'can change system settings'
};
function ComputerUseAppListPanel(t0) {
  return null;
}
function _temp4(flag) {
  return <Text key={flag} dimColor={true}>{"  "}· {flag}</Text>;
}
function _temp3(k_0) {
  return [k_0, true] as const;
}
function _temp2(a_2) {
  return {
    bundleId: a_2.resolved?.bundleId ?? a_2.requestedName,
    reason: a_2.resolved ? "user_denied" as const : "not_installed" as const
  };
}
function _temp(a) {
  return a.resolved && !a.alreadyGranted ? [a.resolved.bundleId] : [];
}
