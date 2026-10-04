// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import { Box, Text, useInput } from '../../../ink.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question, QuestionOption } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import type { PastedContent } from '../../../utils/config.js';
import { getExternalEditor } from '../../../utils/editor.js';
import { toIDEDisplayName } from '../../../utils/ide.js';
import type { ImageDimensions } from '../../../utils/imageResizer.js';
import { editPromptInEditor } from '../../../utils/promptEditor.js';
import { type OptionWithDescription, Select, SelectMulti } from '../../CustomSelect/index.js';
import { Divider } from '../../design-system/Divider.js';
import { FilePathLink } from '../../FilePathLink.js';
import { PermissionRequestTitle } from '../PermissionRequestTitle.js';
import { PreviewQuestionView } from './PreviewQuestionView.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
import type { QuestionState } from './use-multiple-choice-state.js';
type Props = {
  question: Question;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  questionStates: Record<string, QuestionState>;
  hideSubmitTab?: boolean;
  planFilePath?: string;
  pastedContents?: Record<number, PastedContent>;
  minContentHeight?: number;
  minContentWidth?: number;
  onUpdateQuestionState: (questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean) => void;
  onAnswer: (questionText: string, label: string | string[], textInput?: string, shouldAdvance?: boolean) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
  onImagePaste?: (base64Image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void;
  onRemoveImage?: (id: number) => void;
};
export function QuestionView(t0: Props) {
  return null;
}
function _temp4(v) {
  return v !== "__other__";
}
function _temp3(opt_0) {
  return opt_0.preview;
}
function _temp2(opt) {
  return {
    type: "text" as const,
    value: opt.label,
    label: opt.label,
    description: opt.description
  };
}
function _temp(s) {
  return s.toolPermissionContext.mode;
}
