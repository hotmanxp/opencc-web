// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useMemo } from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, getCommandName, type PromptCommand } from '../../commands.js';
import { USER_CONFIG_DIRNAME } from '../../constants.js';
import { Box, Text } from '../../ink.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../skills/loadSkillsDir.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatTokens } from '../../utils/format.js';
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '../design-system/Dialog.js';
import FullWidthRow from '../design-system/FullWidthRow.js';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp';
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};
function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}
function getSourceSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  const hasCommandsSkills = skills.some(s => s.loadedFrom === 'commands_DEPRECATED');
  return hasCommandsSkills ? `${skillsPath}, ${getDisplayPath(getSkillsPath(source, 'commands'))}` : skillsPath;
}
function getSkillListLabel(skill: SkillCommand): string {
  const leafName = skill.name.split(':').pop() ?? skill.name;
  return leafName === skill.name ? skill.name : `${skill.name} - ${leafName}`;
}
export function SkillsMenu(t0) {
  return null;
}
function _temp3(skill_0) {
  const estimatedTokens = estimateSkillFrontmatterTokens(skill_0);
  const tokenDisplay = `~${formatTokens(estimatedTokens)}`;
  const pluginName = skill_0.source === "plugin" ? skill_0.pluginInfo?.pluginManifest.name : undefined;
  return <FullWidthRow key={`${skill_0.name}-${skill_0.source}`}><Text>{getSkillListLabel(skill_0)}</Text><Text dimColor={true}>{pluginName ? ` · ${pluginName}` : ""} · {tokenDisplay} description tokens</Text></FullWidthRow>;
}
function _temp2(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp(cmd) {
  return cmd.type === "prompt" && (cmd.loadedFrom === "skills" || cmd.loadedFrom === "commands_DEPRECATED" || cmd.loadedFrom === "plugin" || cmd.loadedFrom === "mcp");
}
