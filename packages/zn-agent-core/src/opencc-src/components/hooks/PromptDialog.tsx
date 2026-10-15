import type { PromptRequest } from '../../types/hooks.js';
type Props = {
  title: string;
  toolInputSummary?: string | null;
  request: PromptRequest;
  onRespond: (key: string) => void;
  onAbort: () => void;
};
export function PromptDialog(t0) {
  return null;
}
function _temp(opt) {
  return {
    label: opt.label,
    value: opt.key,
    description: opt.description
  };
}
