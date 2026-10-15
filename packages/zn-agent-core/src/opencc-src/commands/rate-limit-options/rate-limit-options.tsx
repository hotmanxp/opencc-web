import React, { useMemo, useState } from 'react';
import type { LocalJSXCommandContext } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
function RateLimitOptionsMenu(t0) {
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} context={context} />;
}
