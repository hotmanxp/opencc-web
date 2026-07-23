// @ts-nocheck
// Minimal zai port of opencc/src/utils/imageResizer.ts.
//
// zai does not bundle `sharp`, so the heavyweight sharp-based resize pipeline
// from opencc is replaced with a size-guard passthrough that matches the
// catch-block fallback inside opencc's own imageResizer.ts:
//   - detect media type from magic bytes
//   - if base64-encoded size is within API_IMAGE_MAX_BASE64_SIZE, pass through
//   - otherwise throw ImageResizeError with the user-facing message opencc uses
//
// This keeps every importer happy (`query.ts`, `services/api/errors.ts`,
// `services/mcp/client.ts`, `utils/attachments.ts`, `utils/config.ts`,
// `types/textInputTypes.ts`) without dragging in sharp + imageProcessor.

import type {
  Base64ImageSource,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/apiLimits.js'
import { formatFileSize } from './format.js'

/**
 * Error thrown when image resizing fails and the image exceeds the API limit.
 *
 * Matched via `instanceof` in `query.ts` and `services/api/errors.ts` to
 * surface a user-friendly message instead of the raw model error.
 */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

export type ImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'

export interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

export interface ImageBlockWithDimensions {
  block: ImageBlockParam
  dimensions?: ImageDimensions
}

/**
 * Detect image format from a buffer using magic bytes.
 * Mirrors opencc's detectImageFormatFromBuffer so MCP image inputs keep the
 * same media-type behaviour even when sharp is unavailable.
 */
export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return 'image/png'
  // PNG signature: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  // JPEG signature: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF signature: "GIF"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }
  // WebP signature: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/png'
}

/**
 * Passthrough resize: sharp is unavailable in zai, so we cannot actually
 * downsample. Instead we validate the base64-encoded size against the
 * Anthropic API limit and either return the buffer unchanged or throw the
 * same `ImageResizeError` opencc would throw in this branch.
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    throw new ImageResizeError('Image file is empty (0 bytes)')
  }

  const detected = detectImageFormatFromBuffer(imageBuffer)
  // Strip "image/" prefix to match opencc's normalizeMediaType.
  const normalizedExt = detected.slice(6)
  const base64Size = Math.ceil((originalSize * 4) / 3)

  if (base64Size > API_IMAGE_MAX_BASE64_SIZE) {
    throw new ImageResizeError(
      `Unable to resize image (${formatFileSize(originalSize)} raw, ${formatFileSize(base64Size)} base64). ` +
        `The image exceeds the 5MB API limit. ` +
        `zai does not bundle an image processor, so please resize the image manually ` +
        `or use a smaller image.`,
    )
  }

  // Within API limits — pass through. `ext` and normalizedExt agree in
  // practice; prefer the detected magic-byte format for consistency.
  const mediaType = normalizedExt === 'jpg' ? 'jpeg' : normalizedExt || ext
  return {
    buffer: imageBuffer,
    mediaType,
  }
}

/**
 * Resizes (i.e. base64-size-validates) a base64 ImageBlockParam.
 */
export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
): Promise<ImageBlockWithDimensions> {
  if (imageBlock.source.type !== 'base64') {
    return { block: imageBlock }
  }
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')
  const originalSize = imageBuffer.length
  const mediaType = imageBlock.source.media_type
  const ext = mediaType?.split('/')[1] || 'png'

  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    ext,
  )

  return {
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type:
          `image/${resized.mediaType}` as Base64ImageSource['media_type'],
        data: resized.buffer.toString('base64'),
      },
    },
    dimensions: resized.dimensions,
  }
}
