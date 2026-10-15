import * as React from 'react';
import { useEffect, useState } from 'react';
import { getBridgeAccessToken } from '../../bridge/bridgeConfig.js';
import { checkBridgeMinVersion, getBridgeDisabledReason, isEnvLessBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { checkEnvLessBridgeMinVersion } from '../../bridge/envLessBridgeConfig.js';
import { BRIDGE_LOGIN_INSTRUCTION } from '../../bridge/types.js'
import { Text } from '../../ink.js'
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { logForDebugging } from '../../utils/debug.js';
type Props = {
  onDone: LocalJSXCommandOnDone;
  name?: string;
};

/**
 * /remote-control command — manages the bidirectional bridge connection.
 *
 * When enabled, sets replBridgeEnabled in AppState, which triggers
 * useReplBridge in REPL.tsx to initialize the bridge connection.
 * The bridge registers an environment, creates a session with the current
 * conversation, polls for work, and connects an ingress WebSocket for
 * bidirectional messaging between the CLI and claude.ai.
 *
 * Running /remote-control when already connected shows a dialog with the session
 * URL and options to disconnect or continue.
 */
function BridgeToggle(t0) {
  return null;
}

/**
 * Dialog shown when /remote-control is used while the bridge is already connected.
 * Shows the session URL and lets the user disconnect or continue.
 */
function _temp3(s_1) {
  return s_1.replBridgeOutboundOnly;
}
function _temp2(s_0) {
  return s_0.replBridgeEnabled;
}
function _temp(s) {
  return s.replBridgeConnected;
}
function BridgeDisconnectDialog(t0) {
  return null;
}

/**
 * Check bridge prerequisites. Returns an error message if a precondition
 * fails, or null if all checks pass. Awaits GrowthBook init if the disk
 * cache is stale, so a user who just became entitled (e.g. upgraded to Max,
 * or the flag just launched) gets an accurate result on the first try.
 */
function _temp10(line, i_1) {
  return <Text key={i_1}>{line}</Text>;
}
function _temp1(l) {
  return l.length > 0;
}
function _temp0(i_0) {
  return (i_0 - 1 + 3) % 3;
}
function _temp9(i) {
  return (i + 1) % 3;
}
function _temp8(prev_0) {
  return !prev_0;
}
function _temp7(prev) {
  if (!prev.replBridgeEnabled) {
    return prev;
  }
  return {
    ...prev,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false
  };
}
function _temp6(s_1) {
  return s_1.replBridgeSessionActive;
}
function _temp5(s_0) {
  return s_0.replBridgeConnectUrl;
}
function _temp4(s) {
  return s.replBridgeSessionUrl;
}
async function checkBridgePrerequisites(): Promise<string | null> {
  // Check organization policy — remote control may be disabled
  const {
    waitForPolicyLimitsToLoad,
    isPolicyAllowed
  } = await import('../../services/policyLimits/index.js');
  await waitForPolicyLimitsToLoad();
  if (!isPolicyAllowed('allow_remote_control')) {
    return "Remote Control is disabled by your organization's policy.";
  }
  const disabledReason = await getBridgeDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  // Mirror the v1/v2 branching logic in initReplBridge: env-less (v2) is used
  // only when the flag is on AND the session is not perpetual.  In assistant
  // mode (KAIROS) useReplBridge sets perpetual=true, which forces
  // initReplBridge onto the v1 path — so the prerequisite check must match.
  let useV2 = isEnvLessBridgeEnabled();
  if (false && useV2) {
    const {
      isAssistantMode
    } = await import('../../assistant/index.js');
    if (isAssistantMode()) {
      useV2 = false;
    }
  }
  const versionError = useV2 ? await checkEnvLessBridgeMinVersion() : checkBridgeMinVersion();
  if (versionError) {
    return versionError;
  }
  if (!getBridgeAccessToken()) {
    return BRIDGE_LOGIN_INSTRUCTION;
  }
  logForDebugging('[bridge] Prerequisites passed, enabling bridge');
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: ToolUseContext & LocalJSXCommandContext, args: string): Promise<React.ReactNode> {
  const name = args.trim() || undefined;
  return <BridgeToggle onDone={onDone} name={name} />;
}
