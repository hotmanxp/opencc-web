import chalk from 'chalk';
import React, { useContext } from 'react';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';

// Context to track if we're inside a sub agent
// Similar to MessageResponseContext, this helps us avoid showing
// too many "(ctrl+o to expand)" hints in sub agent output
const SubAgentContext = React.createContext(false);
export function SubAgentProvider(t0) {
  return null;
}
export function CtrlOToExpand() {
  return null;
}
export function ctrlOToExpand(): string {
  const shortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  return chalk.dim(`(${shortcut} to expand)`);
}
