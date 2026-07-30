import React from 'react';
import { Box, Text } from '../../ink.js';
import type { Tools } from '../../Tool.js';
import { findToolByName } from '../../Tool.js';
import type { ToolActivity } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import type { ThemeName } from '../../utils/theme.js';
import { WORKFLOW_TOOL_NAME } from '../../tools/WorkflowTool/constants.js';

/** Tool name keys the Workflow fire-and-forget dispatch. The
 *  human-facing name from `userFacingName()` is 'Run Workflow', but
 *  the underlying toolName is 'WorkflowTool' (the constant). We
 *  also accept 'Workflow' as a back-compat alias — some early call
 *  sites used the unprefixed form. */
const WORKFLOW_TOOL_ALIAS = 'Workflow' as const;

export function renderToolActivity(activity: ToolActivity, tools: Tools, theme: ThemeName): React.ReactNode {
  // I0K port: dedicated branch for the Workflow tool. The tool is
  // fire-and-forget — it returns a taskId immediately and the
  // workflow runs in a Worker thread. The default renderToolActivity
  // path would just show the tool args ("Run Workflow(workflowName:
  // deep-research)") which doesn't tell the user the workflow is
  // running and how to monitor it. Upstream's I0K wraps the tool
  // result with a "/workflows to monitor progress" hint; we mirror
  // that shape here so the activity panel makes the
  // fire-and-forget nature visible.
  if (
    activity.toolName === WORKFLOW_TOOL_NAME ||
    activity.toolName === WORKFLOW_TOOL_ALIAS
  ) {
    const input = activity.input as { workflowName?: string; scriptPath?: string } | undefined
    const label = input?.scriptPath
      ? `Run ad-hoc workflow: ${input.scriptPath}`
      : input?.workflowName
        ? `Run workflow: ${input.workflowName}`
        : 'Run workflow'
    return (
      <Box>
        <Text>{label}</Text>
        <Text dimColor>{' — '}</Text>
        <Text dimColor>
          Run /workflows to monitor progress; completion arrives as a
          system task-notification.
        </Text>
      </Box>
    )
  }

  const tool = findToolByName(tools, activity.toolName);
  if (!tool) {
    return activity.toolName;
  }
  try {
    const parsed = tool.inputSchema.safeParse(activity.input);
    const parsedInput = parsed.success ? parsed.data : {};
    const userFacingName = tool.userFacingName(parsedInput);
    if (!userFacingName) {
      return activity.toolName;
    }
    const toolArgs = tool.renderToolUseMessage(parsedInput, {
      theme,
      verbose: false
    });
    if (toolArgs) {
      return <Text>
          {userFacingName}({toolArgs})
        </Text>;
    }
    return userFacingName;
  } catch {
    return activity.toolName;
  }
}
