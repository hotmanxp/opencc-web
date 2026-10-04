// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box } from '../ink.js';
import { useAppState } from '../state/AppState.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import type { MemoryFileInfo } from '../utils/claudemd.js';
import { getMemoryFiles } from '../utils/claudemd.js';
import { getGlobalConfig } from '../utils/config.js';
import { getActiveNotices, type StatusNoticeContext } from '../utils/statusNoticeDefinitions.js';
import { assembleToolPool } from '../tools.js';
import { checkLocalModelContextLoad, isActiveProviderLocalModel, type LocalModelContextWarning } from '../utils/statusNoticeLocalModel.js';
type Props = {
  agentDefinitions?: AgentDefinitionsResult;
};

let cachedMemoryFiles: MemoryFileInfo[] = [];
let memoryFilesPromise: Promise<void> | null = null;

async function loadMemoryFiles(): Promise<void> {
  if (memoryFilesPromise) {
    return memoryFilesPromise;
  }
  memoryFilesPromise = getMemoryFiles().then(files => {
    cachedMemoryFiles = files;
  }).finally(() => {
    memoryFilesPromise = null;
  });
  return memoryFilesPromise;
}

/**
 * StatusNotices contains the information displayed to users at startup. We have
 * moved neutral or positive status to src/components/Status.tsx instead, which
 * users can access through /status.
 */
export function StatusNotices(t0) {
  return null;
}
