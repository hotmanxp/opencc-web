// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename } from 'path';
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getOriginalCwd } from '../bootstrap/state.js';
import { buildActiveFooterText, buildIdleFooterText, FAILED_FOOTER_TEXT, getBridgeStatus } from '../bridge/bridgeStatusUtil.js';
import { BRIDGE_FAILED_INDICATOR, BRIDGE_READY_INDICATOR } from '../constants/figures.js';
import { useRegisterOverlay } from '../context/overlayContext.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw 'd' key for disconnect, not a configurable keybinding action
import { Box, Text, useInput } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { saveGlobalConfig } from '../utils/config.js';
import { getBranch } from '../utils/git.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  onDone: () => void;
};
export function BridgeDialog(t0) {
  return null;
}
function _temp14(line, i) {
  return <Text key={i}>{line}</Text>;
}
function _temp13(l) {
  return l.length > 0;
}
function _temp12(prev_0) {
  if (!prev_0.replBridgeEnabled) {
    return prev_0;
  }
  return {
    ...prev_0,
    replBridgeEnabled: false
  };
}
function _temp11(current) {
  if (current.remoteControlAtStartup === false) {
    return current;
  }
  return {
    ...current,
    remoteControlAtStartup: false
  };
}
function _temp10(prev) {
  return !prev;
}
function _temp1() {}
function _temp0(s_8) {
  return s_8.verbose;
}
function _temp9(s_7) {
  return s_7.replBridgeSessionId;
}
function _temp8(s_6) {
  return s_6.replBridgeEnvironmentId;
}
function _temp7(s_5) {
  return s_5.replBridgeExplicit;
}
function _temp6(s_4) {
  return s_4.replBridgeError;
}
function _temp5(s_3) {
  return s_3.replBridgeSessionUrl;
}
function _temp4(s_2) {
  return s_2.replBridgeConnectUrl;
}
function _temp3(s_1) {
  return s_1.replBridgeReconnecting;
}
function _temp2(s_0) {
  return s_0.replBridgeSessionActive;
}
function _temp(s) {
  return s.replBridgeConnected;
}
