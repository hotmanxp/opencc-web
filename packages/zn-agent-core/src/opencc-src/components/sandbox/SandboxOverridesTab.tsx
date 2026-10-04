// @ts-nocheck
import React from 'react';
import type { CommandResultDisplay } from '../../types/command.js';
type Props = {
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type OverrideMode = 'open' | 'closed';
export function SandboxOverridesTab(t0) {
  return null;
}

// Split so useTabHeaderFocus() only runs when the Select renders. Calling it
// above the early returns registers a down-arrow opt-in even when we return
// static text — pressing ↓ then blurs the header with no way back.
function OverridesSelect(t0) {
  return null;
}
