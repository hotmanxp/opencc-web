import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { Tools } from '../../Tool.js';
import { type AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
type Props = {
  agent: AgentDefinition;
  tools: Tools;
  onSaved: (message: string) => void;
  onBack: () => void;
};
export function AgentEditor({
  agent,
  tools,
  onSaved,
  onBack
}: Props): React.ReactNode | null {
  return null;
}
