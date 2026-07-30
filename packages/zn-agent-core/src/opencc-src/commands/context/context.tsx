import * as React from 'react';
import { feature } from 'bun:bundle';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { microcompactMessages } from '../../services/compact/microCompact.js';
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js';
import { formatTokens } from '../../utils/format.js';
import { getSourceDisplayName } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';

function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      projectView
    } = require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view);
  }
  return view;
}

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const { messages, getAppState, options: { mainLoopModel, tools } } = context;
  const apiView = toApiView(messages);
  const { messages: compactedMessages } = await microcompactMessages(apiView);
  const appState = getAppState();

  const data = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    undefined,
    context,
    undefined,
    apiView
  );

  const output = formatContextAsMarkdownTable(data);
  onDone(output);
  return null;
}

function formatContextAsMarkdownTable(data: ContextData): string {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    model,
    memoryFiles,
    mcpTools,
    agents,
    skills,
    messageBreakdown,
    systemTools,
    systemPromptSections,
  } = data;

  let output = `## Context Usage\n\n`;
  output += `**Model:** ${model}  \n`;
  output += `**Tokens:** ${formatTokens(totalTokens)} / ${formatTokens(rawMaxTokens)} (${percentage}%)\n`;

  // Context-collapse status
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getStats, isContextCollapseEnabled } =
      require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      const s = getStats();
      const { health: h } = s;

      const parts: string[] = [];
      if (s.collapsedSpans > 0) {
        parts.push(
          `${s.collapsedSpans} ${plural(s.collapsedSpans, 'span')} summarized (${s.collapsedMessages} messages)`,
        );
      }
      if (s.stagedSpans > 0) parts.push(`${s.stagedSpans} staged`);
      const summary =
        parts.length > 0
          ? parts.join(', ')
          : h.totalSpawns > 0
            ? `${h.totalSpawns} ${plural(h.totalSpawns, 'spawn')}, nothing staged yet`
            : 'waiting for first trigger';
      output += `**Context strategy:** collapse (${summary})\n`;

      if (h.totalErrors > 0) {
        output += `**Collapse errors:** ${h.totalErrors}/${h.totalSpawns} spawns failed`;
        if (h.lastError != null) {
          output += ` (last: ${h.lastError!.slice(0, 80)})`;
        }
        output += '\n';
      } else if (h.emptySpawnWarningEmitted) {
        output += `**Collapse idle:** ${h.totalEmptySpawns} consecutive empty runs\n`;
      }
    }
  }
  output += '\n';

  // Main categories table
  const visibleCategories = categories.filter(
    cat =>
      cat.tokens > 0 &&
      cat.name !== 'Free space' &&
      cat.name !== 'Autocompact buffer',
  );

  if (visibleCategories.length > 0) {
    output += `### Estimated usage by category\n\n`;
    output += `| Category | Tokens | Percentage |\n`;
    output += `|----------|--------|------------|\n`;

    for (const cat of visibleCategories) {
      const percentDisplay = ((cat.tokens / rawMaxTokens) * 100).toFixed(1);
      output += `| ${cat.name} | ${formatTokens(cat.tokens)} | ${percentDisplay}% |\n`;
    }

    const freeSpaceCategory = categories.find(c => c.name === 'Free space');
    if (freeSpaceCategory && freeSpaceCategory.tokens > 0) {
      const percentDisplay = (
        (freeSpaceCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1);
      output += `| Free space | ${formatTokens(freeSpaceCategory.tokens)} | ${percentDisplay}% |\n`;
    }

    const autocompactCategory = categories.find(
      c => c.name === 'Autocompact buffer',
    );
    if (autocompactCategory && autocompactCategory.tokens > 0) {
      const percentDisplay = (
        (autocompactCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1);
      output += `| Autocompact buffer | ${formatTokens(autocompactCategory.tokens)} | ${percentDisplay}% |\n`;
    }

    output += `\n`;
  }

  // MCP tools
  if (mcpTools.length > 0) {
    output += `### MCP Tools\n\n`;
    output += `| Tool | Tokens |\n`;
    output += `|------|--------|\n`;
    for (const tool of mcpTools) {
      output += `| ${tool.name} | ${formatTokens(tool.tokens)} |\n`;
    }
    output += `\n`;
  }

  // Custom agents
  if (agents.length > 0) {
    output += `### Custom Agents\n\n`;
    output += `| Agent Type | Source | Tokens |\n`;
    output += `|------------|--------|--------|\n`;
    for (const agent of agents) {
      output += `| ${agent.agentType} | ${getSourceDisplayName(agent.source)} | ${formatTokens(agent.tokens)} |\n`;
    }
    output += `\n`;
  }

  // Memory files
  if (memoryFiles.length > 0) {
    output += `### Memory Files\n\n`;
    output += `| Type | Path | Tokens |\n`;
    output += `|------|------|--------|\n`;
    for (const file of memoryFiles) {
      output += `| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |\n`;
    }
    output += `\n`;
  }

  // Skills
  if (skills && skills.tokens > 0 && skills.skillFrontmatter.length > 0) {
    output += `### Skills\n\n`;
    output += `| Skill | Source | Tokens |\n`;
    output += `|-------|--------|--------|\n`;
    for (const skill of skills.skillFrontmatter) {
      output += `| ${skill.name} | ${getSourceDisplayName(skill.source)} | ${formatTokens(skill.tokens)} |\n`;
    }
    output += `\n`;
  }

  return output;
}
