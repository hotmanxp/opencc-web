// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import { mkdir } from 'fs/promises';
import { basename, join } from 'path';
import * as React from 'react';
import { use, useEffect, useState } from 'react';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js';
import { logEvent } from '../../services/analytics/index.js';
import { isAutoDreamEnabled } from '../../services/autoDream/config.js';
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js';
import { useAppState } from '../../state/AppState.js';
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js';
import { openPath } from '../../utils/browser.js';
import { getMemoryFiles, type MemoryFileInfo } from '../../utils/claudemd.js';
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import { AGENTS_INSTRUCTIONS_FILENAME, USER_CONFIG_DIRNAME } from '../../constants.js';
import { projectIsInGitRepo } from '../../utils/memory/versions.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { Select } from '../CustomSelect/index.js';
import { ListItem } from '../design-system/ListItem.js';
import { getProjectMemoryPathForSelector } from './memoryFileSelectorPaths.js';
import * as teamMemPaths from '../../memdir/teamMemPaths.js'



interface ExtendedMemoryFileInfo extends MemoryFileInfo {
  isNested?: boolean;
  exists: boolean;
}

// Remember last selected path
let lastSelectedPath: string | undefined;
const OPEN_FOLDER_PREFIX = '__open_folder__';
type Props = {
  onSelect: (path: string) => void;
  onCancel: () => void;
};
export function MemoryFileSelector(t0) {
  return null;
}
function _temp8() {}
function _temp7(prev_0) {
  return prev_0 !== null && prev_0 > 0 ? prev_0 - 1 : prev_0;
}
function _temp6(s_0) {
  return Object.values(s_0.tasks).some(_temp5);
}
function _temp5(t) {
  return t.type === "dream" && t.status === "running";
}
function _temp4(opt) {
  return opt.value === lastSelectedPath;
}
function _temp3(s) {
  return s.agentDefinitions;
}
function _temp2(f_2) {
  return {
    ...f_2,
    exists: true
  };
}
function _temp(f_1) {
  return f_1.type !== "AutoMem" && f_1.type !== "TeamMem";
}
