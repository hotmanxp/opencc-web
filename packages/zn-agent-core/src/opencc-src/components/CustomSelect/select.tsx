// @ts-nocheck
import figures from 'figures';
import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import type { PastedContent } from '../../utils/config.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';

// Extract text content from ReactNode for width calculation
function getTextContent(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (React.isValidElement<{
    children?: ReactNode;
  }>(node)) {
    return getTextContent(node.props.children);
  }
  return '';
}
type BaseOption<T> = {
  description?: string;
  dimDescription?: boolean;
  label: ReactNode;
  value: T;
  disabled?: boolean;
};
export type OptionWithDescription<T = string> = (BaseOption<T> & {
  type?: 'text';
}) | (BaseOption<T> & {
  type: 'input';
  onChange: (value: string) => void;
  placeholder?: string;
  initialValue?: string;
  /**
   * Controls behavior when submitting with empty input:
   * - true: calls onChange (treats empty as valid submission)
   * - false (default): calls onCancel (treats empty as cancellation)
   *
   * Also affects initial Enter press: when true, submits immediately;
   * when false, enters input mode first so user can type.
   */
  allowEmptySubmitToCancel?: boolean;
  /**
   * When true, always shows the label alongside the input value, regardless of
   * the global inlineDescriptions/showLabel setting. Use this when the label
   * provides important context that should always be visible (e.g., "Yes, and allow...").
   */
  showLabelWithValue?: boolean;
  /**
   * Custom separator between label and value when showLabel is true.
   * Defaults to ", ". Use ": " for labels that read better with a colon.
   */
  labelValueSeparator?: string;
  /**
   * When true, automatically reset cursor to end of line when:
   * - Option becomes focused
   * - Input value changes
   * This prevents cursor position bugs when the input value updates asynchronously.
   */
  resetCursorOnUpdate?: boolean;
});
export type SelectProps<T> = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  readonly isDisabled?: boolean;

  /**
   * When true, prevents selection on Enter but allows scrolling.
   *
   * @default false
   */
  readonly disableSelection?: boolean;

  /**
   * When true, hides the numeric indexes next to each option.
   *
   * @default false
   */
  readonly hideIndexes?: boolean;

  /**
   * Number of visible options.
   *
   * @default 5
   */
  readonly visibleOptionCount?: number;

  /**
   * Highlight text in option labels.
   */
  readonly highlightText?: string;

  /**
   * Options.
   */
  readonly options: OptionWithDescription<T>[];

  /**
   * Default value.
   */
  readonly defaultValue?: T;

  /**
   * Callback when cancel is pressed.
   */
  readonly onCancel?: () => void;

  /**
   * Callback when selected option changes.
   */
  readonly onChange?: (value: T) => void;

  /**
   * Callback when focused option changes.
   * Note: This is for one-way notification only. Avoid combining with focusValue
   * for bidirectional sync, as this can cause feedback loops.
   */
  readonly onFocus?: (value: T) => void;

  /**
   * Initial value to focus. This is used to set focus when the component mounts.
   */
  readonly defaultFocusValue?: T;

  /**
   * Layout of the options.
   * - `compact` (default) tries to use one line per option
   * - `expanded` uses multiple lines and an empty line between options
   * - `compact-vertical` uses compact index formatting with descriptions below labels
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * When true, descriptions are rendered inline after the label instead of
   * in a separate column. Use this for short descriptions like hints.
   *
   * @default false
   */
  readonly inlineDescriptions?: boolean;

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void;

  /**
   * Callback when user presses down from the last item.
   * If provided, navigation will not wrap to the first item.
   */
  readonly onDownFromLastItem?: () => void;

  /**
   * Callback when input mode should be toggled for an option.
   * Called when Tab is pressed (to enter or exit input mode).
   */
  readonly onInputModeToggle?: (value: T) => void;

  /**
   * Callback when an input option is submitted while empty.
   * If omitted, empty input submission falls back to onCancel.
   */
  readonly onEmptyInputSubmit?: (value: T) => void;

  /**
   * Callback to open external editor for editing input option values.
   * When provided, ctrl+g will trigger this callback in input options
   * with the current value and a setter function to update the internal state.
   */
  readonly onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;

  /**
   * Optional callback when an image is pasted into an input option.
   */
  readonly onImagePaste?: (base64Image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void;

  /**
   * Pasted content to display inline in input options.
   */
  readonly pastedContents?: Record<number, PastedContent>;

  /**
   * Callback to remove a pasted image by its ID.
   */
  readonly onRemoveImage?: (id: number) => void;
};
export function Select(t0) {
  return null;
}

// Row container for the two-column (label + description) layout. Unlike
// the other Select layouts, this one doesn't render through SelectOption →
// ListItem, so it declares the native cursor directly. Parks the cursor
// on the pointer indicator so screen readers / magnifiers track focus.
function _temp9(c_3) {
  return c_3.type === "image";
}
function _temp8(opt_0) {
  return opt_0.description;
}
function _temp7(opt) {
  return opt.type === "input";
}
function _temp6(c_2) {
  return c_2.type === "image";
}
function _temp5(c_1) {
  return c_1.type === "image";
}
function _temp4() {
  return {
    bold: true
  };
}
function _temp3() {
  return {
    flexDirection: "column" as const
  };
}
function _temp2(c) {
  return c.type === "image";
}
function _temp(c_0) {
  return c_0.type === "image";
}
function TwoColumnRow(t0) {
  return null;
}
