// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React, { useMemo } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { Box, Text } from '../../../ink.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { truncateToWidth } from '../../../utils/format.js';
type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  hideSubmitTab?: boolean;
};
export function QuestionNavigationBar(t0: Props) {
  return null;
}
function _temp3(sum: number, w: number) {
  return sum + w;
}
function _temp2(header_0: string) {
  return 4 + stringWidth(header_0);
}
function _temp(q_0: Question | undefined, index_0: number) {
  return q_0?.header || `Q${index_0 + 1}`;
}
