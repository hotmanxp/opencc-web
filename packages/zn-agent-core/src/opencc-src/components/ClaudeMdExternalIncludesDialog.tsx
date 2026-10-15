import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Text } from '../ink.js'
import type { ExternalClaudeMdInclude } from '../utils/claudemd.js';
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
