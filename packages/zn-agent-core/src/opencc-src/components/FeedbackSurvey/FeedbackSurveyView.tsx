import type { FeedbackSurveyResponse } from './utils.js';
type Props = {
  onSelect: (option: FeedbackSurveyResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  message?: string;
};
const RESPONSE_INPUTS = ['0', '1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];
const inputToResponse: Record<ResponseInput, FeedbackSurveyResponse> = {
  '0': 'dismissed',
  '1': 'bad',
  '2': 'fine',
  '3': 'good'
} as const;
export const isValidResponseInput = (input: string): input is ResponseInput => (RESPONSE_INPUTS as readonly string[]).includes(input);
const DEFAULT_MESSAGE = 'How is OpenCC doing this session? (optional)';
export function FeedbackSurveyView(t0) {
  return null;
}
