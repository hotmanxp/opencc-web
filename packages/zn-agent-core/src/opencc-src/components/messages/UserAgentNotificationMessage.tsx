// @ts-nocheck
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { type TextProps } from '../../ink.js'
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};
function getStatusColor(status: string | null): TextProps['color'] {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'killed':
      return 'warning';
    default:
      return 'text';
  }
}
export function UserAgentNotificationMessage(t0) {
  return null;
}
