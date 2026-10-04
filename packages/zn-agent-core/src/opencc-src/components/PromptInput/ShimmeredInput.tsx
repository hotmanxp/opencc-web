// @ts-nocheck
import { type TextHighlight } from '../../utils/textHighlighting.js'
type Props = {
  text: string;
  highlights: TextHighlight[];
};
type LinePart = {
  text: string;
  highlight: TextHighlight | undefined;
  start: number;
};
export function HighlightedInput(t0) {
  return null;
}
function _temp(h) {
  return h.shimmerColor;
}
