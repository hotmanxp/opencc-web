// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename } from 'path';
import React, { useRef } from 'react';
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js';
import { Ansi, Box, Text, useTheme } from '../../ink.js';
import { findToolByName, type Tools } from '../../Tool.js';
import { getReplPrimitiveTools } from '../../tools/REPLTool/primitiveTools.js';
import type { CollapsedReadSearchGroup, NormalizedAssistantMessage } from '../../types/message.js';
import { uniq } from '../../utils/array.js';
import { getToolUseIdsFromCollapsedGroup } from '../../utils/collapseReadSearch.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatDuration, formatSecondsShort } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import type { ThemeName } from '../../utils/theme.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { useSelectedMessageBg } from '../messageActions.js';
import { PrBadge } from '../PrBadge.js';
import { ToolUseLoader } from '../ToolUseLoader.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemCollapsed = true ? require('./teamMemCollapsed.js') as typeof import('./teamMemCollapsed.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// Hold each ⤿ hint for a minimum duration so fast-completing tool calls
// (bash commands, file reads, search patterns) are actually readable instead
// of flickering past in a single frame.
const MIN_HINT_DISPLAY_MS = 700;
type Props = {
  message: CollapsedReadSearchGroup;
  inProgressToolUseIDs: Set<string>;
  shouldAnimate: boolean;
  verbose: boolean;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  /** True if this is the currently active collapsed group (last one, still loading) */
  isActiveGroup?: boolean;
};

/** Render a single tool use in verbose mode */
function VerboseToolUse(t0) {
  return null;
}
export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate,
  verbose,
  tools,
  lookups,
  isActiveGroup
}: Props): React.ReactNode | null {
  return null;
}
