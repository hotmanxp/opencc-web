// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import type { ChannelEntry } from '../bootstrap/state.js';
import { Box, Text } from '../ink.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  channels: ChannelEntry[];
  onAccept(): void;
};
export function DevChannelsDialog(t0: Props) {
  return null;
}
function _temp2(c: ChannelEntry) {
  return c.kind === "plugin" ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`;
}
function _temp() {
  gracefulShutdownSync(0);
}
