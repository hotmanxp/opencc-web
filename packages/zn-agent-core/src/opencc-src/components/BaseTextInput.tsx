// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { renderPlaceholder } from '../hooks/renderPlaceholder.js';
import { usePasteHandler } from '../hooks/usePasteHandler.js';
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js';
import { Ansi, Box, Text, useInput } from '../ink.js';
import type { BaseInputState, BaseTextInputProps } from '../types/textInputTypes.js';
import type { TextHighlight } from '../utils/textHighlighting.js';
import { HighlightedInput } from './PromptInput/ShimmeredInput.js';
type BaseTextInputComponentProps = BaseTextInputProps & {
  inputState: BaseInputState;
  children?: React.ReactNode;
  terminalFocus: boolean;
  highlights?: TextHighlight[];
  invert?: (text: string) => string;
  hidePlaceholderText?: boolean;
};

/**
 * A base component for text inputs that handles rendering and basic input
 */
export function BaseTextInput(t0) {
  return null;
}
