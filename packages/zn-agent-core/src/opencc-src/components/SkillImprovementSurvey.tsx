// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useRef } from 'react';
import { BLACK_CIRCLE, BULLET_OPERATOR } from '../constants/figures.js';
import { Box, Text } from '../ink.js';
import type { SkillUpdate } from '../utils/hooks/skillImprovement.js';
import { normalizeFullWidthDigits } from '../utils/stringUtils.js';
import { isValidResponseInput } from './FeedbackSurvey/FeedbackSurveyView.js';
import type { FeedbackSurveyResponse } from './FeedbackSurvey/utils.js';
type Props = {
  isOpen: boolean;
  skillName: string;
  updates: SkillUpdate[];
  handleSelect: (selected: FeedbackSurveyResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};
export function SkillImprovementSurvey(t0) {
  return null;
}
type ViewProps = {
  skillName: string;
  updates: SkillUpdate[];
  onSelect: (option: FeedbackSurveyResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};

// Only 1 (apply) and 0 (dismiss) are valid for this survey
const VALID_INPUTS = ['0', '1'] as const;
function isValidInput(input: string): boolean {
  return (VALID_INPUTS as readonly string[]).includes(input);
}
function SkillImprovementSurveyView(t0) {
  return null;
}
function _temp(u, i) {
  return <Text key={i} dimColor={true}>{BULLET_OPERATOR} {u.change}</Text>;
}
