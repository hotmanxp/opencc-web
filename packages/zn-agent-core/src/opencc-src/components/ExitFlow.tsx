// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import sample from 'lodash-es/sample.js';
import React from 'react';
import { gracefulShutdown } from '../utils/gracefulShutdown.js';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';
const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!'];
function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!';
}
type Props = {
  onDone: (message?: string) => void;
  onCancel?: () => void;
  showWorktree: boolean;
};
export function ExitFlow(t0) {
  return null;
}
