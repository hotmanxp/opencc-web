// @ts-nocheck
import type { IDESelection } from '../hooks/useIdeSelection.js';

export function hasIdeSelection(ideSelection: IDESelection | undefined): boolean {
  return Boolean(ideSelection?.filePath || (ideSelection?.text && ideSelection.lineCount > 0));
}

export function IdeStatusIndicator(t0) {
  return null;
}
