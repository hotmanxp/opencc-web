import { logEvent } from 'src/services/analytics/index.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
type Props = {
  onAccept(): void;
};
export function BypassPermissionsModeDialog(t0: Props) {
  return null;
}
function _temp2() {
  gracefulShutdownSync(0);
}
function _temp() {
  logEvent("tengu_bypass_permissions_mode_dialog_shown", {});
}
