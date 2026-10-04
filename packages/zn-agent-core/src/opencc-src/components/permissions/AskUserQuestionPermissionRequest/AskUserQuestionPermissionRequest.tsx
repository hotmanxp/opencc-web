// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import React, { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../../../hooks/useSettings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { Box, Text, useTheme, useInput } from '../../../ink.js';
import { useKeybindings } from '../../../keybindings/useKeybinding.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question, QuestionOption } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { AskUserQuestionTool } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js';
import type { PastedContent } from '../../../utils/config.js';
import type { ImageDimensions } from '../../../utils/imageResizer.js';
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js';
import { logError } from '../../../utils/log.js';
import { computeAutoContinueAnswers } from '../../../utils/autoContinueQuestion.js';
import { applyMarkdown } from '../../../utils/markdown.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { getPlanFilePath } from '../../../utils/plans.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { QuestionView } from './QuestionView.js';
import { SubmitQuestionsView } from './SubmitQuestionsView.js';
import { useMultipleChoiceState } from './use-multiple-choice-state.js';
const MIN_CONTENT_HEIGHT = 12;
const MIN_CONTENT_WIDTH = 40;
// Lines used by chrome around the content area (nav bar, title, footer, help text, etc.)
const CONTENT_CHROME_OVERHEAD = 15;
export function AskUserQuestionPermissionRequest(props: PermissionRequestProps) {
  return null;
}
function AskUserQuestionWithHighlight(props: PermissionRequestProps) {
  return null;
}
function AskUserQuestionPermissionRequestBody(t0: PermissionRequestProps & { highlight: CliHighlight | null }) {
  return null;
}
function _temp6(c_1: PastedContent) {
  return c_1.type === "image";
}
function _temp5(c_0: PastedContent) {
  return c_0.type === "image";
}
function _temp4(s: { toolPermissionContext: { mode: string } }) {
  return s.toolPermissionContext.mode;
}
function _temp3(c: PastedContent) {
  return c.type === "image";
}
function _temp2(contents: Record<string, Record<number, PastedContent>>) {
  return Object.values(contents);
}
function _temp(opt: QuestionOption) {
  return opt.preview;
}
async function convertImagesToBlocks(images: PastedContent[]): Promise<ImageBlockParam[] | undefined> {
  if (images.length === 0) return undefined;
  return Promise.all(images.map(async img => {
    const block: ImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: (img.mediaType || 'image/png') as Base64ImageSource['media_type'],
        data: img.content
      }
    };
    const resized = await maybeResizeAndDownsampleImageBlock(block);
    return resized.block;
  }));
}
