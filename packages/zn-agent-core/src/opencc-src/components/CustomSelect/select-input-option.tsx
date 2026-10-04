// @ts-nocheck
import React, { type ReactNode, useEffect, useRef, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- UP arrow exit not in Attachments bindings
import type { PastedContent } from '../../utils/config.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';
import TextInput from '../TextInput.js';
import type { OptionWithDescription } from './select.js';
type Props<T> = {
  option: Extract<OptionWithDescription<T>, {
    type: 'input';
  }>;
  isFocused: boolean;
  isSelected: boolean;
  shouldShowDownArrow: boolean;
  shouldShowUpArrow: boolean;
  maxIndexWidth: number;
  index: number;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onExit?: () => void;
  layout: 'compact' | 'expanded';
  children?: ReactNode;
  /**
   * When true, shows the label before the input field.
   * When false (default), uses the label as the placeholder.
   */
  showLabel?: boolean;
  /**
   * Callback to open external editor for editing the input value.
   * When provided, ctrl+g will trigger this callback with the current value
   * and a setter function to update the internal state.
   */
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;
  /**
   * When true, automatically reset cursor to end of line when:
   * - Option becomes focused
   * - Input value changes
   * This prevents cursor position bugs when the input value updates asynchronously.
   */
  resetCursorOnUpdate?: boolean;
  /**
   * Optional callback when an image is pasted into the input.
   */
  onImagePaste?: (base64Image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void;
  /**
   * Pasted content to display inline above the input when focused.
   */
  pastedContents?: Record<number, PastedContent>;
  /**
   * Callback to remove a pasted image by its ID.
   */
  onRemoveImage?: (id: number) => void;
  /**
   * Whether image selection mode is active.
   */
  imagesSelected?: boolean;
  /**
   * Currently selected image index within the image attachments array.
   */
  selectedImageIndex?: number;
  /**
   * Callback to set image selection mode on/off.
   */
  onImagesSelectedChange?: (selected: boolean) => void;
  /**
   * Callback to change the selected image index.
   */
  onSelectedImageIndexChange?: (index: number) => void;
};
export function SelectInputOption(t0) {
  return null;
}
function _temp(c) {
  return c.type === "image";
}
