// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../ink.js';
import type { ContextData } from '../utils/analyzeContext.js';
import { generateContextSuggestions } from '../utils/contextSuggestions.js';
import { getDisplayPath } from '../utils/file.js';
import { formatTokens } from '../utils/format.js';
import { getSourceDisplayName, type SettingSource } from '../utils/settings/constants.js';
import { plural } from '../utils/stringUtils.js';
import { ContextSuggestions } from './ContextSuggestions.js';
const RESERVED_CATEGORY_NAME = 'Autocompact buffer';

/**
 * One-liner for the legend header showing what context-collapse has done.
 * Returns null when nothing's summarized/staged so we don't add visual
 * noise in the common case. This is the one place a user can see that
 * their context was rewritten — the <collapsed> placeholders are isMeta
 * and don't appear in the conversation view.
 */
function CollapseStatus() {
  return null;
}

// Order for displaying source groups: Project > User > Managed > Plugin > Built-in
const SOURCE_DISPLAY_ORDER = ['Project', 'User', 'Managed', 'Plugin', 'Built-in'];

/** Group items by source type for display, sorted by tokens descending within each group */
function groupBySource<T extends {
  source: SettingSource | 'plugin' | 'built-in';
  tokens: number;
}>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getSourceDisplayName(item.source);
    const existing = groups.get(key) || [];
    existing.push(item);
    groups.set(key, existing);
  }
  // Sort each group by tokens descending
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort((a, b) => b.tokens - a.tokens));
  }
  // Return groups in consistent order
  const orderedGroups = new Map<string, T[]>();
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source);
    if (group) {
      orderedGroups.set(source, group);
    }
  }
  return orderedGroups;
}
interface Props {
  data: ContextData;
}
export function ContextVisualization(t0) {
  return null;
}
function _temp27(attachment, i_10) {
  return <Box key={i_10} marginLeft={1}><Text>└ {attachment.name}: </Text><Text dimColor={true}>{formatTokens(attachment.tokens)} tokens</Text></Box>;
}
function _temp26(tool_5, i_9) {
  return <Box key={i_9} marginLeft={1}><Text>└ {tool_5.name}: </Text><Text dimColor={true}>calls {formatTokens(tool_5.callTokens)}, results{" "}{formatTokens(tool_5.resultTokens)}</Text></Box>;
}
function _temp25(t0) {
  const [sourceDisplay_0, sourceSkills] = t0;
  return <Box key={sourceDisplay_0} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay_0}</Text>{sourceSkills.map(_temp24)}</Box>;
}
function _temp24(skill, i_8) {
  return <Box key={i_8}><Text>└ {skill.name}: </Text><Text dimColor={true}>{formatTokens(skill.tokens)} tokens</Text></Box>;
}
function _temp23(file, i_7) {
  return <Box key={i_7}><Text>└ {getDisplayPath(file.path)}: </Text><Text dimColor={true}>{formatTokens(file.tokens)} tokens</Text></Box>;
}
function _temp22(t0) {
  const [sourceDisplay, sourceAgents] = t0;
  return <Box key={sourceDisplay} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay}</Text>{sourceAgents.map(_temp21)}</Box>;
}
function _temp21(agent, i_6) {
  return <Box key={i_6}><Text>└ {agent.agentType}: </Text><Text dimColor={true}>{formatTokens(agent.tokens)} tokens</Text></Box>;
}
function _temp20(section, i_5) {
  return <Box key={i_5}><Text>└ {section.name}: </Text><Text dimColor={true}>{formatTokens(section.tokens)} tokens</Text></Box>;
}
function _temp19(tool_4, i_4) {
  return <Box key={i_4}><Text dimColor={true}>└ {tool_4.name}</Text></Box>;
}
function _temp18(t_4) {
  return !t_4.isLoaded;
}
function _temp17(t_5) {
  return !t_5.isLoaded;
}
function _temp16(tool_3, i_3) {
  return <Box key={`def-${i_3}`}><Text>└ {tool_3.name}: </Text><Text dimColor={true}>{formatTokens(tool_3.tokens)} tokens</Text></Box>;
}
function _temp15(t_3) {
  return t_3.isLoaded;
}
function _temp14(tool_2, i_2) {
  return <Box key={`sys-${i_2}`}><Text>└ {tool_2.name}: </Text><Text dimColor={true}>{formatTokens(tool_2.tokens)} tokens</Text></Box>;
}
function _temp13(tool_1, i_1) {
  return <Box key={i_1}><Text>└ {tool_1.name}: </Text><Text dimColor={true}>{formatTokens(tool_1.tokens)} tokens</Text></Box>;
}
function _temp12(tool_0, i_0) {
  return <Box key={i_0}><Text dimColor={true}>└ {tool_0.name}</Text></Box>;
}
function _temp11(t_1) {
  return !t_1.isLoaded;
}
function _temp10(t_2) {
  return !t_2.isLoaded;
}
function _temp1(tool, i) {
  return <Box key={i}><Text>└ {tool.name}: </Text><Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text></Box>;
}
function _temp0(t) {
  return t.isLoaded;
}
function _temp9(t_0) {
  return t_0.isLoaded;
}
function _temp8(c_0) {
  return c_0.name === "Free space";
}
function _temp7(c) {
  return c.name === "Free space";
}
function _temp6(c_1) {
  return c_1.name === "Free space";
}
function _temp5(row, rowIndex) {
  return <Box key={rowIndex} flexDirection="row" marginLeft={-1}>{row.map(_temp4)}</Box>;
}
function _temp4(square, colIndex) {
  if (square.categoryName === "Free space") {
    return <Text key={colIndex} dimColor={true}>{"\u26F6 "}</Text>;
  }
  if (square.categoryName === RESERVED_CATEGORY_NAME) {
    return <Text key={colIndex} color={square.color}>{"\u26DD "}</Text>;
  }
  return <Text key={colIndex} color={square.color}>{square.squareFullness >= 0.7 ? "\u26C1 " : "\u26C0 "}</Text>;
}
function _temp3(cat_1) {
  return cat_1.name === RESERVED_CATEGORY_NAME;
}
function _temp2(cat_0) {
  return cat_0.isDeferred && cat_0.name.includes("MCP");
}
function _temp(cat) {
  return cat.tokens > 0 && cat.name !== "Free space" && cat.name !== RESERVED_CATEGORY_NAME && !cat.isDeferred;
}
