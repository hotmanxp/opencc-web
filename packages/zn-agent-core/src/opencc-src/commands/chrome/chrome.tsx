// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useState } from 'react';
import { type OptionWithDescription, Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { Box, Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { isClaudeAISubscriber } from '../../utils/auth.js';
import { openBrowser } from '../../utils/browser.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME, openInChrome } from '../../utils/claudeInChrome/common.js';
import { isChromeExtensionInstalled } from '../../utils/claudeInChrome/setup.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { env } from '../../utils/env.js';
import { isRunningOnHomespace } from '../../utils/envUtils.js';
const CHROME_EXTENSION_URL = 'https://claude.ai/chrome';
const CHROME_PERMISSIONS_URL = 'https://clau.de/chrome/permissions';
const CHROME_RECONNECT_URL = 'https://clau.de/chrome/reconnect';
type MenuAction = 'install-extension' | 'reconnect' | 'manage-permissions' | 'toggle-default';
type Props = {
  onDone: (result?: string) => void;
  isExtensionInstalled: boolean;
  configEnabled: boolean | undefined;
  isClaudeAISubscriber: boolean;
  isWSL: boolean;
};
function ClaudeInChromeMenu(t0) {
  return null;
}
function _temp5(k) {
  return k + 1;
}
function _temp4(k_0) {
  return k_0 + 1;
}
function _temp3(k_1) {
  return k_1 + 1;
}
function _temp2(c) {
  return c.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME;
}
function _temp(s) {
  return s.mcp.clients;
}
export const call = async function (onDone: (result?: string) => void): Promise<React.ReactNode> {
  return Promise.resolve(null);
};
