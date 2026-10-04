// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { Text } from '../../ink.js';
import type { Theme } from '../../utils/theme.js';
type Props = {
  /**
   * How much progress to display, between 0 and 1 inclusive
   */
  ratio: number; // [0, 1]

  /**
   * How many characters wide to draw the progress bar
   */
  width: number; // how many characters wide

  /**
   * Optional color for the filled portion of the bar
   */
  fillColor?: keyof Theme;

  /**
   * Optional color for the empty portion of the bar
   */
  emptyColor?: keyof Theme;
};
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
export function ProgressBar(t0) {
  return null;
}
