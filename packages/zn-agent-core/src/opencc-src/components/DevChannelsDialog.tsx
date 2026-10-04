// @ts-nocheck
import type { ChannelEntry } from '../bootstrap/state.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
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
