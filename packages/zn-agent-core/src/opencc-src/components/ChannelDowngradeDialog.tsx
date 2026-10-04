// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { Text } from '../ink.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel';
type Props = {
  currentVersion: string;
  onChoice: (choice: ChannelDowngradeChoice) => void;
};

/**
 * Dialog shown when switching from latest to stable channel.
 * Allows user to choose whether to downgrade or stay on current version.
 */
export function ChannelDowngradeDialog(t0: Props) {
  return null;
}
