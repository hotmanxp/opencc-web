// @ts-nocheck
import { getGlobalConfig } from '../utils/config.js'
import { isSupportedTerminal } from '../utils/ide.js';
type IdeAutoConnectDialogProps = {
  onComplete: () => void;
};
export function IdeAutoConnectDialog(t0) {
  return null;
}
export function shouldShowAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde !== true && config.hasIdeAutoConnectDialogBeenShown !== true;
}
type IdeDisableAutoConnectDialogProps = {
  onComplete: (disableAutoConnect: boolean) => void;
};
export function IdeDisableAutoConnectDialog(t0) {
  return null;
}
function _temp(current) {
  return {
    ...current,
    autoConnectIde: false
  };
}
export function shouldShowDisableAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde === true;
}
