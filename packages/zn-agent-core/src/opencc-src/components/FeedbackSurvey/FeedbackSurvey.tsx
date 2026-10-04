// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { Box, Text } from '../../ink.js';
import { FeedbackSurveyView, isValidResponseInput } from './FeedbackSurveyView.js';
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js';
import { TranscriptSharePrompt } from './TranscriptSharePrompt.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
import type { FeedbackSurveyResponse } from './utils.js';
type Props = {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  lastResponse: FeedbackSurveyResponse | null;
  handleSelect: (selected: FeedbackSurveyResponse) => void;
  handleTranscriptSelect?: (selected: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  onRequestFeedback?: () => void;
  message?: string;
};
export function FeedbackSurvey(t0) {
  return null;
}
type ThanksProps = {
  lastResponse: FeedbackSurveyResponse | null;
  inputValue: string;
  setInputValue: (value: string) => void;
  onRequestFeedback?: () => void;
};
const isFollowUpDigit = (char: string): char is '1' => char === '1';
function FeedbackSurveyThanks(t0) {
  return null;
}
