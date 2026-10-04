// @ts-nocheck
import chalk from 'chalk';
import figures from 'figures';
import React, { useMemo } from 'react';
import { Box, color, Text } from '../../ink.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js';
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js';
import type { PermissionDecision, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js';
import { getSettingSourceDisplayNameLowercase } from '../../utils/settings/constants.js';
function decisionReasonDisplayString(decisionReason: PermissionDecisionReason & {
  type: Exclude<PermissionDecisionReason['type'], 'subcommandResults'>;
}): string {
  if ((false || true) && decisionReason.type === 'classifier') {
    return `${chalk.bold(decisionReason.classifier)} classifier: ${decisionReason.reason}`;
  }
  switch (decisionReason.type) {
    case 'rule':
      return `${chalk.bold(permissionRuleValueToString(decisionReason.rule.ruleValue))} rule from ${getSettingSourceDisplayNameLowercase(decisionReason.rule.source)}`;
    case 'mode':
      return `${permissionModeTitle(decisionReason.mode)} mode`;
    case 'sandboxOverride':
      return 'Requires permission to bypass sandbox';
    case 'workingDir':
      return decisionReason.reason;
    case 'safetyCheck':
    case 'other':
      return decisionReason.reason;
    case 'permissionPromptTool':
      return `${chalk.bold(decisionReason.permissionPromptToolName)} permission prompt tool`;
    case 'hook':
      return decisionReason.reason ? `${chalk.bold(decisionReason.hookName)} hook: ${decisionReason.reason}` : `${chalk.bold(decisionReason.hookName)} hook`;
    case 'asyncAgent':
      return decisionReason.reason;
    default:
      return '';
  }
}
function PermissionDecisionInfoItem(t0) {
  return null;
}
function SuggestedRules(t0) {
  return null;
}
function _temp(rule) {
  return chalk.bold(permissionRuleValueToString(rule));
}
type Props = {
  permissionResult: PermissionDecision;
  toolName?: string; // Filter unreachable rules to this tool
};

// Helper function to extract directories from permission updates
function extractDirectories(updates: PermissionUpdate[] | undefined): string[] {
  if (!updates) return [];
  return updates.flatMap(update => {
    switch (update.type) {
      case 'addDirectories':
        return update.directories;
      default:
        return [];
    }
  });
}

// Helper function to extract mode from permission updates
function extractMode(updates: PermissionUpdate[] | undefined): PermissionMode | undefined {
  if (!updates) return undefined;
  const update = updates.findLast(u => u.type === 'setMode');
  return update?.type === 'setMode' ? update.mode : undefined;
}
function SuggestionDisplay(t0) {
  return null;
}
function _temp3(dir, index_0) {
  return <Text key={index_0}>{figures.bullet} {dir}</Text>;
}
function _temp2(rule, index) {
  return <Text key={index}>{figures.bullet} {permissionRuleValueToString(rule)}</Text>;
}
export function PermissionDecisionDebugInfo(t0) {
  return null;
}
function _temp5(u_1, i) {
  return <Box key={i} flexDirection="column" marginLeft={2}><Text color="warning">{permissionRuleValueToString(u_1.rule.ruleValue)}</Text><Text dimColor={true}>{"  "}{u_1.reason}</Text><Text dimColor={true}>{"  "}Fix: {u_1.fix}</Text></Box>;
}
function _temp4(s) {
  return s.toolPermissionContext;
}
