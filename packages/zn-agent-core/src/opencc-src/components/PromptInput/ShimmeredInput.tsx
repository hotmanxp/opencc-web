// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Ansi, Box, Text, useAnimationFrame } from '../../ink.js';
import { segmentTextByHighlights, type TextHighlight } from '../../utils/textHighlighting.js';
import { ShimmerChar } from '../Spinner/ShimmerChar.js';
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
