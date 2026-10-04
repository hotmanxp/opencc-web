// @ts-nocheck
import { type OutputStyleConfig } from '../constants/outputStyles.js'
import type { OutputStyle } from '../utils/config.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
const DEFAULT_OUTPUT_STYLE_LABEL = 'Default';
const DEFAULT_OUTPUT_STYLE_DESCRIPTION = 'OpenCC completes coding tasks efficiently and provides concise responses';
function mapConfigsToOptions(styles: {
  [styleName: string]: OutputStyleConfig | null;
}): OptionWithDescription[] {
  return Object.entries(styles).map(([style, config]) => ({
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    value: style,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION
  }));
}
export type OutputStylePickerProps = {
  initialStyle: OutputStyle;
  onComplete: (style: OutputStyle) => void;
  onCancel: () => void;
  isStandaloneCommand?: boolean;
};
export function OutputStylePicker(t0) {
  return null;
}
