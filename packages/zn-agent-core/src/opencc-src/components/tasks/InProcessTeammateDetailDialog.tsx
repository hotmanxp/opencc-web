// @ts-nocheck
import React, { useMemo } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
type Props = {
  teammate: DeepImmutable<InProcessTeammateTaskState>;
  onDone: () => void;
  onKill?: () => void;
  onBack?: () => void;
  onForeground?: () => void;
};
export function InProcessTeammateDetailDialog(t0) {
  return null;
}
