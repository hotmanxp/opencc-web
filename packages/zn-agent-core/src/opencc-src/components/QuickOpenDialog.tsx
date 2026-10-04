import * as path from 'path';
type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};
const VISIBLE_RESULTS = 8;
const PREVIEW_LINES = 20;

/**
 * Quick Open dialog (ctrl+shift+p / cmd+shift+p).
 * Fuzzy file finder with a syntax-highlighted preview of the focused file.
 */
export function QuickOpenDialog(t0) {
  return null;
}
function _temp6(q_0) {
  return q_0 ? "No matching files" : "Start typing to search\u2026";
}
function _temp5(p_3) {
  return p_3;
}
function _temp4(p_0) {
  return p_0.split(path.sep).join("/");
}
function _temp3(p) {
  return !p.endsWith(path.sep);
}
function _temp2(i_0) {
  return i_0.displayText;
}
function _temp(i) {
  return i.id.startsWith("file-");
}
