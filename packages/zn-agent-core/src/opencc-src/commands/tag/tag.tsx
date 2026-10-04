// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import type { UUID } from 'crypto';
import * as React from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import type { CommandResultDisplay } from '../../commands.js';
import { Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js';
import { Box, Text } from '../../ink.js';
import { logEvent } from '../../services/analytics/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js';
import { getCurrentSessionTag, getTranscriptPath, saveTag } from '../../utils/sessionStorage.js';
function ConfirmRemoveTag(t0) {
  return null;
}
function ToggleTagAndClose(t0) {
  return null;
}
function ShowHelp(t0) {
  const $ = _c(3);
  const {
    onDone
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onDone) {
    t1 = () => {
      onDone("Usage: /tag <tag-name>\n\nToggle a searchable tag on the current session.\nRun the same command again to remove the tag.\nTags are displayed after the branch name in /resume and can be searched with /.\n\nExamples:\n  /tag bugfix        # Add tag\n  /tag bugfix        # Remove tag (toggle)\n  /tag feature-auth\n  /tag wip", {
        display: "system"
      });
    };
    t2 = [onDone];
    $[0] = onDone;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  React.useEffect(t1, t2);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_INFO_ARGS.includes(args) || COMMON_HELP_ARGS.includes(args)) {
    return <ShowHelp onDone={onDone} />;
  }
  if (!args) {
    return <ShowHelp onDone={onDone} />;
  }
  return <ToggleTagAndClose tagName={args} onDone={onDone} />;
}
