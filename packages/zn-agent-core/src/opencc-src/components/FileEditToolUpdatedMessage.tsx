import type { StructuredPatchHunk } from 'diff';
import { count } from '../utils/array.js';
type Props = {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  style?: 'condensed';
  verbose: boolean;
  previewHint?: string;
};
export function FileEditToolUpdatedMessage(t0) {
  return null;
}
function _temp4(acc_0, hunk_0) {
  return acc_0 + count(hunk_0.lines, _temp3);
}
function _temp3(__0) {
  return __0.startsWith("-");
}
function _temp2(acc, hunk) {
  return acc + count(hunk.lines, _temp);
}
function _temp(_) {
  return _.startsWith("+");
}
