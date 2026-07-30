import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { WorkflowsListDialog } from '../../components/tasks/WorkflowsListDialog.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsListDialog onDone={onDone} toolUseContext={context} />;
}
