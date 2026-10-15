import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
const MAX_RENDERED_LINES = 10;
type Props = {
  result: ToolResultBlockParam['content'];
  verbose: boolean;
};
export function FallbackToolUseErrorMessage(t0) {
  return null;
}
