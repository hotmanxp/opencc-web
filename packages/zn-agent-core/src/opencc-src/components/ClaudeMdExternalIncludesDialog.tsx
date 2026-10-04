import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import type { ExternalClaudeMdInclude } from '../utils/claudemd.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { AGENTS_INSTRUCTIONS_FILENAME } from '../constants.js';
import { BRAND_NAME } from '../constants.js';
type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalClaudeMdInclude[];
};
export function ClaudeMdExternalIncludesDialog(t0: Props) {
  return null;
}
function _temp4(include: ExternalClaudeMdInclude, i: number) {
  return <Text key={i} dimColor={true}>{"  "}{include.path}</Text>;
}
function _temp3(current_0: any) {
  return {
    ...current_0,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true
  };
}
function _temp2(current: any) {
  return {
    ...current,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: true
  };
}
function _temp() {
  logEvent("tengu_claude_md_includes_dialog_shown", {});
}
