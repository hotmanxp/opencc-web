// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React from 'react';
import { Box, Text } from '../../../ink.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js';
import { Select } from '../../CustomSelect/index.js';
import { Divider } from '../../design-system/Divider.js';
import { PermissionRequestTitle } from '../PermissionRequestTitle.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  allQuestionsAnswered: boolean;
  permissionResult: PermissionDecision;
  minContentHeight?: number;
  onFinalResponse: (value: 'submit' | 'cancel') => void;
};
export function SubmitQuestionsView(t0: Props) {
  return null;
}
