// @ts-nocheck
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
const MAX_API_ERROR_CHARS = 1000;
type Props = {
  param: TextBlockParam;
  addMargin: boolean;
  shouldShowDot: boolean;
  verbose: boolean;
  width?: number | string;
  onOpenRateLimitOptions?: () => void;
};
function InvalidApiKeyMessage() {
  return null;
}
export function AssistantTextMessage(t0) {
  return null;
}
