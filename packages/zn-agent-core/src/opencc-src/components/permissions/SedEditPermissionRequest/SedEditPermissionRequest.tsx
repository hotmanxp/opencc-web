// @ts-nocheck
import { isENOENT } from 'src/utils/errors.js';
import { type SedEditInfo } from '../../../tools/BashTool/sedEditParser.js'
import type { PermissionRequestProps } from '../PermissionRequest.js';
type SedEditPermissionRequestProps = PermissionRequestProps & {
  sedInfo: SedEditInfo;
};
type FileReadResult = {
  oldContent: string;
  fileExists: boolean;
};
export function SedEditPermissionRequest(t0) {
  return null;
}
function _temp(e) {
  if (!isENOENT(e)) {
    throw e;
  }
  return {
    oldContent: "",
    fileExists: false
  };
}
function SedEditPermissionRequestInner(t0) {
  return null;
}
