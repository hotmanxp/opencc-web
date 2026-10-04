// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getAllOutputStyles, OUTPUT_STYLE_CONFIG, type OutputStyleConfig } from '../constants/outputStyles.js';
import { Box, Text } from '../ink.js';
import type { OutputStyle } from '../utils/config.js';
import { getCwd } from '../utils/cwd.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
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
