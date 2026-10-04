// @ts-nocheck
import React, { useMemo } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
type Props = {
  agent: DeepImmutable<LocalAgentTaskState>;
  onDone: () => void;
  onKillAgent?: () => void;
  onBack?: () => void;
};
export function AsyncAgentDetailDialog(t0) {
  return null;
}
