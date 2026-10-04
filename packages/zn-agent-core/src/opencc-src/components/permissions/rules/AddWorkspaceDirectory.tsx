// @ts-nocheck
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import TextInput from '../../../components/TextInput.js';
import { Text } from '../../../ink.js'
import type { ToolPermissionContext } from '../../../Tool.js';
import { ConfigurableShortcutHint } from '../../ConfigurableShortcutHint.js';
import { Byline } from '../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js';
type Props = {
  onAddDirectory: (path: string, remember?: boolean) => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  directoryPath?: string; // When directoryPath is provided, show selection options instead of input
};
type RememberDirectoryOption = 'yes-session' | 'yes-remember' | 'no';
const REMEMBER_DIRECTORY_OPTIONS: Array<{
  value: RememberDirectoryOption;
  label: string;
}> = [{
  value: 'yes-session',
  label: '是，仅本次会话'
}, {
  value: 'yes-remember',
  label: '是，并记住此目录'
}, {
  value: 'no',
  label: '否'
}];
function PermissionDescription() {
  return null;
}
function DirectoryDisplay(t0) {
  return null;
}
function DirectoryInput(t0) {
  return null;
}
function _temp() {}
export function AddWorkspaceDirectory(t0) {
  return null;
}
function _temp2(exitState) {
  return exitState.pending ? <Text>按 {exitState.keyName} 再次退出</Text> : <Byline><KeyboardShortcutHint shortcut="Tab" action="补全" /><KeyboardShortcutHint shortcut="Enter" action="添加" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="取消" /></Byline>;
}
