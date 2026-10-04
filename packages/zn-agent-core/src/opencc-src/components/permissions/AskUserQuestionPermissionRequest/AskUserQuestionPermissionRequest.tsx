// @ts-nocheck
import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { QuestionOption } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { type CliHighlight } from '../../../utils/cliHighlight.js'
import type { PastedContent } from '../../../utils/config.js';
import { maybeResizeAndDownsampleImageBlock } from '../../../utils/imageResizer.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
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
